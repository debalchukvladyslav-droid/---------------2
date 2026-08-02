ALTER TABLE public.ai_learning_jobs
    ADD COLUMN IF NOT EXISTS remaining_count INTEGER;

COMMENT ON COLUMN public.ai_learning_jobs.remaining_count IS
    'Candidates still eligible for the active prompt version after the latest completed batch.';
