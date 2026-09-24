-- Next-session aggressiveness. The base prediction for a version is insert-only.
-- Premarket fields may update. Historical versions are never rewritten as a newer formula.

create table if not exists public.mechanical_signal_normalized (
    source_import_id text primary key,
    trader_id text,
    ticker text not null,
    trading_date date not null,
    setup_type text,
    mechanical_result_r double precision not null,
    trader_result_r double precision,
    is_not_taken boolean not null default false,
    is_win boolean not null,
    metadata_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.ticker_day_outcome (
    trading_date date not null,
    ticker text not null,
    unique_traders integer not null,
    signal_count integer not null,
    median_r double precision,
    mean_r double precision,
    best_r double precision,
    worst_r double precision,
    worked boolean,
    hit_1r boolean,
    hit_2r boolean,
    hit_3r boolean,
    primary key (trading_date, ticker)
);

create table if not exists public.daily_short_edge (
    trading_date date primary key,
    dump_breadth double precision,
    median_ticker_r double precision,
    mean_ticker_r double precision,
    winner_median_r double precision,
    big_winner_rate_1r double precision,
    big_winner_rate_2r double precision,
    big_winner_rate_3r double precision,
    unique_tickers integer,
    signal_count integer,
    repeat_pressure double precision,
    entry_win_rate double precision,
    entry_mean_r double precision,
    actual_edge_score double precision,
    score_version text not null
);

create table if not exists public.daily_aggressiveness_prediction (
    target_date date not null,
    score_version text not null,
    feature_date date not null,
    market_leading_score double precision,
    lagged_mechanical_score double precision,
    transition_score double precision,
    base_prediction double precision,
    premarket_adjustment double precision,
    final_score double precision,
    regime_state text,
    confidence double precision,
    mode text,
    features jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (target_date, score_version)
);

alter table public.mechanical_signal_normalized enable row level security;
alter table public.ticker_day_outcome enable row level security;
alter table public.daily_short_edge enable row level security;
alter table public.daily_aggressiveness_prediction enable row level security;

drop policy if exists "Users can read mechanical signals" on public.mechanical_signal_normalized;
create policy "Users can read mechanical signals" on public.mechanical_signal_normalized for select to authenticated using (true);
drop policy if exists "Users can read ticker outcomes" on public.ticker_day_outcome;
create policy "Users can read ticker outcomes" on public.ticker_day_outcome for select to authenticated using (true);
drop policy if exists "Users can read daily short edge" on public.daily_short_edge;
create policy "Users can read daily short edge" on public.daily_short_edge for select to authenticated using (true);
drop policy if exists "Users can read next session predictions" on public.daily_aggressiveness_prediction;
create policy "Users can read next session predictions" on public.daily_aggressiveness_prediction for select to authenticated using (true);

create or replace function public.protect_next_session_base()
returns trigger language plpgsql as $$
begin
    if new.base_prediction is distinct from old.base_prediction
        or new.market_leading_score is distinct from old.market_leading_score
        or new.feature_date is distinct from old.feature_date
        or new.features is distinct from old.features then
        raise exception 'base next-session prediction is immutable for this version';
    end if;
    new.updated_at = now();
    return new;
end $$;

drop trigger if exists protect_next_session_base on public.daily_aggressiveness_prediction;
create trigger protect_next_session_base
    before update on public.daily_aggressiveness_prediction
    for each row execute function public.protect_next_session_base();
