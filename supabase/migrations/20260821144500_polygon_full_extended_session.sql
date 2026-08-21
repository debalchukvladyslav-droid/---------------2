alter table public.market_time_price_cache
    drop constraint if exists market_time_price_cache_target_minute_check;

alter table public.market_time_price_cache
    add constraint market_time_price_cache_target_minute_check
    check (target_minute between 240 and 1200);

