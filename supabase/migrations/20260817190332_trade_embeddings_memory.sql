create extension if not exists vector with schema extensions;

create table if not exists public.trade_embeddings (
    id uuid primary key default gen_random_uuid(),
    journal_day_id uuid not null references public.journal_days(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    trade_key text not null check (trade_key ~ '^[a-f0-9]{64}$'),
    trade_text text not null check (char_length(trade_text) between 20 and 8000),
    content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
    embedding extensions.vector(384) not null,
    embedding_model text not null default 'Supabase/gte-small',
    embedded_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (journal_day_id, trade_key)
);

create index if not exists trade_embeddings_user_day_idx on public.trade_embeddings (user_id, journal_day_id);
create index if not exists trade_embeddings_embedding_hnsw_idx
    on public.trade_embeddings using hnsw (embedding extensions.vector_cosine_ops);

alter table public.trade_embeddings enable row level security;
revoke all on table public.trade_embeddings from public, anon, authenticated;
grant select on table public.trade_embeddings to authenticated;

drop policy if exists trade_embeddings_select_owner on public.trade_embeddings;
create policy trade_embeddings_select_owner on public.trade_embeddings
    for select to authenticated
    using ((select auth.uid()) = user_id);

comment on table public.trade_embeddings is
    'Canonical per-trade semantic memory generated server-side from journal_days.daily_metrics.trades.';
