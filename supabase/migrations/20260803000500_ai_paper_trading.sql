CREATE TABLE IF NOT EXISTS public.ai_paper_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    learning_example_id UUID REFERENCES public.ai_learning_examples(id) ON DELETE SET NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ticker TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('LONG', 'SHORT', 'SKIP')),
    pattern_key TEXT NOT NULL,
    confidence NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    decision JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_cutoff_at TIMESTAMPTZ NOT NULL,
    entry_price NUMERIC,
    stop_price NUMERIC,
    target_price NUMERIC,
    resolved_at TIMESTAMPTZ,
    outcome_r NUMERIC,
    outcome_source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_paper_signal_no_future_source CHECK (source_cutoff_at <= observed_at),
    CONSTRAINT ai_paper_signal_prices_complete CHECK (
        action = 'SKIP' OR (entry_price IS NOT NULL AND stop_price IS NOT NULL AND target_price IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS ai_paper_signals_user_observed_idx
    ON public.ai_paper_signals (user_id, observed_at DESC);

ALTER TABLE public.ai_paper_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_paper_signals_owner_read ON public.ai_paper_signals;
CREATE POLICY ai_paper_signals_owner_read ON public.ai_paper_signals
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS ai_paper_signals_owner_insert ON public.ai_paper_signals;
CREATE POLICY ai_paper_signals_owner_insert ON public.ai_paper_signals
    FOR INSERT WITH CHECK (auth.uid() = user_id AND resolved_at IS NULL AND outcome_r IS NULL);

DROP POLICY IF EXISTS ai_paper_signals_owner_update ON public.ai_paper_signals;
CREATE POLICY ai_paper_signals_owner_update ON public.ai_paper_signals
    FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
