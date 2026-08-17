create table if not exists public.ai_feedback (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 insight_id uuid references public.ai_coach_insights(id) on delete cascade, rating smallint not null check (rating in (-1,1)),
 correction text check (char_length(correction) <= 2000), context jsonb not null default '{}'::jsonb,
 training_status text not null default 'pending' check (training_status in ('pending','reviewed','accepted','rejected','exported')),
 reviewed_by uuid references public.profiles(id), reviewed_at timestamptz, created_at timestamptz not null default now(), unique(user_id,insight_id));
alter table public.ai_feedback enable row level security;
grant select,insert,update on public.ai_feedback to authenticated; revoke all on public.ai_feedback from anon;
create policy ai_feedback_select_own on public.ai_feedback for select to authenticated using ((select auth.uid())=user_id);
create policy ai_feedback_insert_own on public.ai_feedback for insert to authenticated with check ((select auth.uid())=user_id and reviewed_by is null and training_status='pending');
create policy ai_feedback_update_own_pending on public.ai_feedback for update to authenticated using ((select auth.uid())=user_id and training_status='pending') with check ((select auth.uid())=user_id and reviewed_by is null and training_status='pending');
create index if not exists ai_feedback_training_queue_idx on public.ai_feedback(training_status,created_at) where training_status='pending';
