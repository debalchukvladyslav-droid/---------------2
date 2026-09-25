begin;
set statement_timeout = '180s';

-- One trade is one row. A day edit no longer rewrites the whole trade list
-- into the change log, and a heavy settings key no longer rewrites the profile.

create or replace function data_recovery.json_num(p jsonb, p_keys text[])
returns numeric language sql immutable set search_path = '' as $$
    select (p->>k)::numeric
    from unnest(p_keys) as k
    where coalesce(p->>k, '') ~ '^-?[0-9]+(\.[0-9]+)?$'
    limit 1
$$;

create or replace function data_recovery.trade_row_id(p_owner uuid, p_date date, p_ordinal integer, p_elem jsonb)
returns uuid language sql immutable set search_path = '' as $$
    select case
        when coalesce(p_elem->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then (p_elem->>'id')::uuid
        else (
            select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-' || substr(h, 13, 4) || '-' || substr(h, 17, 4) || '-' || substr(h, 21, 12))::uuid
            from (
                select md5(p_owner::text || '|' || p_date::text || '|' || p_ordinal::text || '|'
                    || coalesce(p_elem->>'symbol', p_elem->>'ticker', '') || '|'
                    || coalesce(p_elem->>'entry', p_elem->>'entryPrice', '') || '|'
                    || coalesce(p_elem->>'exit', p_elem->>'exitPrice', '') || '|'
                    || coalesce(p_elem->>'qty', p_elem->>'shares', p_elem->>'quantity', '')) as h
            ) hash
        )
    end
$$;

create or replace function data_recovery.without_trade_array(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
    select case
        when p is null or not (p ? 'daily_metrics') then p
        else jsonb_set(p, '{daily_metrics,trades}', '[]'::jsonb, true)
    end
$$;

create table if not exists public.trades (
    id uuid primary key,
    user_id uuid not null references public.profiles(id) on delete cascade,
    trade_date date not null,
    ticker text,
    side text,
    entry_price numeric,
    exit_price numeric,
    shares numeric,
    pnl numeric,
    setup text,
    payload jsonb not null default '{}'::jsonb,
    version bigint not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

create index if not exists trades_owner_date on public.trades (user_id, trade_date) where deleted_at is null;
create index if not exists trades_owner_updated on public.trades (user_id, updated_at);
create index if not exists trades_owner_version on public.trades (user_id, version);

create table if not exists public.user_settings (
    user_id uuid not null references public.profiles(id) on delete cascade,
    key text not null,
    value jsonb not null default 'null'::jsonb,
    version bigint not null default 1,
    updated_at timestamptz not null default now(),
    primary key (user_id, key)
);

create index if not exists user_settings_owner_updated on public.user_settings (user_id, updated_at);

insert into public.trades (id, user_id, trade_date, ticker, side, entry_price, exit_price, shares, pnl, setup, payload)
select data_recovery.trade_row_id(j.user_id, j.trade_date, t.ordinal::integer, t.elem),
    j.user_id, j.trade_date,
    left(coalesce(t.elem->>'symbol', t.elem->>'ticker', ''), 32),
    left(coalesce(t.elem->>'type', t.elem->>'side', ''), 32),
    data_recovery.json_num(t.elem, array['entry', 'entryPrice', 'openPrice']),
    data_recovery.json_num(t.elem, array['exit', 'exitPrice', 'closePrice']),
    data_recovery.json_num(t.elem, array['qty', 'shares', 'quantity']),
    data_recovery.json_num(t.elem, array['net', 'pnl', 'profit']),
    left(coalesce(t.elem->>'setup', t.elem->>'strategy', ''), 120),
    t.elem || jsonb_build_object('id', data_recovery.trade_row_id(j.user_id, j.trade_date, t.ordinal::integer, t.elem))
from public.journal_days j
cross join lateral jsonb_array_elements(coalesce(j.daily_metrics->'trades', '[]'::jsonb)) with ordinality as t(elem, ordinal)
where jsonb_typeof(j.daily_metrics->'trades') = 'array'
  and jsonb_array_length(j.daily_metrics->'trades') > 0
on conflict (id) do nothing;

insert into public.user_settings (user_id, key, value)
select p.id, e.key, e.value
from public.profiles p
cross join lateral jsonb_each(coalesce(p.settings, '{}'::jsonb)) e
where e.key = any(array['tickers', 'screenMeta', 'sheetRows', 'cumulativeSheetRows', 'unassignedImages', 'aiChatHistory', 'aiSavedChats', 'weeklyComments', 'monthlyDayloss'])
on conflict (user_id, key) do nothing;

alter table public.journal_days disable trigger zz_data_recovery_history;
alter table public.journal_days disable trigger trg_journal_days_sync_version;
alter table public.profiles disable trigger zz_data_recovery_history;

update public.journal_days
set daily_metrics = jsonb_set(coalesce(daily_metrics, '{}'::jsonb), '{trades}', '[]'::jsonb, true)
where jsonb_typeof(daily_metrics->'trades') = 'array'
  and jsonb_array_length(daily_metrics->'trades') > 0;

update public.profiles
set settings = coalesce(settings, '{}'::jsonb)
    - 'tickers' - 'screenMeta' - 'sheetRows' - 'cumulativeSheetRows'
    - 'unassignedImages' - 'aiChatHistory' - 'aiSavedChats'
    - 'weeklyComments' - 'monthlyDayloss'
where settings ?| array['tickers', 'screenMeta', 'sheetRows', 'cumulativeSheetRows', 'unassignedImages', 'aiChatHistory', 'aiSavedChats', 'weeklyComments', 'monthlyDayloss'];

alter table public.journal_days enable trigger trg_journal_days_sync_version;
alter table public.journal_days enable trigger zz_data_recovery_history;
alter table public.profiles enable trigger zz_data_recovery_history;

create or replace function data_recovery.project_day_trades(p_owner uuid, p_date date, p_trades jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare elem jsonb; ordinal integer; trade_id uuid; ids uuid[] := '{}'; existing_count integer;
begin
    if jsonb_typeof(p_trades) <> 'array' then return; end if;
    select count(*) into existing_count from public.trades
    where user_id = p_owner and trade_date = p_date and deleted_at is null;
    if jsonb_array_length(p_trades) = 0 and existing_count > 0 then return; end if;
    for elem, ordinal in select value, ordinality::integer from jsonb_array_elements(p_trades) with ordinality loop
        trade_id := data_recovery.trade_row_id(p_owner, p_date, ordinal, elem);
        ids := ids || trade_id;
        insert into public.trades as t (id, user_id, trade_date, ticker, side, entry_price, exit_price, shares, pnl, setup, payload, version)
        values (
            trade_id, p_owner, p_date,
            left(coalesce(elem->>'symbol', elem->>'ticker', ''), 32),
            left(coalesce(elem->>'type', elem->>'side', ''), 32),
            data_recovery.json_num(elem, array['entry', 'entryPrice', 'openPrice']),
            data_recovery.json_num(elem, array['exit', 'exitPrice', 'closePrice']),
            data_recovery.json_num(elem, array['qty', 'shares', 'quantity']),
            data_recovery.json_num(elem, array['net', 'pnl', 'profit']),
            left(coalesce(elem->>'setup', elem->>'strategy', ''), 120),
            elem || jsonb_build_object('id', trade_id),
            1
        )
        on conflict (id) do update set
            ticker = excluded.ticker, side = excluded.side, entry_price = excluded.entry_price,
            exit_price = excluded.exit_price, shares = excluded.shares, pnl = excluded.pnl, setup = excluded.setup,
            payload = excluded.payload, deleted_at = null, version = t.version + 1, updated_at = now()
        where t.user_id = p_owner;
    end loop;
    update public.trades
    set deleted_at = now(), version = version + 1, updated_at = now()
    where user_id = p_owner and trade_date = p_date and deleted_at is null and not (id = any(ids));
end $$;

revoke all on function data_recovery.project_day_trades(uuid, date, jsonb) from public, anon, authenticated;
revoke all on function data_recovery.trade_row_id(uuid, date, integer, jsonb) from public, anon, authenticated;
revoke all on function data_recovery.json_num(jsonb, text[]) from public, anon, authenticated;
revoke all on function data_recovery.without_trade_array(jsonb) from public, anon, authenticated;

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
        domain_name := 'setting'; entity := row_data->>'key'; row_version := coalesce((row_data->>'version')::bigint, 1);
        before_row := null; after_row := row_data->'value';
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

insert into data_recovery.table_registry(table_name, owner_kind, restore_order)
values ('trades', 'user_id', 12), ('user_settings', 'user_id', 1)
on conflict (table_name) do nothing;
select data_recovery.install_history_trigger('trades');
select data_recovery.install_history_trigger('user_settings');

create or replace function data_recovery.apply_one(p_op jsonb, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
<<operation_scope>>
declare operation_id uuid := (p_op->>'operationId')::uuid; domain_name text := p_op->>'domain'; entity text := p_op->>'entityId';
    current_row jsonb; current_value jsonb; merged jsonb; v bigint := 0; s data_recovery.owner_state; receipt data_recovery.operation_receipts;
    result jsonb; conflict_id uuid; request_hash text := encode(sha256(convert_to(p_op::text, 'UTF8')), 'hex'); reason text; k text;
    trade_id uuid; trade_date date; profile_settings jsonb; heavy text[] := array['tickers','screenMeta','sheetRows','cumulativeSheetRows','unassignedImages','aiChatHistory','aiSavedChats','weeklyComments','monthlyDayloss'];
begin
    if operation_id is null or domain_name not in ('journal', 'settings', 'trade') or entity is null
       or jsonb_typeof(p_op->'patch') <> 'object' or p_op->>'epoch' is null or p_op->>'baseVersion' is null then
        raise exception 'Invalid data operation' using errcode = '22023';
    end if;
    if nullif(p_op->>'userId', '')::uuid is distinct from p_owner then raise exception 'Operation owner mismatch' using errcode = '42501'; end if;
    select * into s from data_recovery.owner_state where user_id = p_owner;
    select * into receipt from data_recovery.operation_receipts where user_id = p_owner and operation_receipts.operation_id = operation_scope.operation_id;
    if found then
        if receipt.request_hash <> request_hash then raise exception 'Operation ID reused with different content' using errcode = '22023'; end if;
        if (p_op->>'epoch')::bigint <> s.epoch then
            return jsonb_build_object('operationId', operation_id, 'status', 'stale_epoch', 'epoch', s.epoch, 'version', 0);
        end if;
        return receipt.result || case when receipt.result->>'status' = 'applied' then '{"status":"duplicate"}'::jsonb else '{}'::jsonb end;
    end if;
    if (p_op->>'epoch')::bigint <> s.epoch then reason := 'stale_epoch'; end if;
    if domain_name = 'journal' then
        if entity !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid journal date' using errcode = '22023'; end if;
        if exists(select 1 from jsonb_object_keys(p_op->'patch') key where key <> all(array['pnl','gross_pnl','commissions','locates','kf','notes','mentor_comment','ai_advice','daily_metrics'])) then
            raise exception 'Unsupported journal field' using errcode = '22023';
        end if;
        select to_jsonb(j), j.sync_version into current_row, v from public.journal_days j where j.user_id = p_owner and j.trade_date = entity::date for update;
        v := coalesce(v, 0); current_value := coalesce(current_row - array['id','user_id','created_at','updated_at','sync_version','trade_date'], '{}');
    elsif domain_name = 'trade' then
        if entity !~ '^\d{4}-\d{2}-\d{2}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            raise exception 'Invalid trade id' using errcode = '22023';
        end if;
        trade_date := split_part(entity, ':', 1)::date;
        trade_id := split_part(entity, ':', 2)::uuid;
        select payload, version into current_value, v from public.trades where user_id = p_owner and id = trade_id for update;
        v := coalesce(v, 0); current_value := coalesce(current_value, '{}'::jsonb); current_row := current_value;
    else
        if entity <> p_owner::text then raise exception 'Settings owner mismatch' using errcode = '42501'; end if;
        for k in select jsonb_object_keys(p_op->'patch') loop
            if k ~ '^(account_|registration|approved|blocked|role$|mentor_enabled$)' and not public.app_is_admin()
              and coalesce(auth.jwt()->>'role', '') <> 'service_role' then raise exception 'Protected account setting' using errcode = '42501'; end if;
        end loop;
        select coalesce(settings, '{}') into profile_settings from public.profiles where id = p_owner for update;
        if not found then raise exception 'Profile not found'; end if;
        select profile_settings || coalesce((
            select jsonb_object_agg(s.key, s.value) from public.user_settings s
            where s.user_id = p_owner and s.key in (select jsonb_object_keys(p_op->'patch'))
        ), '{}'::jsonb) into current_value;
        v := s.settings_version; current_row := current_value;
    end if;
    if reason is null and ((v = 0 and (p_op->>'baseVersion')::bigint > 0)
       or ((p_op->>'baseVersion')::bigint <> v and data_recovery.patch_conflicts(current_value, p_op->'base', p_op->'patch'))) then reason := 'conflict'; end if;
    if reason is not null then
        insert into data_recovery.data_conflicts(user_id, operation_id, domain, entity_id, base, patch, server_record, reason)
        values(p_owner, operation_id, domain_name, entity, p_op->'base', p_op->'patch', current_row, reason) returning id into conflict_id;
        result := jsonb_build_object('operationId', operation_id, 'status', reason, 'version', v, 'epoch', s.epoch, 'row', current_row, 'conflictId', conflict_id);
    else
        merged := data_recovery.merge_patch(current_value, p_op->'patch');
        perform set_config('app.data_operation_id', operation_id::text, true);
        perform set_config('app.data_source', 'operation', true);
        if domain_name = 'journal' then
            if (p_op->'patch'->'daily_metrics') ? 'trades' and jsonb_typeof(merged->'daily_metrics'->'trades') = 'array' then
                perform data_recovery.project_day_trades(p_owner, entity::date, merged->'daily_metrics'->'trades');
                merged := jsonb_set(merged, '{daily_metrics,trades}', '[]'::jsonb, true);
            end if;
            insert into public.journal_days as j(user_id, trade_date, pnl, gross_pnl, commissions, locates, kf, notes, mentor_comment, ai_advice, daily_metrics)
            values(p_owner, entity::date, (merged->>'pnl')::numeric, (merged->>'gross_pnl')::numeric, (merged->>'commissions')::numeric,
                (merged->>'locates')::numeric, (merged->>'kf')::numeric, merged->>'notes', merged->>'mentor_comment', merged->>'ai_advice', coalesce(merged->'daily_metrics', '{}'))
            on conflict(user_id, trade_date) do update set pnl = excluded.pnl, gross_pnl = excluded.gross_pnl, commissions = excluded.commissions,
                locates = excluded.locates, kf = excluded.kf, notes = excluded.notes, mentor_comment = excluded.mentor_comment, ai_advice = excluded.ai_advice, daily_metrics = excluded.daily_metrics
            returning to_jsonb(j), j.sync_version into current_row, v;
            current_row := data_recovery.without_trade_array(current_row);
        elsif domain_name = 'trade' then
            if coalesce(p_op->'patch'->>'deleted', '') = 'true' then
                update public.trades set deleted_at = now(), version = version + 1, updated_at = now()
                where user_id = p_owner and id = trade_id
                returning version into v;
                current_row := jsonb_build_object('id', trade_id, 'trade_date', trade_date, 'deleted_at', now(), 'version', v);
            else
                insert into public.trades as t (id, user_id, trade_date, ticker, side, entry_price, exit_price, shares, pnl, setup, payload, version)
                values (
                    trade_id, p_owner, trade_date,
                    left(coalesce(merged->>'symbol', merged->>'ticker', ''), 32),
                    left(coalesce(merged->>'type', merged->>'side', ''), 32),
                    data_recovery.json_num(merged, array['entry', 'entryPrice', 'openPrice']),
                    data_recovery.json_num(merged, array['exit', 'exitPrice', 'closePrice']),
                    data_recovery.json_num(merged, array['qty', 'shares', 'quantity']),
                    data_recovery.json_num(merged, array['net', 'pnl', 'profit']),
                    left(coalesce(merged->>'setup', merged->>'strategy', ''), 120),
                    merged || jsonb_build_object('id', trade_id),
                    1
                )
                on conflict (id) do update set
                    ticker = excluded.ticker, side = excluded.side, entry_price = excluded.entry_price, exit_price = excluded.exit_price,
                    shares = excluded.shares, pnl = excluded.pnl, setup = excluded.setup, payload = excluded.payload,
                    deleted_at = null, version = t.version + 1, updated_at = now()
                where t.user_id = p_owner
                returning version into v;
                current_row := jsonb_build_object('id', trade_id, 'trade_date', trade_date, 'version', v, 'payload', merged || jsonb_build_object('id', trade_id));
            end if;
        else
            for k in select unnest(heavy) loop
                if (p_op->'patch') ? k then
                    insert into public.user_settings as s (user_id, key, value, version)
                    values (p_owner, k, coalesce(merged->k, 'null'::jsonb), 1)
                    on conflict (user_id, key) do update set value = excluded.value, version = s.version + 1, updated_at = now();
                end if;
            end loop;
            merged := merged - heavy;
            if profile_settings is distinct from merged then
                update public.profiles set settings = merged, updated_at = now() where id = p_owner;
            end if;
            select settings_version into v from data_recovery.owner_state where user_id = p_owner;
            current_row := merged;
        end if;
        perform set_config('app.data_operation_id', '', true);
        result := jsonb_build_object('operationId', operation_id, 'status', 'applied', 'version', v, 'epoch', s.epoch, 'row', current_row);
    end if;
    insert into data_recovery.operation_receipts(user_id, operation_id, request_hash, result) values(p_owner, operation_id, request_hash, result);
    return result;
end $$;

create or replace function public.apply_data_operations(p_operations jsonb, p_atomic boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; op jsonb; result jsonb; results jsonb := '[]'; s data_recovery.owner_state;
    failed_status text; conflict_id uuid; failed_result jsonb; rolled_back_row jsonb; rolled_back_version bigint;
begin
    if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) > 2000 or octet_length(p_operations::text) > 8388608 then
        raise exception 'Operations must be an array of at most 2000 entries / 8 MiB' using errcode = '22023';
    end if;
    owner_id := data_recovery.authorize_owner(nullif(p_operations->0->>'userId', '')::uuid, true);
    if exists(select 1 from jsonb_array_elements(p_operations) x where nullif(x->>'userId', '')::uuid is distinct from owner_id) then
        raise exception 'A batch must have one owner' using errcode = '42501';
    end if;
    perform data_recovery.lock_owner(owner_id);
    perform data_recovery.assert_operations_safe(p_operations, owner_id);
    begin
        for op in select value from jsonb_array_elements(p_operations) loop
            result := data_recovery.apply_one(op, owner_id); results := results || jsonb_build_array(result);
            if p_atomic and result->>'status' in ('conflict', 'stale_epoch') then
                failed_status := result->>'status'; failed_result := result; raise exception 'Atomic operation conflict' using errcode = 'PT409';
            end if;
        end loop;
    exception when sqlstate 'PT409' then
        results := '[]';
        for op in select value from jsonb_array_elements(p_operations) loop
            rolled_back_row := null; rolled_back_version := 0;
            if op->>'domain' = 'journal' then
                select to_jsonb(j), j.sync_version into rolled_back_row, rolled_back_version
                from public.journal_days j where j.user_id = owner_id and j.trade_date = (op->>'entityId')::date;
            elsif op->>'domain' = 'trade' then
                select to_jsonb(t), t.version into rolled_back_row, rolled_back_version
                from public.trades t where t.user_id = owner_id and t.id = split_part(op->>'entityId', ':', 2)::uuid;
            else
                select p.settings, os.settings_version into rolled_back_row, rolled_back_version
                from public.profiles p join data_recovery.owner_state os on os.user_id = p.id where p.id = owner_id;
            end if;
            insert into data_recovery.data_conflicts(user_id, operation_id, domain, entity_id, base, patch, server_record, reason)
            values(owner_id, (op->>'operationId')::uuid, op->>'domain', op->>'entityId', op->'base', op->'patch', rolled_back_row, 'atomic_' || failed_status)
            returning id into conflict_id;
            result := jsonb_build_object('operationId', op->>'operationId', 'status', failed_status, 'epoch', failed_result->'epoch', 'version', coalesce(rolled_back_version, 0), 'row', rolled_back_row, 'conflictId', conflict_id, 'batchAtomic', true);
            insert into data_recovery.operation_receipts(user_id, operation_id, request_hash, result)
            values(owner_id, (op->>'operationId')::uuid, encode(sha256(convert_to(op::text, 'UTF8')), 'hex'), result) on conflict do nothing;
            results := results || jsonb_build_array(result);
        end loop;
    end;
    select * into s from data_recovery.owner_state where user_id = owner_id;
    return jsonb_build_object('results', results, 'epoch', s.epoch, 'cursor', s.cursor);
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
            select jsonb_object_agg(s.key, s.value) from public.user_settings s where s.user_id = owner_id
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

create or replace function public.get_data_sync_state(p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := data_recovery.authorize_owner(p_user_id, false); s data_recovery.owner_state; settings jsonb;
begin
    perform data_recovery.lock_owner(owner_id);
    select * into s from data_recovery.owner_state where user_id = owner_id;
    select coalesce(p.settings, '{}'::jsonb) || coalesce((
        select jsonb_object_agg(u.key, u.value) from public.user_settings u where u.user_id = owner_id
    ), '{}'::jsonb)
    into settings from public.profiles p where p.id = owner_id;
    return jsonb_build_object('epoch', s.epoch, 'cursor', s.cursor, 'settingsVersion', s.settings_version, 'settings', coalesce(settings, '{}'::jsonb));
end $$;

create or replace function public.get_app_bootstrap(
    target_user_id uuid default auth.uid(),
    date_from date default (date_trunc('month', current_date) - interval '1 month')::date,
    date_to date default (date_trunc('month', current_date) + interval '1 month - 1 day')::date
)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select jsonb_build_object(
        'profile', coalesce((
            select jsonb_build_object('id', p.id, 'nick', p.nick, 'role', p.role)
            from public.profiles p where p.id = target_user_id
        ), '{}'::jsonb),
        'journal_days', coalesce((
            select jsonb_agg(to_jsonb(j) order by j.trade_date)
            from public.journal_days j
            where j.user_id = target_user_id and j.trade_date between date_from and date_to
        ), '[]'::jsonb),
        'trades', coalesce((
            select jsonb_agg(jsonb_build_object('id', t.id, 'trade_date', t.trade_date, 'version', t.version, 'payload', t.payload) order by t.trade_date, t.created_at)
            from public.trades t
            where t.user_id = target_user_id and t.trade_date between date_from and date_to and t.deleted_at is null
        ), '[]'::jsonb),
        'server_time', now()
    );
$$;

create or replace function public.list_mechanical_signals(p_from date)
returns jsonb language sql stable security definer set search_path = public set statement_timeout = '8s' as $$
    select coalesce(jsonb_agg(row_payload), '[]'::jsonb)
    from (
        select jsonb_build_object(
            'user_id', tr.user_id,
            'trade_date', tr.trade_date,
            'trades', coalesce(jsonb_agg(jsonb_build_object(
                'symbol', coalesce(tr.payload->>'symbol', tr.payload->>'ticker', tr.ticker),
                'ticker', coalesce(tr.payload->>'ticker', tr.payload->>'symbol', tr.ticker),
                'opened', tr.payload->>'opened',
                'closed', tr.payload->>'closed',
                'type', coalesce(tr.payload->>'type', tr.side),
                'tradeType', tr.payload->>'tradeType',
                'setupType', tr.payload->>'setupType',
                'note', tr.payload->>'note',
                'notes', tr.payload->>'notes',
                'profitRisk', coalesce(tr.payload->'sheet'->>'profitRisk', tr.payload->>'profitRisk'),
                'kf', tr.payload->>'kf',
                'sheet', jsonb_build_object(
                    'profitRisk', tr.payload->'sheet'->>'profitRisk',
                    'tradeType', tr.payload->'sheet'->>'tradeType',
                    'exception', tr.payload->'sheet'->>'exception',
                    'exceptions', tr.payload->'sheet'->'exceptions',
                    'pv', tr.payload->'sheet'->>'pv',
                    'sheetRow', coalesce(tr.payload->'sheet'->>'sheetRow', tr.payload->'sheet'->>'rowNumber', tr.payload->'sheet'->>'row'),
                    'spreadsheetId', tr.payload->'sheet'->>'spreadsheetId',
                    'sourceFileId', tr.payload->'sheet'->>'sourceFileId',
                    'source', tr.payload->'sheet'->>'source'
                )
            )), '[]'::jsonb)
        ) as row_payload
        from public.trades tr
        where tr.deleted_at is null
          and tr.trade_date >= coalesce(p_from, current_date - 800)
          and coalesce(tr.payload->>'symbol', tr.payload->>'ticker', tr.ticker, '') <> ''
          and coalesce(tr.payload->'sheet'->>'profitRisk', tr.payload->>'profitRisk', tr.payload->>'kf') is not null
        group by tr.user_id, tr.trade_date
        order by tr.trade_date desc
        limit 2000
    ) days;
$$;

revoke all on function public.list_mechanical_signals(date) from public, anon, authenticated;
grant execute on function public.list_mechanical_signals(date) to service_role;

create or replace function public.upsert_trade_polygon_metrics(p_user_id uuid, p_trade_date date, p_ticker text, p_metrics jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare normalized_ticker text := upper(trim(p_ticker)); matched_count integer := 0;
begin
    if normalized_ticker !~ '^[A-Z0-9.\-\^=]{1,20}$' then raise exception 'Invalid ticker'; end if;
    update public.journal_days as day
    set daily_metrics = jsonb_set(coalesce(day.daily_metrics, '{}'::jsonb), '{tradePolygons}',
        coalesce(day.daily_metrics->'tradePolygons', '{}'::jsonb) || jsonb_build_object(normalized_ticker, p_metrics), true)
    where day.user_id = p_user_id and day.trade_date = p_trade_date;
    if not found then raise exception 'Journal day not found'; end if;
    update public.trades
    set payload = payload || jsonb_build_object('marketCriteria', p_metrics), version = version + 1, updated_at = now()
    where user_id = p_user_id and trade_date = p_trade_date and deleted_at is null
      and upper(trim(coalesce(payload->>'symbol', payload->>'ticker', ticker, ''))) = normalized_ticker;
    get diagnostics matched_count = row_count;
    return matched_count;
end $$;

revoke all on function public.upsert_trade_polygon_metrics(uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_trade_polygon_metrics(uuid, date, text, jsonb) to service_role;

update data_recovery.change_history
set new_record = jsonb_set(new_record, '{daily_metrics,trades}', '[]'::jsonb, true)
where domain = 'journal'
  and jsonb_typeof(new_record #> '{daily_metrics,trades}') = 'array'
  and jsonb_array_length(new_record #> '{daily_metrics,trades}') > 0;

alter table public.trades enable row level security;
alter table public.user_settings enable row level security;
drop policy if exists trades_select on public.trades;
drop policy if exists user_settings_select on public.user_settings;
create policy trades_select on public.trades for select to authenticated using (public.app_can_view_user(user_id));
create policy user_settings_select on public.user_settings for select to authenticated using (public.app_can_view_user(user_id));
revoke all on public.trades from public, anon, authenticated;
revoke all on public.user_settings from public, anon, authenticated;
grant select on public.trades to authenticated;
grant select on public.user_settings to authenticated;

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trades') then
            alter publication supabase_realtime add table public.trades;
        end if;
        if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_settings') then
            alter publication supabase_realtime add table public.user_settings;
        end if;
    end if;
end $$;

notify pgrst, 'reload schema';
commit;
