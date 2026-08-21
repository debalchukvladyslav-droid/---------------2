-- Global Polygon queue shared by every journal account. The cache itself contains
-- no user data: one symbol/date result is reused by all traders.
create table if not exists public.market_low_jobs (
    symbol text not null check (symbol ~ '^[A-Z]{1,10}$'),
    trade_date date not null,
    status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
    attempts smallint not null default 0,
    next_attempt_at timestamptz not null default now(),
    attempted_at timestamptz,
    last_error text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (symbol, trade_date)
);

alter table public.market_low_jobs enable row level security;
revoke all on table public.market_low_jobs from public, anon, authenticated;
grant all on table public.market_low_jobs to service_role;
create index if not exists market_low_jobs_pending_idx
    on public.market_low_jobs (next_attempt_at, created_at)
    where status in ('pending', 'failed');

create or replace function public.claim_market_low_jobs(max_jobs integer default 5)
returns table(symbol text, trade_date date)
language plpgsql
security invoker
set search_path = public
as $$
declare
    available_slots integer;
begin
    -- Serialize claims across all Edge Function instances/accounts.
    perform pg_advisory_xact_lock(hashtext('polygon_market_low_global_rate'));
    update public.market_low_jobs
       set status = 'pending', updated_at = now()
     where status = 'processing' and attempted_at < now() - interval '3 minutes';
    select greatest(0, least(5, max_jobs) - count(*))::integer
      into available_slots
      from public.market_low_jobs
     where attempted_at >= now() - interval '1 minute';
    if available_slots = 0 then return; end if;
    return query
    with claimed as (
        select job.symbol, job.trade_date
          from public.market_low_jobs job
         where job.status in ('pending', 'failed')
           and job.next_attempt_at <= now()
         order by job.next_attempt_at, job.created_at
         for update skip locked
         limit available_slots
    ), updated as (
        update public.market_low_jobs job
           set status = 'processing', attempts = job.attempts + 1,
               attempted_at = now(), updated_at = now(), last_error = ''
          from claimed
         where job.symbol = claimed.symbol and job.trade_date = claimed.trade_date
        returning job.symbol, job.trade_date
    )
    select updated.symbol, updated.trade_date from updated;
end;
$$;

revoke all on function public.claim_market_low_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_market_low_jobs(integer) to service_role;
