-- Backfill the gold set from genuinely human-reviewed examples after the
-- evidence-first tables exist. Model-only and legacy [auto] decisions stay out.
INSERT INTO public.ai_evaluation_cases (
    example_id, user_id, expected_pattern_key, expected_features,
    trade_date, reviewer_note, active, created_by, updated_at
)
SELECT e.id,
       e.user_id,
       e.reviewed_pattern_key,
       COALESCE(e.source_snapshot->'aiFeatures', '{}'::jsonb),
       e.trade_date,
       e.review_note,
       TRUE,
       e.reviewed_by,
       NOW()
FROM public.ai_learning_examples e
WHERE e.is_current
  AND e.review_status IN ('approved', 'corrected')
  AND e.reviewed_by IS NOT NULL
  AND e.reviewed_pattern_key IS NOT NULL
  AND COALESCE(e.review_note, '') NOT LIKE '[auto]%'
ON CONFLICT (example_id) DO UPDATE SET
    expected_pattern_key = EXCLUDED.expected_pattern_key,
    expected_features = EXCLUDED.expected_features,
    trade_date = EXCLUDED.trade_date,
    reviewer_note = EXCLUDED.reviewer_note,
    active = TRUE,
    updated_at = NOW();

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY trade_date, created_at, id) AS row_number,
           COUNT(*) OVER (PARTITION BY user_id) AS total
    FROM public.ai_evaluation_cases
    WHERE active
), assigned AS (
    SELECT id,
           CASE
               WHEN total < 5 THEN 'test'
               WHEN row_number <= GREATEST(1, FLOOR(total * 0.70)::INTEGER) THEN 'train'
               WHEN row_number <= LEAST(
                   total - 1,
                   GREATEST(1, FLOOR(total * 0.70)::INTEGER)
                     + GREATEST(1, FLOOR(total * 0.15)::INTEGER)
               ) THEN 'validation'
               ELSE 'test'
           END AS dataset_split
    FROM ranked
)
UPDATE public.ai_evaluation_cases c
SET dataset_split = assigned.dataset_split,
    updated_at = NOW()
FROM assigned
WHERE c.id = assigned.id;

NOTIFY pgrst, 'reload schema';
