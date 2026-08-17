insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-charts', 'trade-charts', false, 6291456, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.trade_multimodal_inputs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    journal_day_id uuid references public.journal_days(id) on delete cascade,
    trade_embedding_id uuid references public.trade_embeddings(id) on delete set null,
    trade_key text,
    audio_transcript text not null default '' check (char_length(audio_transcript) <= 8000),
    chart_image_url text not null default '' check (char_length(chart_image_url) <= 1200),
    vision_analysis text not null default '' check (char_length(vision_analysis) <= 8000),
    ai_confidence_score integer check (ai_confidence_score between 0 and 100),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists trade_multimodal_inputs_user_created_idx on public.trade_multimodal_inputs (user_id, created_at desc);
create index if not exists trade_multimodal_inputs_journal_day_idx on public.trade_multimodal_inputs (journal_day_id) where journal_day_id is not null;
create index if not exists trade_multimodal_inputs_embedding_idx on public.trade_multimodal_inputs (trade_embedding_id) where trade_embedding_id is not null;
alter table public.trade_multimodal_inputs enable row level security;
grant select, insert, update, delete on public.trade_multimodal_inputs to authenticated;
revoke all on public.trade_multimodal_inputs from anon;

create policy trade_multimodal_select_owner on public.trade_multimodal_inputs for select to authenticated using ((select auth.uid()) = user_id);
create policy trade_multimodal_insert_owner on public.trade_multimodal_inputs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy trade_multimodal_update_owner on public.trade_multimodal_inputs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy trade_multimodal_delete_owner on public.trade_multimodal_inputs for delete to authenticated using ((select auth.uid()) = user_id);

create policy trade_charts_select_owner on storage.objects for select to authenticated
using (bucket_id = 'trade-charts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy trade_charts_insert_owner on storage.objects for insert to authenticated
with check (bucket_id = 'trade-charts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy trade_charts_update_owner on storage.objects for update to authenticated
using (bucket_id = 'trade-charts' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'trade-charts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy trade_charts_delete_owner on storage.objects for delete to authenticated
using (bucket_id = 'trade-charts' and (storage.foldername(name))[1] = (select auth.uid())::text);
