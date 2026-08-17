-- STRUM multi-device synchronization. Existing owner-scoped RLS remains authoritative.
do $$ begin
  alter publication supabase_realtime add table public.journal_days;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.daily_reviews;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ai_coach_insights;
exception when duplicate_object then null; end $$;
