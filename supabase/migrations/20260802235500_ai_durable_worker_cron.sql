CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.ai_worker_wake_tokens (
    token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ai_worker_wake_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_worker_wake_tokens FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_ai_worker_wake(wake_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE claimed UUID;
BEGIN
    DELETE FROM public.ai_worker_wake_tokens
    WHERE token = wake_token AND expires_at > NOW()
    RETURNING token INTO claimed;
    DELETE FROM public.ai_worker_wake_tokens WHERE expires_at <= NOW();
    RETURN claimed IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_worker_wake(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_worker_wake(UUID) TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'ai-learning-durable-worker';

SELECT cron.schedule(
    'ai-learning-durable-worker',
    '*/2 * * * *',
    $cron$
    WITH wake AS (
        INSERT INTO public.ai_worker_wake_tokens DEFAULT VALUES
        RETURNING token
    )
    SELECT net.http_post(
        url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=ai-learning&mode=job-only',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('source', 'supabase-cron', 'wakeToken', wake.token, 'requested_at', now()),
        timeout_milliseconds := 280000
    ) AS request_id
    FROM wake;
    $cron$
);
