-- Screenshot lists moved from profiles.settings into user_settings.
-- soft_delete_screenshot still edited only the profile copy, so the next
-- sync merged the old user_settings list back and the screenshot reappeared.

create or replace function public.soft_delete_screenshot(p_storage_path text, p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    owner_id uuid := data_recovery.authorize_owner(p_user_id, true);
    point jsonb;
    s data_recovery.owner_state;
    object_path text := regexp_replace(p_storage_path, '^screenshots/', '');
    canonical text;
    paths text[];
    drive_id text := '';
begin
    if split_part(object_path, '/', 1) <> owner_id::text then
        raise exception 'File owner mismatch' using errcode = '42501';
    end if;
    canonical := 'screenshots/' || object_path;
    paths := array[p_storage_path, canonical];
    perform data_recovery.lock_owner(owner_id);
    point := data_recovery.create_point(owner_id, 'before-file-delete');

    select coalesce(
        nullif(us.value -> p_storage_path ->> 'driveId', ''),
        nullif(us.value -> canonical ->> 'driveId', ''),
        ''
    ) into drive_id
    from public.user_settings us
    where us.user_id = owner_id and us.key = 'screenMeta';

    if drive_id = '' then
        select coalesce(
            nullif(p.settings -> 'screenMeta' -> p_storage_path ->> 'driveId', ''),
            nullif(p.settings -> 'screenMeta' -> canonical ->> 'driveId', ''),
            ''
        ) into drive_id
        from public.profiles p
        where p.id = owner_id;
    end if;

    update public.screenshots
    set deleted_at = now(), updated_at = now()
    where user_id = owner_id and storage_path = any(paths);

    update public.journal_days j
    set daily_metrics = jsonb_set(coalesce(j.daily_metrics, '{}'::jsonb), '{screenshots}',
        (select coalesce(jsonb_object_agg(key, (
            select coalesce(jsonb_agg(item), '[]'::jsonb)
            from jsonb_array_elements(value) item
            where item #>> '{}' <> all(paths)
        )), '{}'::jsonb)
        from jsonb_each(coalesce(j.daily_metrics -> 'screenshots', '{}'::jsonb))
        where jsonb_typeof(value) = 'array'))
    where j.user_id = owner_id
      and coalesce(j.daily_metrics -> 'screenshots', '{}'::jsonb)::text like '%' || object_path || '%';

    update public.user_settings us
    set value = case
            when us.key = 'unassignedImages' then (
                select coalesce(jsonb_agg(item), '[]'::jsonb)
                from jsonb_array_elements(us.value) item
                where item #>> '{}' <> all(paths)
            )
            else us.value - p_storage_path - canonical
        end,
        version = us.version + 1,
        updated_at = now()
    where us.user_id = owner_id
      and (
        (us.key = 'unassignedImages' and jsonb_typeof(us.value) = 'array' and us.value::text like '%' || object_path || '%')
        or (us.key in ('screenMeta', 'tickers') and jsonb_typeof(us.value) = 'object' and (us.value ?| paths))
      );

    update public.profiles p
    set settings = coalesce(p.settings, '{}'::jsonb)
        || case when p.settings ? 'unassignedImages' and jsonb_typeof(p.settings -> 'unassignedImages') = 'array' then
            jsonb_build_object('unassignedImages', (
                select coalesce(jsonb_agg(item), '[]'::jsonb)
                from jsonb_array_elements(p.settings -> 'unassignedImages') item
                where item #>> '{}' <> all(paths)
            ))
            else '{}'::jsonb end
        || jsonb_build_object(
            'screenMeta', coalesce(p.settings -> 'screenMeta', '{}'::jsonb) - p_storage_path - canonical,
            'screenTags', coalesce(p.settings -> 'screenTags', '{}'::jsonb) - p_storage_path - canonical,
            'screenDiscipline', coalesce(p.settings -> 'screenDiscipline', '{}'::jsonb) - p_storage_path - canonical
        )
        || case when drive_id = '' then '{}'::jsonb else jsonb_build_object('driveDeletedIds', (
            select coalesce(jsonb_agg(distinct id), '[]'::jsonb)
            from (
                select jsonb_array_elements_text(
                    case when jsonb_typeof(p.settings -> 'driveDeletedIds') = 'array'
                        then p.settings -> 'driveDeletedIds' else '[]'::jsonb end
                ) as id
                union all
                select drive_id
            ) ids
            where id <> ''
        )) end,
        updated_at = now()
    where p.id = owner_id;

    insert into data_recovery.file_retirements(user_id, storage_path)
    values (owner_id, canonical)
    on conflict (user_id, storage_path) do update
    set retired_at = now(), purge_after = now() + interval '30 days';

    select * into s from data_recovery.owner_state where user_id = owner_id;
    return jsonb_build_object('deleted', true, 'restorePointId', point ->> 'id', 'epoch', s.epoch, 'cursor', s.cursor);
end $$;

notify pgrst, 'reload schema';
