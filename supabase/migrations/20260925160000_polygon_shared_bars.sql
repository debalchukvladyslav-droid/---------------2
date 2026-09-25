-- Shared Polygon bars for every user. A finished range is stored once;
-- later requests for the same or a narrower range are served from here.
create table if not exists public.polygon_bars (
    symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.:_-]{0,20}$'),
    granularity text not null check (granularity in ('minute', 'day')),
    bar_ms bigint not null,
    open double precision not null,
    high double precision not null,
    low double precision not null,
    close double precision not null,
    volume double precision,
    vwap double precision,
    transactions integer,
    primary key (symbol, granularity, bar_ms)
);

create table if not exists public.polygon_range_fetches (
    symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.:_-]{0,20}$'),
    granularity text not null check (granularity in ('minute', 'day')),
    range_start bigint not null,
    range_end bigint not null,
    bar_count integer not null check (bar_count >= 0),
    fetched_at timestamptz not null default now(),
    primary key (symbol, granularity, range_start, range_end),
    check (range_start <= range_end)
);

create index if not exists polygon_range_fetches_cover_idx
    on public.polygon_range_fetches (symbol, granularity, range_start, range_end);

alter table public.polygon_bars enable row level security;
alter table public.polygon_range_fetches enable row level security;
revoke all on table public.polygon_bars from public, anon, authenticated;
revoke all on table public.polygon_range_fetches from public, anon, authenticated;
grant all on table public.polygon_bars to service_role;
grant all on table public.polygon_range_fetches to service_role;

create or replace function public.polygon_bars_between(
    p_symbol text,
    p_granularity text,
    p_from bigint,
    p_to bigint
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        't', bar_ms,
        'o', open,
        'h', high,
        'l', low,
        'c', close,
        'v', volume,
        'vw', vwap,
        'n', transactions
    )) order by bar_ms), '[]'::jsonb)
    from public.polygon_bars
    where symbol = p_symbol
      and granularity = p_granularity
      and bar_ms >= p_from
      and bar_ms <= p_to;
$$;

revoke all on function public.polygon_bars_between(text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.polygon_bars_between(text, text, bigint, bigint) to service_role;
