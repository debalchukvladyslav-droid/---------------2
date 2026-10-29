begin;
create table data_recovery.storage_upload_reservations (
    bucket text not null,
    object_path text not null,
    user_id uuid not null,
    bytes bigint not null check(bytes>0 and bytes<=26214400),
    expires_at timestamptz not null,
    primary key(bucket,object_path)
);
alter table data_recovery.storage_upload_reservations enable row level security;
revoke all on data_recovery.storage_upload_reservations from public,anon,authenticated;
grant all on data_recovery.storage_upload_reservations to service_role;

create function public.reserve_storage_capacity(p_user_id uuid,p_bucket text,p_path text,p_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare stored bigint; reserved bigint; existing_bytes bigint; growth bigint; capacity bigint:=900000000;
begin
    if p_user_id is null or p_bucket not in ('screenshots','backgrounds','avatars','trade-charts','journal-exports','polygon-cache')
       or (p_bucket<>'polygon-cache' and split_part(p_path,'/',1)<>p_user_id::text) or p_path like '%..%'
       or coalesce(p_path,'')='' or p_path like '/%'
       or p_bytes is null or p_bytes<1 or p_bytes>26214400 then
        raise exception 'Invalid storage reservation' using errcode='22023';
    end if;
    -- Serialize capacity decisions across users and concurrent browser tabs.
    perform pg_advisory_xact_lock(1643228917,1);
    delete from data_recovery.storage_upload_reservations where expires_at<now();
    select coalesce(sum(coalesce((metadata->>'size')::bigint,0)),0) into stored from storage.objects;
    select coalesce(sum(greatest(r.bytes-coalesce((o.metadata->>'size')::bigint,0),0)),0) into reserved
        from data_recovery.storage_upload_reservations r left join storage.objects o on o.bucket_id=r.bucket and o.name=r.object_path
        where (r.bucket,r.object_path) is distinct from (p_bucket,p_path);
    select coalesce((metadata->>'size')::bigint,0) into existing_bytes from storage.objects where bucket_id=p_bucket and name=p_path;
    growth:=greatest(p_bytes-coalesce(existing_bytes,0),0);
    if growth>0 and stored+reserved+growth>capacity then
        return jsonb_build_object('allowed',false,'usedBytes',stored,'reservedBytes',reserved,'capacityBytes',capacity);
    end if;
    insert into data_recovery.storage_upload_reservations(bucket,object_path,user_id,bytes,expires_at)
    values(p_bucket,p_path,p_user_id,p_bytes,now()+interval '2 hours')
    on conflict(bucket,object_path) do update set bytes=excluded.bytes,expires_at=excluded.expires_at;
    return jsonb_build_object('allowed',true,'usedBytes',stored,'reservedBytes',reserved,'capacityBytes',capacity);
end $$;
revoke all on function public.reserve_storage_capacity(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.reserve_storage_capacity(uuid,text,text,bigint) to service_role;

-- Keep a margin below the 500 MB database quota. Failed writes stay in the
-- browser's durable queue. Reductions/deletions remain possible during cleanup.
create function data_recovery.guard_free_database_budget()
returns trigger language plpgsql set search_path='' as $$
begin
    if pg_database_size(current_database())>=475000000 then
        if tg_op='UPDATE' and pg_column_size(to_jsonb(new)-array['updated_at','sync_version','version'])
           <=pg_column_size(to_jsonb(old)-array['updated_at','sync_version','version']) then return new; end if;
        raise exception 'База майже заповнена. Правки залишаються на пристрої до звільнення місця адміністратором.' using errcode='PT507';
    end if;
    return new;
end $$;
revoke all on function data_recovery.guard_free_database_budget() from public,anon,authenticated;
create trigger zz_free_database_budget before insert or update on public.journal_days for each row execute function data_recovery.guard_free_database_budget();
create trigger zz_free_database_budget before insert or update on public.trades for each row execute function data_recovery.guard_free_database_budget();
create trigger zz_free_database_budget before insert or update on public.user_settings for each row execute function data_recovery.guard_free_database_budget();
create trigger zz_free_database_budget before insert or update on public.screenshots for each row execute function data_recovery.guard_free_database_budget();
notify pgrst, 'reload schema';
commit;
