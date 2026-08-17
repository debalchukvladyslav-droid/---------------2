create table if not exists public.daily_reviews (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    trade_date date not null,
    status text not null default 'ready' check (status in ('ready','partial','failed')),
    debrief text not null check (char_length(debrief) between 20 and 16000),
    strengths jsonb not null default '[]'::jsonb,
    mistakes jsonb not null default '[]'::jsonb,
    next_session_rules jsonb not null default '[]'::jsonb,
    evidence jsonb not null default '{}'::jsonb,
    model_name text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, trade_date)
);

create index if not exists daily_reviews_user_date_idx on public.daily_reviews (user_id, trade_date desc);
alter table public.daily_reviews enable row level security;
revoke all on table public.daily_reviews from public, anon, authenticated;
grant select on table public.daily_reviews to authenticated;
create policy daily_reviews_select_owner on public.daily_reviews for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.match_trade_embeddings(
    query_embedding extensions.vector(384), match_count integer default 20, filter_user_id uuid default null
) returns table (id uuid, journal_day_id uuid, user_id uuid, trade_key text, trade_text text, similarity double precision)
language sql stable security invoker set search_path = '' as $$
    select te.id, te.journal_day_id, te.user_id, te.trade_key, te.trade_text,
           1 - (te.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
    from public.trade_embeddings te
    where te.user_id = coalesce((select auth.uid()), filter_user_id)
    order by te.embedding OPERATOR(extensions.<=>) query_embedding
    limit least(greatest(match_count, 1), 50)
$$;
revoke all on function public.match_trade_embeddings(extensions.vector, integer, uuid) from public, anon;
grant execute on function public.match_trade_embeddings(extensions.vector, integer, uuid) to authenticated, service_role;
