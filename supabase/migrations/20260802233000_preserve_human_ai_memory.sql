-- Human-reviewed examples remain valid memory after a newer model version makes
-- their source row non-current. Automatic legacy labels are never admitted.
CREATE OR REPLACE FUNCTION public.match_ai_learning_examples(
    query_embedding extensions.vector(768),
    match_count INTEGER DEFAULT 5
)
RETURNS TABLE (id UUID, pattern_key TEXT, similarity DOUBLE PRECISION, source_snapshot JSONB, outcome JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
    SELECT e.id, COALESCE(e.reviewed_pattern_key, e.ai_pattern_key),
           1 - (e.embedding <=> query_embedding), e.source_snapshot, e.outcome
    FROM public.ai_learning_examples e
    WHERE e.embedding IS NOT NULL
      AND e.review_status IN ('approved', 'corrected')
      AND e.reviewed_by IS NOT NULL
      AND COALESCE(e.review_note, '') NOT LIKE '[auto]%'
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 10);
$$;

CREATE OR REPLACE FUNCTION public.match_ai_learning_examples_scoped(
    query_embedding extensions.vector(768), match_user_id UUID,
    match_count INTEGER DEFAULT 5, min_similarity DOUBLE PRECISION DEFAULT 0.45
)
RETURNS TABLE (id UUID, pattern_key TEXT, similarity DOUBLE PRECISION, source_snapshot JSONB, outcome JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
    SELECT e.id, COALESCE(e.reviewed_pattern_key, e.ai_pattern_key),
           1 - (e.embedding <=> query_embedding), e.source_snapshot, e.outcome
    FROM public.ai_learning_examples e
    WHERE e.embedding IS NOT NULL AND e.user_id = match_user_id
      AND e.review_status IN ('approved', 'corrected') AND e.reviewed_by IS NOT NULL
      AND COALESCE(e.review_note, '') NOT LIKE '[auto]%'
      AND 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 10);
$$;

CREATE OR REPLACE FUNCTION public.match_ai_learning_examples_holdout(
    query_embedding extensions.vector(768), match_user_id UUID,
    cutoff_trade_date DATE, excluded_example_id UUID DEFAULT NULL,
    match_count INTEGER DEFAULT 5, min_similarity DOUBLE PRECISION DEFAULT 0.45
)
RETURNS TABLE (id UUID, pattern_key TEXT, similarity DOUBLE PRECISION, source_snapshot JSONB, outcome JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
    SELECT e.id, COALESCE(e.reviewed_pattern_key, e.ai_pattern_key),
           1 - (e.embedding <=> query_embedding), e.source_snapshot, e.outcome
    FROM public.ai_learning_examples e
    WHERE e.embedding IS NOT NULL AND e.user_id = match_user_id
      AND e.review_status IN ('approved', 'corrected') AND e.reviewed_by IS NOT NULL
      AND COALESCE(e.review_note, '') NOT LIKE '[auto]%'
      AND (excluded_example_id IS NULL OR e.id <> excluded_example_id)
      AND (cutoff_trade_date IS NULL OR e.trade_date < cutoff_trade_date)
      AND 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 10);
$$;

REVOKE ALL ON FUNCTION public.match_ai_learning_examples(extensions.vector, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_learning_examples_scoped(extensions.vector, UUID, INTEGER, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_learning_examples_holdout(extensions.vector, UUID, DATE, UUID, INTEGER, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_learning_examples(extensions.vector, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_ai_learning_examples_scoped(extensions.vector, UUID, INTEGER, DOUBLE PRECISION) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_ai_learning_examples_holdout(extensions.vector, UUID, DATE, UUID, INTEGER, DOUBLE PRECISION) TO service_role;

NOTIFY pgrst, 'reload schema';
