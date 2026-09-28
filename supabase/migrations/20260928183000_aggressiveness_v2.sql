-- Aggressiveness v2. Version 1 rows stay in place.
-- A new formula inserts score_version 2 and does not update the old score.

alter table public.daily_market_regime
    add column if not exists market_data_through_date date,
    add column if not exists rule_score numeric(6,2),
    add column if not exists analog_score numeric(6,2),
    add column if not exists confidence numeric(6,2),
    add column if not exists small_micro_score numeric(6,2),
    add column if not exists breadth_score numeric(6,2),
    add column if not exists macro_score numeric(6,2),
    add column if not exists spy_3d numeric,
    add column if not exists spy_rv10 numeric,
    add column if not exists spy_distance_20d_high numeric,
    add column if not exists iwm_rs1 numeric,
    add column if not exists iwm_rs3 numeric,
    add column if not exists iwc_rs1 numeric,
    add column if not exists iwc_rs3 numeric,
    add column if not exists xbi_rs3 numeric,
    add column if not exists arkk_rs3 numeric,
    add column if not exists nyse_decliner_ratio numeric,
    add column if not exists nasdaq_decliner_ratio numeric,
    add column if not exists nyse_down_volume_share numeric,
    add column if not exists nasdaq_down_volume_share numeric,
    add column if not exists nyse_new_low_share numeric,
    add column if not exists nasdaq_new_low_share numeric,
    add column if not exists vix_3d numeric,
    add column if not exists us10y_1d_bp numeric,
    add column if not exists us10y_10d_bp numeric,
    add column if not exists oil_3d numeric,
    add column if not exists oil_10d numeric,
    add column if not exists analog_expected_r numeric,
    add column if not exists analog_positive_rate numeric,
    add column if not exists analog_sample_size integer,
    add column if not exists features jsonb,
    add column if not exists created_at timestamptz default now();

comment on table public.daily_market_regime is
    'Aggressiveness for mechanical pump-and-dump shorts. score_version 2 is fixed at the previous close. Mechanical results calibrate history only and are not an input for the current session. Do not overwrite an older score_version.';

create table if not exists public.daily_market_breadth (
    bar_date date primary key,
    provider text not null,
    nyse_advancers integer,
    nyse_decliners integer,
    nasdaq_advancers integer,
    nasdaq_decliners integer,
    nyse_up_volume numeric,
    nyse_down_volume numeric,
    nasdaq_up_volume numeric,
    nasdaq_down_volume numeric,
    nyse_new_highs integer,
    nyse_new_lows integer,
    nasdaq_new_highs integer,
    nasdaq_new_lows integer,
    missing_fields text[] not null default '{}',
    fetched_at timestamptz not null default now()
);

comment on table public.daily_market_breadth is
    'Exchange breadth diary. Null means the provider did not supply the field. Do not store a price proxy here.';

alter table public.daily_market_breadth enable row level security;

drop policy if exists daily_market_breadth_read on public.daily_market_breadth;
create policy daily_market_breadth_read on public.daily_market_breadth
    for select to authenticated
    using (true);

grant select on public.daily_market_breadth to authenticated;

create or replace function public.protect_daily_market_regime()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.date is distinct from old.date
        or new.score_version is distinct from old.score_version
        or new.base_score is distinct from old.base_score
        or new.micro_small_score is distinct from old.micro_small_score
        or new.speculative_score is distinct from old.speculative_score
        or new.broad_score is distinct from old.broad_score
        or new.stress_score is distinct from old.stress_score
        or new.narrow_penalty is distinct from old.narrow_penalty
        or new.meltup_penalty is distinct from old.meltup_penalty
        or new.info_through is distinct from old.info_through
        or new.calculated_at is distinct from old.calculated_at
    then
        raise exception 'historical aggressiveness score % version % is immutable', old.date, old.score_version;
    end if;

    if old.score_version >= 2 and (
        new.live_score is distinct from old.live_score
        or new.live_adjustment is distinct from old.live_adjustment
        or new.live_frozen is distinct from old.live_frozen
        or new.rule_score is distinct from old.rule_score
        or new.analog_score is distinct from old.analog_score
        or new.confidence is distinct from old.confidence
        or new.small_micro_score is distinct from old.small_micro_score
        or new.breadth_score is distinct from old.breadth_score
        or new.macro_score is distinct from old.macro_score
        or new.market_data_through_date is distinct from old.market_data_through_date
        or new.features is distinct from old.features
        or new.analog_expected_r is distinct from old.analog_expected_r
        or new.analog_positive_rate is distinct from old.analog_positive_rate
        or new.analog_sample_size is distinct from old.analog_sample_size
        or new.created_at is distinct from old.created_at
    ) then
        raise exception 'aggressiveness score % version % is immutable', old.date, old.score_version;
    end if;

    if old.mechanical_entries is not null and (
        new.mechanical_entries is distinct from old.mechanical_entries
        or new.mechanical_total_r is distinct from old.mechanical_total_r
        or new.mechanical_r_per_trade is distinct from old.mechanical_r_per_trade
        or new.mechanical_win_rate is distinct from old.mechanical_win_rate
        or new.mechanical_avg_winner is distinct from old.mechanical_avg_winner
        or new.mechanical_avg_loser is distinct from old.mechanical_avg_loser
    ) then
        raise exception 'stored mechanical results for % are immutable', old.date;
    end if;

    return new;
end;
$$;

revoke all on function public.protect_daily_market_regime() from public;
