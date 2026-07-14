-- Allow authenticated users to compare aggregate trading analytics without
-- granting direct access to private journal text fields.

CREATE OR REPLACE FUNCTION public.get_stats_comparison_journal(target_user_id UUID)
RETURNS TABLE (
    user_id UUID,
    trade_date DATE,
    pnl NUMERIC,
    gross_pnl NUMERIC,
    commissions NUMERIC,
    locates NUMERIC,
    kf NUMERIC,
    daily_metrics JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT
        jd.user_id,
        jd.trade_date,
        jd.pnl,
        jd.gross_pnl,
        jd.commissions,
        jd.locates,
        jd.kf,
        COALESCE(jd.daily_metrics, '{}'::jsonb) - 'review_requests'
    FROM public.journal_days AS jd
    WHERE jd.user_id = target_user_id
    ORDER BY jd.trade_date ASC;
$$;

REVOKE ALL ON FUNCTION public.get_stats_comparison_journal(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stats_comparison_journal(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
