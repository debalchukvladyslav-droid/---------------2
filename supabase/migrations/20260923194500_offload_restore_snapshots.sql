begin;

alter table data_recovery.restore_points add column if not exists snapshot_path text;

insert into storage.buckets(id, name, public, file_size_limit)
values ('journal-backups', 'journal-backups', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists journal_backups_owner_read on storage.objects;
create policy journal_backups_owner_read on storage.objects
for select to authenticated
using (
    bucket_id = 'journal-backups'
    and split_part(name, '/', 1) = (select auth.uid()::text)
);

drop policy if exists journal_backups_owner_insert on storage.objects;
create policy journal_backups_owner_insert on storage.objects
for insert to authenticated
with check (
    bucket_id = 'journal-backups'
    and split_part(name, '/', 1) = (select auth.uid()::text)
);

drop policy if exists journal_backups_owner_update on storage.objects;
create policy journal_backups_owner_update on storage.objects
for update to authenticated
using (
    bucket_id = 'journal-backups'
    and split_part(name, '/', 1) = (select auth.uid()::text)
)
with check (
    bucket_id = 'journal-backups'
    and split_part(name, '/', 1) = (select auth.uid()::text)
);

create or replace function public.mark_restore_point_offloaded(p_restore_point_id uuid, p_path text, p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid; p data_recovery.restore_points; expected_path text;
begin
    if session_user in ('postgres', 'supabase_admin') and p_user_id is not null then
        owner_id := p_user_id;
    else
        owner_id := data_recovery.authorize_owner(p_user_id, true);
    end if;
    select * into p from data_recovery.restore_points where id = p_restore_point_id and user_id = owner_id;
    if not found then raise exception 'Restore point not found'; end if;
    expected_path := owner_id::text || '/' || p.id::text || '.json';
    if p_path is distinct from expected_path then raise exception 'Unexpected snapshot path'; end if;
    if p.id = (select id from data_recovery.restore_points where user_id = owner_id order by created_at desc, id desc limit 1) then
        raise exception 'The newest restore point stays in the database';
    end if;
    if p.snapshot_path = expected_path and coalesce(p.snapshot->>'offloaded', '') = 'true' then
        return jsonb_build_object('id', p.id, 'offloaded', true, 'storagePath', expected_path);
    end if;
    if p.checksum is distinct from encode(sha256(convert_to(p.snapshot::text, 'UTF8')), 'hex') then
        raise exception 'Snapshot checksum mismatch; refusing to offload';
    end if;
    if not exists(select 1 from storage.objects o where o.bucket_id = 'journal-backups' and o.name = expected_path) then
        raise exception 'Snapshot file is not in storage yet';
    end if;
    update data_recovery.restore_points
       set snapshot = jsonb_build_object('offloaded', true, 'storagePath', expected_path, 'checksum', p.checksum),
           snapshot_path = expected_path
     where id = p.id;
    return jsonb_build_object('id', p.id, 'offloaded', true, 'storagePath', expected_path);
end $$;

create or replace function public.stage_restore_snapshot(p_restore_point_id uuid, p_snapshot jsonb, p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid := data_recovery.authorize_owner(p_user_id, true); p data_recovery.restore_points; payload_checksum text;
begin
    if jsonb_typeof(p_snapshot) <> 'object' then raise exception 'Invalid snapshot'; end if;
    select * into p from data_recovery.restore_points where id = p_restore_point_id and user_id = owner_id;
    if not found then raise exception 'Restore point not found'; end if;
    payload_checksum := encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex');
    if payload_checksum is distinct from p.checksum then raise exception 'Snapshot checksum mismatch'; end if;
    if p.checksum is distinct from encode(sha256(convert_to(p.snapshot::text, 'UTF8')), 'hex') then
        update data_recovery.restore_points set snapshot = p_snapshot where id = p.id;
    end if;
    return jsonb_build_object('id', p.id, 'userId', p.user_id, 'createdAt', p.created_at, 'reason', p.reason,
        'epoch', p.epoch, 'cursor', p.cursor, 'counts', p.counts, 'checksum', p.checksum, 'scope', p.scope,
        'snapshot', p_snapshot);
end $$;

create or replace function public.list_restore_points(p_user_id uuid default null, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid := data_recovery.authorize_owner(p_user_id, false); result jsonb;
begin
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'userId', p.user_id, 'createdAt', p.created_at, 'reason', p.reason,
        'epoch', p.epoch, 'cursor', p.cursor, 'counts', p.counts, 'checksum', p.checksum, 'scope', p.scope,
        'incomplete', p.scope = 'legacy-merge', 'coverage', 'database-and-file-manifest',
        'offloaded', p.snapshot_path is not null, 'storagePath', p.snapshot_path) order by p.created_at desc), '[]') into result
    from (
        select id, user_id, created_at, reason, epoch, cursor, counts, checksum, scope, snapshot_path
        from data_recovery.restore_points
        where user_id = owner_id
        order by created_at desc
        limit least(greatest(p_limit, 1), 200)
    ) p;
    return result;
end $$;

revoke all on function public.mark_restore_point_offloaded(uuid, text, uuid) from public, anon;
revoke all on function public.stage_restore_snapshot(uuid, jsonb, uuid) from public, anon;
grant execute on function public.mark_restore_point_offloaded(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.stage_restore_snapshot(uuid, jsonb, uuid) to authenticated, service_role;
alter function public.list_restore_points(uuid, integer) set statement_timeout = '20s';

notify pgrst, 'reload schema';
commit;
