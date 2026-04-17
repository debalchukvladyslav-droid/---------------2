-- Сесії входу через deep-link t.me/bot?start=... (обробка в Edge telegram-auth + webhook Telegram).
-- Виконайте в SQL Editor Supabase після деплою Edge.

CREATE TABLE IF NOT EXISTS public.telegram_login_sessions (
    start_token TEXT PRIMARY KEY,
    return_base TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    claim_token TEXT UNIQUE,
    access_token TEXT,
    refresh_token TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_login_sessions_claim
    ON public.telegram_login_sessions(claim_token)
    WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_login_sessions_expires
    ON public.telegram_login_sessions(expires_at);

ALTER TABLE public.telegram_login_sessions ENABLE ROW LEVEL SECURITY;

-- Доступ лише з service_role (Edge Functions). Анонімний клієнт не читає таблицю.

-- Webhook Telegram (після деплою Edge). Kong часто вимагає apikey у URL:
-- https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<project>.supabase.co/functions/v1/telegram-auth%3Fapikey%3D<SUPABASE_ANON_KEY>
-- Опційно: secret_token у setWebhook = значення secret TELEGRAM_WEBHOOK_SECRET у Edge.
