begin;

-- Bootstrap was returning the whole profile, including the large settings
-- document, and every sync then read that document again even when nothing
-- in settings had changed. Ten people opening the journal did both at once.
create or replace function public.get_app_bootstrap(
    target_user_id uuid default auth.uid(),
    date_from date default (date_trunc('month', current_date) - interval '1 month')::date,
    date_to date default (date_trunc('month', current_date) + interval '1 month - 1 day')::date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'profile', coalesce((
            select jsonb_build_object('id', p.id, 'nick', p.nick, 'role', p.role)
            from public.profiles p
            where p.id = target_user_id
        ), '{}'::jsonb),
        'journal_days', coalesce((
            select jsonb_agg(to_jsonb(j) order by j.trade_date)
            from public.journal_days j
            where j.user_id = target_user_id
              and j.trade_date between date_from and date_to
        ), '[]'::jsonb),
        'server_time', now()
    );
$$;

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
        limit least(greatest(p_limit, 1), 8)
    )
    select max(cursor) into last_cursor from page;
    if last_cursor is null then last_cursor := s.cursor; end if;

    select max(cursor) into settings_cursor
    from data_recovery.change_history
    where user_id = owner_id and domain = 'settings'
      and cursor > greatest(p_cursor, 0) and cursor <= last_cursor;
    if settings_cursor is not null then
        select settings into live_settings from public.profiles where id = owner_id;
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

notify pgrst, 'reload schema';
commit;
