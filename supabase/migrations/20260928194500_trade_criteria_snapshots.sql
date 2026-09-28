-- Immutable entry-time market criteria for one trade and one user.
-- A complete snapshot is not replaced by a later automatic calculation.

create table if not exists public.trade_criteria_snapshots (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    trade_id text not null check (char_length(trade_id) between 1 and 80),
    trade_date date not null,
    ticker text not null check (ticker ~ '^[A-Z0-9.\-]{1,15}$'),
    entry_at timestamptz not null,
    atr14 double precision,
    avg_vol14 double precision,
    day_volume double precision,
    vol_play14 double precision,
    atr_play14 double precision,
    session_high double precision,
    session_low double precision,
    last_candle_at timestamptz,
    high_low_session_start text not null default '09:30' check (high_low_session_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    volume_session_start text not null default '04:00' check (volume_session_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    provider text not null default 'massive' check (provider = 'massive'),
    adjusted boolean not null default true check (adjusted = true),
    completeness text not null check (completeness in ('complete', 'incomplete', 'unavailable')),
    fetch_status text not null check (fetch_status in ('ok', 'partial', 'unavailable', 'delayed', 'rate_limited', 'forbidden', 'missing_history', 'error')),
    status_detail text not null default '',
    calculation_version integer not null default 1 check (calculation_version > 0),
    calculated_at timestamptz not null default now(),
    source_meta jsonb not null default '{}'::jsonb,
    unique (user_id, trade_id, entry_at, calculation_version)
);

create index if not exists trade_criteria_snapshots_user_date_idx
    on public.trade_criteria_snapshots (user_id, trade_date desc);

alter table public.trade_criteria_snapshots enable row level security;

revoke all on table public.trade_criteria_snapshots from public, anon, authenticated;
grant select on table public.trade_criteria_snapshots to authenticated;
grant all on table public.trade_criteria_snapshots to service_role;

drop policy if exists trade_criteria_snapshots_select on public.trade_criteria_snapshots;
create policy trade_criteria_snapshots_select
on public.trade_criteria_snapshots
for select
to authenticated
using (public.app_can_view_user(user_id));
