-- Stop redundant copies at their source. No existing history is deleted.
begin;

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

create or replace function data_recovery.project_day_trades(p_owner uuid, p_date date, p_trades jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare elem jsonb; ordinal integer; trade_id uuid; ids uuid[] := '{}'; existing_count integer;
begin
    if jsonb_typeof(p_trades) <> 'array' then return; end if;
    select count(*) into existing_count from public.trades
    where user_id = p_owner and trade_date = p_date and deleted_at is null;
    if jsonb_array_length(p_trades) = 0 and existing_count > 0 then return; end if;
    perform set_config('app.bulk_trade_projection', '1', true);
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
        where t.user_id = p_owner and (t.payload is distinct from excluded.payload or t.deleted_at is not null);
    end loop;
    update public.trades
    set deleted_at = now(), version = version + 1, updated_at = now()
    where user_id = p_owner and trade_date = p_date and deleted_at is null and not (id = any(ids));
    perform set_config('app.bulk_trade_projection', '', true);
end $$;


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
    if (before_row - array['updated_at','sync_version']) is not distinct from (after_row - array['updated_at','sync_version']) then return coalesce(new, old); end if;
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


-- Source workers need an epoch, not every large setting in the account.
create or replace function public.get_source_sync_state(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    perform data_recovery.lock_owner(p_user_id);
    return (select jsonb_build_object('epoch', epoch, 'cursor', cursor)
            from data_recovery.owner_state where user_id = p_user_id);
end $$;
revoke all on function public.get_source_sync_state(uuid) from public, anon, authenticated;
grant execute on function public.get_source_sync_state(uuid) to service_role;

-- Preserve the durable two-minute wakeup for active jobs, without calling
-- Vercel 21,600 times/month when there is no work.
do $block$ begin
    if exists(select 1 from pg_extension where extname='pg_cron') then
        perform cron.unschedule(jobid) from cron.job where jobname='ai-learning-durable-worker';
        perform cron.schedule('ai-learning-durable-worker', '*/2 * * * *', $cron$
            with wake as (
                insert into public.ai_worker_wake_tokens(token)
                select gen_random_uuid()
                where exists(select 1 from public.ai_learning_jobs where status='running')
                returning token
            )
            select net.http_post(
                url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=ai-learning&mode=job-only',
                headers := jsonb_build_object('Content-Type','application/json'),
                body := jsonb_build_object('source','supabase-cron','wakeToken',wake.token),
                timeout_milliseconds := 280000)
            from wake;
        $cron$);
    end if;
end $block$;
notify pgrst, 'reload schema';
commit;
