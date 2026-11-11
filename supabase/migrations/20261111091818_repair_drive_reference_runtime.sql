-- Repair runtime RPCs omitted from the previous quota deployment.
-- Keep recovery policies and existing file bytes unchanged.
begin;

create or replace function public.get_source_sync_state(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    perform data_recovery.lock_owner(p_user_id);
    return (select jsonb_build_object('epoch', epoch, 'cursor', cursor)
            from data_recovery.owner_state where user_id = p_user_id);
end $$;
revoke all on function public.get_source_sync_state(uuid) from public, anon, authenticated;
grant execute on function public.get_source_sync_state(uuid) to service_role;


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


notify pgrst, 'reload schema';
commit;
