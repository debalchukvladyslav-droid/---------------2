begin;
-- These tables contain replaceable provider data. Keep existing rows readable;
-- refuse additional cache writes before they crowd out journal/recovery data.
-- A statement trigger checks once per batch, including an ON CONFLICT update.
create function data_recovery.guard_market_cache_budget()
returns trigger language plpgsql set search_path='' as $$
declare cache_bytes bigint;
begin
    perform pg_advisory_xact_lock(1643228917,2);
    select sum(pg_total_relation_size(c)) into cache_bytes
        from unnest(array['public.polygon_bars'::regclass,'public.polygon_range_fetches'::regclass,
            'public.market_time_price_cache'::regclass,'public.market_best_exit_cache'::regclass,
            'public.market_intraday_cache_status'::regclass]) c;
    if pg_database_size(current_database())>=430000000 or cache_bytes>=80000000 then
        raise exception 'MARKET_CACHE_BUDGET_LIMIT: derived cache writes are temporarily suspended'
            using errcode='PT507';
    end if;
    return null;
end $$;
revoke all on function data_recovery.guard_market_cache_budget() from public,anon,authenticated;
create trigger free_market_cache_budget before insert or update on public.polygon_bars for each statement execute function data_recovery.guard_market_cache_budget();
create trigger free_market_cache_budget before insert or update on public.polygon_range_fetches for each statement execute function data_recovery.guard_market_cache_budget();
create trigger free_market_cache_budget before insert or update on public.market_time_price_cache for each statement execute function data_recovery.guard_market_cache_budget();
create trigger free_market_cache_budget before insert or update on public.market_best_exit_cache for each statement execute function data_recovery.guard_market_cache_budget();
create trigger free_market_cache_budget before insert or update on public.market_intraday_cache_status for each statement execute function data_recovery.guard_market_cache_budget();
commit;
