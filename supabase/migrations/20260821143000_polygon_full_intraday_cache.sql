alter table public.market_time_price_cache
    add column if not exists open_price numeric,
    add column if not exists low_price numeric,
    add column if not exists volume numeric,
    add column if not exists vwap numeric,
    add column if not exists transactions bigint;

create table if not exists public.market_intraday_cache_status (
    symbol text not null check (symbol ~ '^[A-Z]{1,10}$'),
    trade_date date not null,
    from_minute smallint not null default 540,
    to_minute smallint not null default 720,
    bar_count smallint not null default 0,
    cache_version smallint not null default 1,
    provider text not null default 'polygon',
    fetched_at timestamptz not null default now(),
    primary key (symbol, trade_date)
);

alter table public.market_intraday_cache_status enable row level security;
revoke all on table public.market_intraday_cache_status from public, anon, authenticated;
grant all on table public.market_intraday_cache_status to service_role;

