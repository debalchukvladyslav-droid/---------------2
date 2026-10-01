-- Raw SHS desk snapshots for the current session only.
-- The bot feed does not return a full past day, so noon and 15:50 New York
-- captures are kept here and, when a folder is configured, copied to Drive.
-- Service role writes them. The journal tables are not touched.

create table public.shs_desk_archives (
    trade_date date not null,
    slot text not null check (slot in ('1200', '1550')),
    captured_at timestamptz not null default now(),
    summary jsonb not null default '{}'::jsonb,
    payload jsonb not null,
    drive_file_id text,
    primary key (trade_date, slot)
);

alter table public.shs_desk_archives enable row level security;
revoke all on table public.shs_desk_archives from public, anon, authenticated;

create table if not exists public.shs_archive_wake_tokens (
    token uuid primary key default gen_random_uuid(),
    expires_at timestamptz not null default now() + interval '10 minutes',
    created_at timestamptz not null default now()
);

alter table public.shs_archive_wake_tokens enable row level security;
revoke all on public.shs_archive_wake_tokens from public, anon, authenticated;

create or replace function public.claim_shs_archive_wake(wake_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare claimed uuid;
begin
    delete from public.shs_archive_wake_tokens
    where token = wake_token and expires_at > now()
    returning token into claimed;
    delete from public.shs_archive_wake_tokens where expires_at <= now();
    return claimed is not null;
end;
$$;

revoke all on function public.claim_shs_archive_wake(uuid) from public, anon, authenticated;
grant execute on function public.claim_shs_archive_wake(uuid) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname in (
    'shs-desk-archive-noon-edt',
    'shs-desk-archive-noon-est',
    'shs-desk-archive-close-edt',
    'shs-desk-archive-close-est'
);

select cron.schedule(
    'shs-desk-archive-noon-edt',
    '0 16 * * 1-5',
    $cron$
    with wake as (
        insert into public.shs_archive_wake_tokens default values
        returning token
    )
    select net.http_post(
        url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=shs-archive',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('source', 'supabase-cron', 'wakeToken', wake.token, 'requested_at', now()),
        timeout_milliseconds := 180000
    ) as request_id
    from wake;
    $cron$
);

select cron.schedule(
    'shs-desk-archive-noon-est',
    '0 17 * * 1-5',
    $cron$
    with wake as (
        insert into public.shs_archive_wake_tokens default values
        returning token
    )
    select net.http_post(
        url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=shs-archive',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('source', 'supabase-cron', 'wakeToken', wake.token, 'requested_at', now()),
        timeout_milliseconds := 180000
    ) as request_id
    from wake;
    $cron$
);

select cron.schedule(
    'shs-desk-archive-close-edt',
    '50 19 * * 1-5',
    $cron$
    with wake as (
        insert into public.shs_archive_wake_tokens default values
        returning token
    )
    select net.http_post(
        url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=shs-archive',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('source', 'supabase-cron', 'wakeToken', wake.token, 'requested_at', now()),
        timeout_milliseconds := 180000
    ) as request_id
    from wake;
    $cron$
);

select cron.schedule(
    'shs-desk-archive-close-est',
    '50 20 * * 1-5',
    $cron$
    with wake as (
        insert into public.shs_archive_wake_tokens default values
        returning token
    )
    select net.http_post(
        url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=shs-archive',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('source', 'supabase-cron', 'wakeToken', wake.token, 'requested_at', now()),
        timeout_milliseconds := 180000
    ) as request_id
    from wake;
    $cron$
);
