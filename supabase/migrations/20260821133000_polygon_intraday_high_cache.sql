alter table public.market_time_price_cache
    add column if not exists high_price numeric,
    add column if not exists high_at timestamptz;

