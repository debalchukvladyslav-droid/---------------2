-- Optional AI request diagnostics.
-- Run this after the base schema if you want AI requests to be logged separately
-- and cleaned automatically by the frontend cleanup task.

CREATE TABLE IF NOT EXISTS ai_request_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    request_type TEXT NOT NULL DEFAULT 'gemini',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    used BOOLEAN NOT NULL DEFAULT FALSE,
    request_payload JSONB,
    response_preview TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_request_logs_user_created
    ON ai_request_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_request_logs_unused_created
    ON ai_request_logs(created_at)
    WHERE used = FALSE;

ALTER TABLE ai_request_logs DISABLE ROW LEVEL SECURITY;
