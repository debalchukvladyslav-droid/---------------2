begin;

-- Pulls were timing out because the settings lookup could not use an index,
-- and each history row detoasted both the old and new JSON documents.
create index if not exists change_history_owner_domain_cursor
    on data_recovery.change_history (user_id, domain, cursor desc);

create or replace function public.pull_data_changes(p_cursor bigint default 0, p_limit integer default 500, p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := data_recovery.authorize_owner(p_user_id, false); s data_recovery.owner_state;
    changes jsonb; last_cursor bigint;
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
        'record', case when h.domain = 'settings' then h.new_record -> 'settings' else h.new_record end,
        'deleted', h.new_record is null, 'version', h.version, 'epoch', h.epoch, 'operationId', h.operation_id
    ) order by h.cursor), '[]') into changes from selected h;

    return jsonb_build_object('changes', changes, 'cursor', last_cursor, 'epoch', s.epoch,
        'hasMore', last_cursor < s.cursor, 'resetRequired', p_cursor < s.minimum_cursor or p_cursor > s.cursor);
end $$;

alter function public.pull_data_changes(bigint, integer, uuid) set statement_timeout = '30s';
alter function public.pull_data_changes(bigint, integer, uuid) set lock_timeout = '20s';

-- One compact payload instead of paging every journal day with daily_metrics.
create or replace function public.list_mechanical_signals(p_from date)
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '8s'
as $$
    select coalesce(jsonb_agg(row_payload), '[]'::jsonb)
    from (
        select jsonb_build_object(
            'user_id', j.user_id,
            'trade_date', j.trade_date,
            'trades', coalesce(jsonb_agg(jsonb_build_object(
                'symbol', coalesce(t->>'symbol', t->>'ticker'),
                'ticker', coalesce(t->>'ticker', t->>'symbol'),
                'opened', t->>'opened',
                'closed', t->>'closed',
                'type', t->>'type',
                'tradeType', t->>'tradeType',
                'setupType', t->>'setupType',
                'note', t->>'note',
                'notes', t->>'notes',
                'profitRisk', coalesce(t->'sheet'->>'profitRisk', t->>'profitRisk'),
                'kf', t->>'kf',
                'sheet', jsonb_build_object(
                    'profitRisk', t->'sheet'->>'profitRisk',
                    'tradeType', t->'sheet'->>'tradeType',
                    'exception', t->'sheet'->>'exception',
                    'exceptions', t->'sheet'->'exceptions',
                    'pv', t->'sheet'->>'pv',
                    'sheetRow', coalesce(t->'sheet'->>'sheetRow', t->'sheet'->>'rowNumber', t->'sheet'->>'row'),
                    'spreadsheetId', t->'sheet'->>'spreadsheetId',
                    'sourceFileId', t->'sheet'->>'sourceFileId',
                    'source', t->'sheet'->>'source'
                )
            )), '[]'::jsonb)
        ) as row_payload
        from public.journal_days j
        cross join lateral jsonb_array_elements(coalesce(j.daily_metrics->'trades', '[]'::jsonb)) t
        where j.trade_date >= coalesce(p_from, current_date - 800)
          and coalesce(t->>'symbol', t->>'ticker', '') <> ''
          and coalesce(t->'sheet'->>'profitRisk', t->>'profitRisk', t->>'kf') is not null
        group by j.user_id, j.trade_date
        order by j.trade_date desc
        limit 2000
    ) days;
$$;

revoke all on function public.list_mechanical_signals(date) from public, anon, authenticated;
grant execute on function public.list_mechanical_signals(date) to service_role;

do $$
declare target text;
begin
    foreach target in array array[
        'daily_market_bars',
        'daily_market_regime',
        'daily_aggressiveness_prediction',
        'mechanical_signal_normalized',
        'ticker_day_outcome',
        'daily_short_edge'
    ]
    loop
        if to_regclass('public.' || target) is not null then
            execute format('grant select, insert, update on public.%I to service_role', target);
        end if;
    end loop;
end $$;

notify pgrst, 'reload schema';
commit;
