-- Shared per-minute Polygon prices for hypothetical exits. No user data is stored.
create table if not exists public.market_time_price_cache (
    symbol text not null check (symbol ~ '^[A-Z]{1,10}$'),
    trade_date date not null,
    target_minute smallint not null check (target_minute >= 540 and target_minute <= 720),
    close_price numeric not null check (close_price > 0),
    price_at timestamptz not null,
    provider text not null default 'polygon',
    updated_at timestamptz not null default now(),
    primary key (symbol, trade_date, target_minute)
);

alter table public.market_time_price_cache enable row level security;
revoke all on table public.market_time_price_cache from public, anon, authenticated;
grant all on table public.market_time_price_cache to service_role;
create index if not exists market_time_price_cache_date_idx
    on public.market_time_price_cache (trade_date);
