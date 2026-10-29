begin;

-- Bytes stay in the already-authorized Drive folder. Only the durable manifest
-- is indexed here; a source job may never register a file for another owner.
create or replace function public.register_drive_screenshot_reference(p_connection_id uuid, p_epoch bigint, p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; s data_recovery.owner_state; r public.screenshots;
    file_id text := p_metadata->>'source_file_id'; path text;
begin
    select * into c from public.integration_connections where id=p_connection_id and enabled and kind='drive';
    if not found or file_id is null or file_id !~ '^[A-Za-z0-9_-]+$' then
        raise exception 'Invalid Drive source' using errcode='22023';
    end if;
    perform data_recovery.lock_owner(c.user_id);
    select * into s from data_recovery.owner_state where user_id=c.user_id;
    if p_epoch is null or p_epoch<>s.epoch then raise exception 'Stale source job epoch' using errcode='40001'; end if;
    if exists(select 1 from public.screenshots where user_id=c.user_id and source='drive' and source_file_id=file_id and deleted_at is not null) then
        return jsonb_build_object('skipped',true,'reason','deleted_on_site');
    end if;
    select * into r from public.screenshots where user_id=c.user_id and source='drive' and source_file_id=file_id
        and deleted_at is null order by created_at desc limit 1;
    path := coalesce(r.storage_path, 'screenshots/'||c.user_id::text||'/drive/'||file_id||'/reference');
    if exists(select 1 from data_recovery.file_retirements where user_id=c.user_id and storage_path=path) then
        return jsonb_build_object('skipped',true,'reason','deleted_on_site');
    end if;
    insert into public.screenshots as screenshot(user_id,storage_path,source,source_file_id,original_name,mime_type,byte_size,
        source_created_at,source_modified_at,pixel_width,pixel_height,upload_status,quality_details)
    values(c.user_id,path,'drive',file_id,p_metadata->>'original_name',p_metadata->>'mime_type',
        nullif(p_metadata->>'byte_size','')::bigint,nullif(p_metadata->>'source_created_at','')::timestamptz,
        nullif(p_metadata->>'source_modified_at','')::timestamptz,nullif(p_metadata->>'pixel_width','')::integer,
        nullif(p_metadata->>'pixel_height','')::integer,'ready',jsonb_build_object('storageBackend','drive','connectionId',c.id,'folderId',c.resource_id))
    on conflict(user_id,storage_path) do update set original_name=excluded.original_name,mime_type=excluded.mime_type,
        byte_size=excluded.byte_size,source_created_at=excluded.source_created_at,source_modified_at=excluded.source_modified_at,
        pixel_width=excluded.pixel_width,pixel_height=excluded.pixel_height,
        quality_details=screenshot.quality_details||excluded.quality_details,updated_at=now()
    returning * into r;
    return jsonb_build_object('record',to_jsonb(r),'epoch',s.epoch);
end $$;
revoke all on function public.register_drive_screenshot_reference(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.register_drive_screenshot_reference(uuid,bigint,jsonb) to service_role;

-- The archive worker records a verified, independently readable archive before
-- it is permitted to retire a local restore point. No existing points are purged.
create table if not exists data_recovery.restore_point_archives (
    restore_point_id uuid primary key,
    user_id uuid not null,
    checksum text not null check(checksum ~ '^[0-9a-f]{64}$'),
    archive_path text not null,
    archive_sha256 text not null check(archive_sha256 ~ '^[0-9a-f]{64}$'),
    archived_at timestamptz not null default now(),
    verified_at timestamptz not null,
    metadata jsonb not null default '{}'
);
alter table data_recovery.restore_point_archives enable row level security;
revoke all on data_recovery.restore_point_archives from public,anon,authenticated;
grant all on data_recovery.restore_point_archives to service_role;

create table if not exists data_recovery.history_archives (
    first_id bigint not null,
    last_id bigint not null,
    archive_path text not null,
    archive_sha256 text not null check(archive_sha256 ~ '^[0-9a-f]{64}$'),
    verified_at timestamptz not null,
    row_ids bigint[] not null,
    primary key(first_id,last_id),
    check(first_id<=last_id)
);
alter table data_recovery.history_archives enable row level security;
revoke all on data_recovery.history_archives from public,anon,authenticated;
grant all on data_recovery.history_archives to service_role;
create index history_archives_row_ids on data_recovery.history_archives using gin(row_ids);

create or replace function data_recovery.create_point(p_user_id uuid,p_reason text,p_snapshot jsonb default null,p_scope text default 'full')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_snapshot jsonb; v_counts jsonb; v_checksum text; v_result jsonb; latest_id uuid; latest_epoch bigint; latest_cursor bigint; current_state data_recovery.owner_state; automatic boolean;
begin
    perform data_recovery.lock_owner(p_user_id);
    automatic := p_reason in ('daily','startup-sync','manual-sync');
    select * into current_state from data_recovery.owner_state where user_id=p_user_id;
    select id,epoch,cursor,jsonb_build_object('id',id,'userId',user_id,'createdAt',created_at,'reason',reason,
        'epoch',epoch,'cursor',cursor,'counts',counts,'checksum',checksum,'scope',scope)
      into latest_id,latest_epoch,latest_cursor,v_result from data_recovery.restore_points
      where user_id=p_user_id and scope='full' order by created_at desc,id desc limit 1;
    if automatic and latest_id is not null and latest_epoch=current_state.epoch and latest_cursor=current_state.cursor then
        return v_result||jsonb_build_object('skipped',true,'unchanged',true);
    end if;
    -- Retire only independently archived, checksum-matched points, preserving
    -- the two newest existing points before creating the third in this transaction.
    if (select count(*) from data_recovery.restore_points where user_id=p_user_id and scope='full')>=3 then
        delete from data_recovery.restore_points p using (
            select id,row_number() over(order by created_at desc,id desc) as rank
            from data_recovery.restore_points where user_id=p_user_id and scope='full'
        ) old_point, data_recovery.restore_point_archives a
        where p.id=old_point.id and old_point.rank>=3 and a.restore_point_id=p.id
          and a.user_id=p.user_id and a.checksum=p.checksum and a.verified_at is not null;
    end if;
    if pg_database_size(current_database())>=450000000
       or (select count(*) from data_recovery.restore_points where user_id=p_user_id and scope='full')>=3 then
        if automatic and latest_id is not null then
            return v_result||jsonb_build_object('skipped',true,'archivePending',true);
        end if;
        raise exception 'Спочатку потрібно перевірити зовнішній архів копій або звільнити місце в базі.' using errcode='54000';
    end if;
    v_snapshot:=coalesce(p_snapshot,data_recovery.snapshot_owner(p_user_id));
    if pg_database_size(current_database()) + 2*octet_length(v_snapshot::text)::bigint > 475000000 then
        raise exception 'Недостатньо місця для нової точки відновлення. Потрібен зовнішній архів.' using errcode='PT507';
    end if;
    v_counts:=data_recovery.snapshot_counts(v_snapshot);
    v_checksum:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
    insert into data_recovery.restore_points(user_id,created_by,reason,epoch,cursor,snapshot,checksum,counts,scope)
    select p_user_id,auth.uid(),left(p_reason,120),s.epoch,s.cursor,v_snapshot,v_checksum,v_counts,p_scope
    from data_recovery.owner_state s where s.user_id=p_user_id
    returning jsonb_build_object('id',id,'userId',user_id,'createdAt',created_at,'reason',reason,'epoch',epoch,
        'cursor',cursor,'counts',counts,'checksum',checksum,'scope',scope,'incomplete',scope='legacy-merge',
        'coverage','database-and-file-manifest') into v_result;
    return v_result;
end $$;


-- An unchanged account does not need another full daily snapshot. Archiving
-- failures must not silently destroy its existing restore points.
create or replace function data_recovery.maintain_recovery()
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; latest data_recovery.restore_points; s data_recovery.owner_state;
begin
    for owner_id in select id from public.profiles order by id loop
        perform data_recovery.lock_owner(owner_id);
        select * into s from data_recovery.owner_state where user_id=owner_id;
        select * into latest from data_recovery.restore_points where user_id=owner_id and scope='full' order by created_at desc,id desc limit 1;
        if pg_database_size(current_database()) < 450000000
           and (latest.id is null or (latest.created_at<now()-interval '23 hours' and (latest.cursor<>s.cursor or latest.epoch<>s.epoch)))
           then
            perform data_recovery.create_point(owner_id,'daily');
        end if;
    end loop;
    -- Retention and cursor compaction are performed by the verified archive
    -- worker, which keeps the newest three points and all operation dedupe keys.
end $$;
revoke all on function data_recovery.maintain_recovery() from public,anon,authenticated;
grant execute on function data_recovery.maintain_recovery() to service_role;

notify pgrst, 'reload schema';
commit;
