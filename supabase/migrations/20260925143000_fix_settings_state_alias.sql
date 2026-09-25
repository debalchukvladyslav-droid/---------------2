-- The sync-state variable s shadowed user_settings, so s.key failed with
-- record "s" has no field "key". Keep the trade date in row_trade_date.

create or replace function data_recovery.apply_one(p_op jsonb, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
<<operation_scope>>
declare operation_id uuid := (p_op->>'operationId')::uuid; domain_name text := p_op->>'domain'; entity text := p_op->>'entityId';
    current_row jsonb; current_value jsonb; merged jsonb; v bigint := 0; s data_recovery.owner_state; receipt data_recovery.operation_receipts;
    result jsonb; conflict_id uuid; request_hash text := encode(sha256(convert_to(p_op::text, 'UTF8')), 'hex'); reason text; k text;
    trade_id uuid; row_trade_date date; profile_settings jsonb; heavy text[] := array['tickers','screenMeta','sheetRows','cumulativeSheetRows','unassignedImages','aiChatHistory','aiSavedChats','weeklyComments','monthlyDayloss'];
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
        row_trade_date := split_part(entity, ':', 1)::date;
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
            select jsonb_object_agg(us.key, us.value) from public.user_settings us
            where us.user_id = p_owner and us.key in (select jsonb_object_keys(p_op->'patch'))
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
                current_row := jsonb_build_object('id', trade_id, 'trade_date', row_trade_date, 'deleted_at', now(), 'version', v);
            else
                insert into public.trades as t (id, user_id, trade_date, ticker, side, entry_price, exit_price, shares, pnl, setup, payload, version)
                values (
                    trade_id, p_owner, row_trade_date,
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
                current_row := jsonb_build_object('id', trade_id, 'trade_date', row_trade_date, 'version', v, 'payload', merged || jsonb_build_object('id', trade_id));
            end if;
        else
            for k in select unnest(heavy) loop
                if (p_op->'patch') ? k then
                    insert into public.user_settings as us (user_id, key, value, version)
                    values (p_owner, k, coalesce(merged->k, 'null'::jsonb), 1)
                    on conflict (user_id, key) do update set value = excluded.value, version = us.version + 1, updated_at = now();
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
