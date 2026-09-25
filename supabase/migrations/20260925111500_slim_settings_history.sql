begin;
set statement_timeout = '180s';

-- Settings history stored a full copy of the document on every save.
-- Pull the live profile instead, and keep only a cursor marker in history.
create or replace function public.pull_data_changes(p_cursor bigint default 0, p_limit integer default 500, p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := data_recovery.authorize_owner(p_user_id, false); s data_recovery.owner_state;
    changes jsonb; last_cursor bigint; live_settings jsonb;
begin
    perform data_recovery.lock_owner_shared(owner_id);
    select * into s from data_recovery.owner_state where user_id = owner_id;
    select settings into live_settings from public.profiles where id = owner_id;

    with page as materialized (
        select cursor, domain, entity_id
        from data_recovery.change_history
        where user_id = owner_id and cursor > greatest(p_cursor, 0) and cursor <= s.cursor
        order by cursor
        limit least(greatest(p_limit, 1), 8)
    )
    select max(cursor) into last_cursor from page;
    if last_cursor is null then last_cursor := s.cursor; end if;

    with page as materialized (
        select cursor, domain, entity_id
        from data_recovery.change_history
        where user_id = owner_id and cursor > greatest(p_cursor, 0) and cursor <= last_cursor
    ), latest_settings as (
        select max(cursor) as cursor
        from data_recovery.change_history
        where user_id = owner_id and domain = 'settings'
          and cursor > greatest(p_cursor, 0) and cursor <= s.cursor
    ), selected_cursors as (
        select cursor from page where domain <> 'settings'
        union all
        select cursor from latest_settings where cursor is not null and cursor <= last_cursor
    ), selected as (
        select h.cursor, h.domain, h.entity_id, h.new_record, h.version, h.epoch, h.operation_id
        from selected_cursors c
        join data_recovery.change_history h on h.user_id = owner_id and h.cursor = c.cursor
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'cursor', h.cursor, 'domain', h.domain, 'entityId', h.entity_id,
        'record', case when h.domain = 'settings' then coalesce(live_settings, '{}'::jsonb) else h.new_record end,
        'deleted', h.domain <> 'settings' and h.new_record is null, 'version', h.version, 'epoch', h.epoch, 'operationId', h.operation_id
    ) order by h.cursor), '[]') into changes from selected h;

    return jsonb_build_object('changes', changes, 'cursor', last_cursor, 'epoch', s.epoch,
        'hasMore', last_cursor < s.cursor, 'resetRequired', p_cursor < s.minimum_cursor or p_cursor > s.cursor);
end $$;

alter function public.pull_data_changes(bigint, integer, uuid) set statement_timeout = '30s';
alter function public.pull_data_changes(bigint, integer, uuid) set lock_timeout = '20s';

create or replace function data_recovery.capture_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare before_row jsonb; after_row jsonb; row_data jsonb; owner_id uuid; kind text;
    entity text; domain_name text; next_cursor bigint; current_epoch bigint; row_version bigint;
begin
    if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
    if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
    if (before_row - array['updated_at','sync_version']) is not distinct from (after_row - array['updated_at','sync_version']) then return coalesce(new, old); end if;
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

create or replace function data_recovery.slim_operation_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.result ? 'row' then new.result := new.result - 'row'; end if;
    return new;
end $$;

drop trigger if exists slim_operation_receipt on data_recovery.operation_receipts;
create trigger slim_operation_receipt
    before insert on data_recovery.operation_receipts
    for each row execute function data_recovery.slim_operation_receipt();

revoke all on function data_recovery.slim_operation_receipt() from public, anon, authenticated;

update data_recovery.change_history
set old_record = null,
    new_record = case when domain = 'settings' and new_record is not null then '{}'::jsonb else new_record end
where domain = 'settings' or old_record is not null;

update data_recovery.operation_receipts
set result = result - 'row'
where result ? 'row';

notify pgrst, 'reload schema';
commit;
