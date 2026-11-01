-- Disk IO budget alert (Nov 2026): data_recovery.change_history toast (~1.8 GB)
-- is dominated by full user_settings values, and ~30 daily restore snapshots per
-- account keep hundreds of megabytes warm on disk. Stop writing setting payloads
-- into history, pull live values for sync, keep three restore points, and reclaim
-- space already agreed for free-tier operations.

begin;
set local statement_timeout = '180s';
set local lock_timeout = '30s';

create or replace function data_recovery.skip_unchanged_setting()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.user_id = old.user_id and new.key = old.key and new.value is not distinct from old.value then
        return null;
    end if;
    return new;
end $$;
revoke all on function data_recovery.skip_unchanged_setting() from public, anon, authenticated;
drop trigger if exists skip_unchanged_setting on public.user_settings;
create trigger skip_unchanged_setting before update on public.user_settings
for each row execute function data_recovery.skip_unchanged_setting();

create or replace function data_recovery.capture_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare before_row jsonb; after_row jsonb; row_data jsonb; owner_id uuid; kind text;
    entity text; domain_name text; next_cursor bigint; current_epoch bigint; row_version bigint;
begin
    if tg_table_name = 'trades' and coalesce(current_setting('app.bulk_trade_projection', true), '') = '1' then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
    if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
    if (before_row - array['updated_at','sync_version']) is not distinct from (after_row - array['updated_at','sync_version']) then
        return coalesce(new, old);
    end if;
    -- Operational heartbeats are not user edits or restorable configuration.
    if tg_table_name = 'integration_connections' and tg_op = 'UPDATE'
       and (before_row - array['verified_at','last_sync_at','last_revision','last_error','next_sync_at'])
           is not distinct from (after_row - array['verified_at','last_sync_at','last_revision','last_error','next_sync_at']) then
        return new;
    end if;
    if tg_table_name = 'google_sheet_sync_configs' and tg_op = 'UPDATE'
       and (before_row - array['updated_at','last_sync_at','last_sync_status','last_sync_error'])
           is not distinct from (after_row - array['updated_at','last_sync_at','last_sync_status','last_sync_error']) then
        return new;
    end if;
    row_data := coalesce(after_row, before_row);
    select owner_kind into kind from data_recovery.table_registry where table_name = tg_table_name;
    owner_id := case when kind = 'profile' then (row_data->>'id')::uuid else (row_data->>'user_id')::uuid end;
    if kind = 'review' then select user_id into owner_id from public.stop_reviews where id = (row_data->>'review_id')::uuid; end if;
    if kind = 'evaluation' then select user_id into owner_id from public.ai_evaluation_cases where id = (row_data->>'case_id')::uuid; end if;
    if kind = 'legacy' then select id into owner_id from public.profiles where nick = regexp_replace(row_data->>'user_doc_name', '_stats$', ''); end if;
    entity := coalesce(row_data->>'id', row_data->>'review_id' || ':' || (row_data->>'mistake_id'), row_data->>'start_token', md5(row_data::text));
    if owner_id is null and kind in ('review', 'evaluation') then
        select h.user_id into owner_id from data_recovery.change_history h where h.table_name = tg_table_name and h.entity_id = entity order by h.id desc limit 1;
    end if;
    owner_id := coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid);
    perform data_recovery.lock_owner(owner_id);
    update data_recovery.owner_state set cursor = cursor + 1, updated_at = now(),
        settings_version = settings_version + case when tg_table_name = 'profiles' and (before_row->'settings') is distinct from (after_row->'settings') then 1 else 0 end
        where user_id = owner_id returning cursor, epoch, settings_version into next_cursor, current_epoch, row_version;
    domain_name := tg_table_name;
    if tg_table_name = 'journal_days' then
        domain_name := 'journal'; entity := row_data->>'trade_date'; row_version := coalesce((row_data->>'sync_version')::bigint, 1);
        before_row := data_recovery.without_trade_array(before_row);
        after_row := data_recovery.without_trade_array(after_row);
    elsif tg_table_name = 'trades' then
        domain_name := 'trade';
        entity := (row_data->>'trade_date') || ':' || (row_data->>'id');
        row_version := coalesce((row_data->>'version')::bigint, 1);
        before_row := null;
        after_row := case when row_data->>'deleted_at' is null then jsonb_build_object(
            'id', row_data->'id', 'trade_date', row_data->'trade_date', 'version', row_data->'version', 'payload', row_data->'payload'
        ) else null end;
    elsif tg_table_name = 'user_settings' then
        -- Keep a cursor marker only. Sync reads the live user_settings row.
        domain_name := 'setting'; entity := row_data->>'key'; row_version := coalesce((row_data->>'version')::bigint, 1);
        before_row := null;
        after_row := case when tg_op = 'DELETE' then null else '{}'::jsonb end;
    elsif tg_table_name = 'profiles' then
        domain_name := 'settings'; entity := owner_id::text;
        before_row := case when before_row is null then null else '{}'::jsonb end;
        after_row := case when after_row is null then null else '{}'::jsonb end;
    else row_version := next_cursor; end if;
    insert into data_recovery.change_history(user_id, cursor, epoch, table_name, entity_id, domain, old_record, new_record, version, operation_id, actor_id, source)
    values(owner_id, next_cursor, current_epoch, tg_table_name, entity, domain_name, before_row, after_row, row_version,
        nullif(current_setting('app.data_operation_id', true), '')::uuid, auth.uid(), coalesce(nullif(current_setting('app.data_source', true), ''), 'database'));
    return coalesce(new, old);
end $$;

create or replace function public.pull_data_changes(p_cursor bigint default 0, p_limit integer default 500, p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := data_recovery.authorize_owner(p_user_id, false); s data_recovery.owner_state;
    changes jsonb; last_cursor bigint; settings_cursor bigint; live_settings jsonb;
begin
    perform data_recovery.lock_owner_shared(owner_id);
    select * into s from data_recovery.owner_state where user_id = owner_id;

    with page as materialized (
        select cursor, domain, entity_id
        from data_recovery.change_history
        where user_id = owner_id and cursor > greatest(p_cursor, 0) and cursor <= s.cursor
        order by cursor
        limit least(greatest(p_limit, 1), 40)
    )
    select max(cursor) into last_cursor from page;
    if last_cursor is null then last_cursor := s.cursor; end if;

    select max(cursor) into settings_cursor
    from data_recovery.change_history
    where user_id = owner_id and domain = 'settings'
      and cursor > greatest(p_cursor, 0) and cursor <= last_cursor;
    if settings_cursor is not null then
        select coalesce(p.settings, '{}'::jsonb) || coalesce((
            select jsonb_object_agg(us.key, us.value) from public.user_settings us where us.user_id = owner_id
        ), '{}'::jsonb)
        into live_settings from public.profiles p where p.id = owner_id;
    end if;

    with page as materialized (
        select cursor, domain
        from data_recovery.change_history
        where user_id = owner_id and cursor > greatest(p_cursor, 0) and cursor <= last_cursor
    ), selected_cursors as (
        select cursor from page where domain <> 'settings'
        union all
        select settings_cursor where settings_cursor is not null
    ), selected as (
        select h.cursor, h.domain, h.entity_id, h.new_record, h.version, h.epoch, h.operation_id
        from (
            select h.cursor, h.domain, h.entity_id, h.new_record, h.version, h.epoch, h.operation_id,
                row_number() over (partition by h.domain, h.entity_id order by h.cursor desc) as revision
            from selected_cursors c
            join data_recovery.change_history h on h.user_id = owner_id and h.cursor = c.cursor
        ) h
        where h.domain is distinct from 'setting' or h.revision = 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'cursor', h.cursor, 'domain', h.domain, 'entityId', h.entity_id,
        'record', case
            when h.domain = 'settings' then coalesce(live_settings, '{}'::jsonb)
            when h.domain = 'setting' and h.new_record is not null then coalesce(
                (select us.value from public.user_settings us where us.user_id = owner_id and us.key = h.entity_id),
                h.new_record
            )
            else h.new_record
        end,
        'deleted', h.domain <> 'settings' and h.new_record is null,
        'version', h.version, 'epoch', h.epoch, 'operationId', h.operation_id
    ) order by h.cursor), '[]') into changes from selected h;

    return jsonb_build_object('changes', changes, 'cursor', last_cursor, 'epoch', s.epoch,
        'hasMore', last_cursor < s.cursor, 'resetRequired', p_cursor < s.minimum_cursor or p_cursor > s.cursor);
end $$;

alter function public.pull_data_changes(bigint, integer, uuid) set statement_timeout = '30s';
alter function public.pull_data_changes(bigint, integer, uuid) set lock_timeout = '20s';

-- Owner-approved free-tier policy: three newest restore points per account.
-- History older than 14 days is compacted; sync uses minimum_cursor.
create or replace function data_recovery.maintain_recovery()
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; cutoff timestamptz := now() - interval '14 days';
begin
    for owner_id in select id from public.profiles order by id loop
        perform data_recovery.lock_owner(owner_id);
        if not exists(
            select 1 from data_recovery.restore_points
            where user_id = owner_id and created_at > now() - interval '23 hours' and scope = 'full'
        ) and pg_database_size(current_database()) < 1500000000 then
            begin
                perform data_recovery.create_point(owner_id, 'daily');
            exception when others then
                raise warning 'daily restore point skipped for %: %', owner_id, sqlerrm;
            end;
        end if;
        update data_recovery.owner_state s
        set minimum_cursor = greatest(
            s.minimum_cursor,
            coalesce((select max(h.cursor) from data_recovery.change_history h where h.user_id = owner_id and h.created_at < cutoff), 0)
        )
        where s.user_id = owner_id;
        delete from data_recovery.change_history where user_id = owner_id and created_at < cutoff;
        delete from data_recovery.restore_points p
        where p.user_id = owner_id
          and p.id in (
              select id from (
                  select id, row_number() over (order by created_at desc, id desc) as rank
                  from data_recovery.restore_points
                  where user_id = owner_id and scope = 'full'
              ) ranked where rank > 3
          );
    end loop;
    delete from cron.job_run_details where end_time < now() - interval '7 days';
end $$;

notify pgrst, 'reload schema';
commit;

-- Physical reclaim (run after Disk IO budget recovers; see database/disk_io_reclaim.sql):
-- 1) slim setting history payloads to markers
-- 2) keep three newest restore points per user
-- 3) VACUUM (FULL) data_recovery.change_history / restore_points
