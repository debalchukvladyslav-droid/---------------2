-- Evidence-first AI learning: model output is provisional until a human reviews it.
ALTER TABLE public.ai_learning_runs DROP CONSTRAINT IF EXISTS ai_learning_runs_trigger_type_check;
ALTER TABLE public.ai_learning_runs ADD CONSTRAINT ai_learning_runs_trigger_type_check
CHECK (trigger_type IN ('manual', 'cron', 'job', 'evaluation'));

ALTER TABLE public.ai_learning_examples
    ADD COLUMN IF NOT EXISTS outcome_group TEXT,
    ADD COLUMN IF NOT EXISTS chart_summary TEXT,
    ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS decision_source TEXT NOT NULL DEFAULT 'model',
    ADD COLUMN IF NOT EXISTS actual_model_name TEXT;

ALTER TABLE public.screenshots
    ADD COLUMN IF NOT EXISTS ticker TEXT,
    ADD COLUMN IF NOT EXISTS trade_key TEXT,
    ADD COLUMN IF NOT EXISTS screenshot_role TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pixel_width INTEGER,
    ADD COLUMN IF NOT EXISTS pixel_height INTEGER,
    ADD COLUMN IF NOT EXISTS byte_size BIGINT,
    ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'unchecked',
    ADD COLUMN IF NOT EXISTS quality_details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.screenshots DROP CONSTRAINT IF EXISTS screenshots_role_check;
ALTER TABLE public.screenshots ADD CONSTRAINT screenshots_role_check
CHECK (screenshot_role IN ('pre_entry', 'entry', 'exit', 'post_exit', 'earliest_unknown', 'latest_unknown', 'unknown'));
CREATE INDEX IF NOT EXISTS screenshots_trade_link_idx
    ON public.screenshots(user_id, trade_key, captured_at) WHERE trade_key IS NOT NULL;

ALTER TABLE public.ai_learning_examples
    DROP CONSTRAINT IF EXISTS ai_learning_examples_outcome_group_check;
ALTER TABLE public.ai_learning_examples
    ADD CONSTRAINT ai_learning_examples_outcome_group_check
    CHECK (outcome_group IS NULL OR outcome_group IN ('loss', 'profit', 'neutral'));

-- Earlier autonomous approvals must not be treated as ground truth.
UPDATE public.ai_learning_examples
SET review_status = 'pending',
    reviewed_pattern_key = NULL,
    reviewed_at = NULL,
    reviewed_by = NULL,
    embedding = NULL,
    decision_source = 'model',
    updated_at = NOW()
WHERE review_status = 'approved'
  AND review_note LIKE '[auto]%';

CREATE TABLE IF NOT EXISTS public.ai_evaluation_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    example_id UUID REFERENCES public.ai_learning_examples(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    expected_pattern_key TEXT NOT NULL,
    expected_features JSONB NOT NULL DEFAULT '{}'::jsonb,
    trade_date DATE,
    dataset_split TEXT NOT NULL DEFAULT 'test'
        CHECK (dataset_split IN ('train', 'validation', 'test')),
    reviewer_note TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ai_evaluation_cases
    ADD COLUMN IF NOT EXISTS trade_date DATE,
    ADD COLUMN IF NOT EXISTS dataset_split TEXT NOT NULL DEFAULT 'test';
UPDATE public.ai_evaluation_cases c
SET trade_date = e.trade_date
FROM public.ai_learning_examples e
WHERE c.example_id = e.id AND c.trade_date IS NULL;

CREATE TABLE IF NOT EXISTS public.ai_evaluation_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES public.ai_evaluation_cases(id) ON DELETE CASCADE,
    run_id UUID REFERENCES public.ai_learning_runs(id) ON DELETE SET NULL,
    prompt_version TEXT NOT NULL,
    model_name TEXT NOT NULL,
    predicted_pattern_key TEXT,
    confidence NUMERIC,
    exact_match BOOLEAN NOT NULL DEFAULT FALSE,
    evidence_complete BOOLEAN NOT NULL DEFAULT FALSE,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_evaluation_cases_active_idx
    ON public.ai_evaluation_cases(active, dataset_split, user_id, trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS ai_evaluation_cases_example_key
    ON public.ai_evaluation_cases(example_id);
CREATE INDEX IF NOT EXISTS ai_evaluation_results_case_idx
    ON public.ai_evaluation_results(case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_learning_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'processing', 'completed', 'failed', 'stopped')),
    include_saved_examples BOOLEAN NOT NULL DEFAULT TRUE,
    processed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    batch_count INTEGER NOT NULL DEFAULT 0,
    last_run_id UUID REFERENCES public.ai_learning_runs(id) ON DELETE SET NULL,
    last_error TEXT,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_learning_jobs_status_idx ON public.ai_learning_jobs(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS public.ai_user_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    dimension TEXT NOT NULL,
    pattern_key TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    outcome_sample_size INTEGER NOT NULL,
    wins INTEGER NOT NULL,
    losses INTEGER NOT NULL,
    win_rate DOUBLE PRECISION,
    baseline_win_rate DOUBLE PRECISION,
    lift DOUBLE PRECISION,
    average_pnl DOUBLE PRECISION,
    reliability TEXT NOT NULL CHECK (reliability IN ('exploratory', 'moderate', 'strong')),
    statistics JSONB NOT NULL DEFAULT '{}'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, dimension, pattern_key)
);
CREATE INDEX IF NOT EXISTS ai_user_patterns_user_idx ON public.ai_user_patterns(user_id, active, sample_size DESC);

ALTER TABLE public.ai_evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_learning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_user_patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_evaluation_cases_admin_all ON public.ai_evaluation_cases;
CREATE POLICY ai_evaluation_cases_admin_all ON public.ai_evaluation_cases
FOR ALL TO authenticated USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
DROP POLICY IF EXISTS ai_evaluation_results_admin_all ON public.ai_evaluation_results;
CREATE POLICY ai_evaluation_results_admin_all ON public.ai_evaluation_results
FOR ALL TO authenticated USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
DROP POLICY IF EXISTS ai_learning_jobs_admin_all ON public.ai_learning_jobs;
CREATE POLICY ai_learning_jobs_admin_all ON public.ai_learning_jobs
FOR ALL TO authenticated USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
DROP POLICY IF EXISTS ai_user_patterns_own_or_admin ON public.ai_user_patterns;
CREATE POLICY ai_user_patterns_own_or_admin ON public.ai_user_patterns
FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.app_is_admin());
DROP POLICY IF EXISTS ai_user_patterns_admin_write ON public.ai_user_patterns;
CREATE POLICY ai_user_patterns_admin_write ON public.ai_user_patterns
FOR ALL TO authenticated USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());

CREATE OR REPLACE FUNCTION public.claim_ai_learning_job()
RETURNS SETOF public.ai_learning_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE claimed_id UUID;
BEGIN
    SELECT id INTO claimed_id
    FROM public.ai_learning_jobs
    WHERE status = 'running'
       OR (status = 'processing' AND heartbeat_at < NOW() - INTERVAL '10 minutes')
    ORDER BY started_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF claimed_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
    UPDATE public.ai_learning_jobs
    SET status = 'processing', heartbeat_at = NOW(), updated_at = NOW()
    WHERE id = claimed_id
    RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_ai_learning_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_learning_job() TO service_role;

CREATE OR REPLACE FUNCTION public.match_ai_learning_examples(
    query_embedding extensions.vector(768),
    match_count INTEGER DEFAULT 5
)
RETURNS TABLE (id UUID, pattern_key TEXT, similarity DOUBLE PRECISION, source_snapshot JSONB, outcome JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
    SELECT e.id,
           COALESCE(e.reviewed_pattern_key, e.ai_pattern_key),
           1 - (e.embedding <=> query_embedding),
           e.source_snapshot,
           e.outcome
    FROM public.ai_learning_examples e
    WHERE e.embedding IS NOT NULL
      AND e.is_current
      AND e.review_status IN ('approved', 'corrected')
      AND e.reviewed_by IS NOT NULL
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 10);
$$;

REVOKE ALL ON FUNCTION public.match_ai_learning_examples(extensions.vector, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_learning_examples(extensions.vector, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.match_ai_learning_examples_scoped(
    query_embedding extensions.vector(768),
    match_user_id UUID,
    match_count INTEGER DEFAULT 5,
    min_similarity DOUBLE PRECISION DEFAULT 0.45
)
RETURNS TABLE (id UUID, pattern_key TEXT, similarity DOUBLE PRECISION, source_snapshot JSONB, outcome JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
    SELECT e.id,
           COALESCE(e.reviewed_pattern_key, e.ai_pattern_key),
           1 - (e.embedding <=> query_embedding) AS similarity,
           e.source_snapshot,
           e.outcome
    FROM public.ai_learning_examples e
    WHERE e.embedding IS NOT NULL
      AND e.user_id = match_user_id
      AND e.is_current
      AND e.review_status IN ('approved', 'corrected')
      AND e.reviewed_by IS NOT NULL
      AND 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 10);
$$;

REVOKE ALL ON FUNCTION public.match_ai_learning_examples_scoped(extensions.vector, UUID, INTEGER, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_learning_examples_scoped(extensions.vector, UUID, INTEGER, DOUBLE PRECISION) TO service_role;

CREATE OR REPLACE FUNCTION public.match_ai_learning_examples_holdout(
    query_embedding extensions.vector(768),
    match_user_id UUID,
    cutoff_trade_date DATE,
    excluded_example_id UUID DEFAULT NULL,
    match_count INTEGER DEFAULT 5,
    min_similarity DOUBLE PRECISION DEFAULT 0.45
)
RETURNS TABLE (id UUID, pattern_key TEXT, similarity DOUBLE PRECISION, source_snapshot JSONB, outcome JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
    SELECT e.id,
           COALESCE(e.reviewed_pattern_key, e.ai_pattern_key),
           1 - (e.embedding <=> query_embedding) AS similarity,
           e.source_snapshot,
           e.outcome
    FROM public.ai_learning_examples e
    WHERE e.embedding IS NOT NULL
      AND e.user_id = match_user_id
      AND e.is_current
      AND e.review_status IN ('approved', 'corrected')
      AND e.reviewed_by IS NOT NULL
      AND (excluded_example_id IS NULL OR e.id <> excluded_example_id)
      AND (cutoff_trade_date IS NULL OR e.trade_date < cutoff_trade_date)
      AND 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 10);
$$;
REVOKE ALL ON FUNCTION public.match_ai_learning_examples_holdout(extensions.vector, UUID, DATE, UUID, INTEGER, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_learning_examples_holdout(extensions.vector, UUID, DATE, UUID, INTEGER, DOUBLE PRECISION) TO service_role;

NOTIFY pgrst, 'reload schema';
