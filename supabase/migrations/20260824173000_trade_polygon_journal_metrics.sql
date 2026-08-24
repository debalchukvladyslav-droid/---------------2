CREATE OR REPLACE FUNCTION public.upsert_trade_polygon_metrics(
    p_user_id UUID,
    p_trade_date DATE,
    p_ticker TEXT,
    p_metrics JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    normalized_ticker TEXT := upper(trim(p_ticker));
    matched_count INTEGER := 0;
BEGIN
    IF normalized_ticker !~ '^[A-Z0-9.\-\^=]{1,20}$' THEN
        RAISE EXCEPTION 'Invalid ticker';
    END IF;

    UPDATE public.journal_days AS day
    SET daily_metrics = jsonb_set(
        jsonb_set(
            COALESCE(day.daily_metrics, '{}'::jsonb),
            '{tradePolygons}',
            COALESCE(day.daily_metrics->'tradePolygons', '{}'::jsonb)
                || jsonb_build_object(normalized_ticker, p_metrics),
            true
        ),
        '{trades}',
        COALESCE((
            SELECT jsonb_agg(
                CASE
                    WHEN upper(trim(COALESCE(trade->>'symbol', trade->>'ticker', ''))) = normalized_ticker
                    THEN trade || jsonb_build_object('marketCriteria', p_metrics)
                    ELSE trade
                END
                ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(day.daily_metrics->'trades', '[]'::jsonb))
                WITH ORDINALITY AS rows(trade, ordinal)
        ), '[]'::jsonb),
        true
    ), updated_at = now()
    WHERE day.user_id = p_user_id
      AND day.trade_date = p_trade_date;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Journal day not found';
    END IF;

    SELECT count(*)::INTEGER
    INTO matched_count
    FROM public.journal_days AS day,
         jsonb_array_elements(COALESCE(day.daily_metrics->'trades', '[]'::jsonb)) AS trade
    WHERE day.user_id = p_user_id
      AND day.trade_date = p_trade_date
      AND upper(trim(COALESCE(trade->>'symbol', trade->>'ticker', ''))) = normalized_ticker;

    RETURN matched_count;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_trade_polygon_metrics(UUID, DATE, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_trade_polygon_metrics(UUID, DATE, TEXT, JSONB) TO service_role;
