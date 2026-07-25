CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.bots
    ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

UPDATE public.bots
SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex')
WHERE api_key IS NOT NULL
  AND api_key <> ''
  AND api_key_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_api_key_hash
    ON public.bots(api_key_hash)
    WHERE api_key_hash IS NOT NULL;

DROP INDEX IF EXISTS public.idx_bots_api_key;

UPDATE public.bots SET api_key = NULL WHERE api_key IS NOT NULL;

NOTIFY pgrst, 'reload schema';
