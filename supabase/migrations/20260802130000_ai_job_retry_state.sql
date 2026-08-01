ALTER TABLE public.ai_learning_jobs
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
