-- Browser errors from other accounts, with the clicks that led to them.
-- The API writes through the service role. Only an admin can read the rows.

create table public.client_error_reports (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    happened_at timestamptz,
    fingerprint text not null,
    kind text not null,
    message text not null,
    stack text,
    page text,
    tab text,
    location text,
    scenario jsonb not null default '[]'::jsonb,
    user_id uuid,
    nick text,
    email text,
    user_agent text,
    source_hash text,
    notified_at timestamptz
);

create index client_error_reports_created_at_idx
    on public.client_error_reports (created_at desc);

create index client_error_reports_fingerprint_notified_idx
    on public.client_error_reports (fingerprint, notified_at desc);

alter table public.client_error_reports enable row level security;

revoke all on table public.client_error_reports from public, anon, authenticated;
grant select on table public.client_error_reports to authenticated;

create policy client_error_reports_admin_select
    on public.client_error_reports
    for select
    to authenticated
    using (public.app_is_admin());
