CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.polygon_worker_wake_tokens (
    token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.polygon_worker_wake_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.polygon_worker_wake_tokens FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_polygon_worker_wake(wake_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE claimed UUID;
BEGIN
    DELETE FROM public.polygon_worker_wake_tokens
    WHERE token = wake_token AND expires_at > NOW()
    RETURNING token INTO claimed;
    DELETE FROM public.polygon_worker_wake_tokens WHERE expires_at <= NOW();
    RETURN claimed IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_polygon_worker_wake(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_polygon_worker_wake(UUID) TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'polygon-durable-worker';

SELECT cron.schedule(
    'polygon-durable-worker',
    '* * * * *',
    $cron$
    WITH wake AS (
        INSERT INTO public.polygon_worker_wake_tokens DEFAULT VALUES
        RETURNING token
    )
    SELECT net.http_post(
        url := 'https://gijarvlerztfggxhuvow.supabase.co/functions/v1/market-best-exits',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('action', 'cron-worker', 'wakeToken', wake.token, 'requestedAt', now()),
        timeout_milliseconds := 55000
    ) AS request_id
    FROM wake;
    $cron$
);
