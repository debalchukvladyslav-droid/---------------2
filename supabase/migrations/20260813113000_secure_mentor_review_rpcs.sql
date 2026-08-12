-- Restore mentor-review RPCs that existed in legacy database/security scripts
-- but were missing from the formal migration chain. Also close the stats RPC's
-- SECURITY DEFINER ownership bypass before execute privileges are hardened.

CREATE OR REPLACE FUNCTION public.save_mentor_comment(
    target_user_id UUID,
    target_trade_date DATE,
    comment_text TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller public.profiles%ROWTYPE;
BEGIN
    SELECT * INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT public.app_is_approved() THEN
        RAISE EXCEPTION 'Account is not approved';
    END IF;
    IF NOT (caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only mentors can write mentor comments';
    END IF;
    IF target_user_id IS NULL OR target_trade_date IS NULL OR target_user_id = caller.id THEN
        RAISE EXCEPTION 'Mentor comment requires another profile and a trade date';
    END IF;

    INSERT INTO public.journal_days (user_id, trade_date, mentor_comment, daily_metrics)
    VALUES (target_user_id, target_trade_date, COALESCE(comment_text, ''), '{}'::jsonb)
    ON CONFLICT (user_id, trade_date)
    DO UPDATE SET mentor_comment = EXCLUDED.mentor_comment;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_mentor_review_request(
    target_user_id UUID,
    target_trade_date DATE,
    request_kind TEXT,
    screen_path TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller public.profiles%ROWTYPE;
    metrics JSONB;
    slot JSONB;
    request_path TEXT[];
BEGIN
    SELECT * INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT public.app_is_approved() THEN
        RAISE EXCEPTION 'Account is not approved';
    END IF;
    IF NOT (caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only mentors can accept review requests';
    END IF;
    IF target_user_id IS NULL OR target_trade_date IS NULL OR target_user_id = caller.id THEN
        RAISE EXCEPTION 'Review acceptance requires another profile and a trade date';
    END IF;
    IF request_kind IS NULL OR request_kind NOT IN ('screens_general', 'calendar_profit', 'screen_item') THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(daily_metrics, '{}'::jsonb)
    INTO metrics
    FROM public.journal_days
    WHERE user_id = target_user_id
      AND trade_date = target_trade_date
    FOR UPDATE;

    IF metrics IS NULL THEN
        RETURN FALSE;
    END IF;

    IF request_kind = 'screen_item' THEN
        IF COALESCE(screen_path, '') = '' THEN
            RETURN FALSE;
        END IF;
        request_path := ARRAY['review_requests', 'by_screen', screen_path];
    ELSE
        request_path := ARRAY['review_requests', request_kind];
    END IF;

    slot := metrics #> request_path;
    IF slot IS NULL
        OR slot->>'status' <> 'pending'
        OR slot->>'mentor_user_id' <> caller.id::TEXT
    THEN
        RETURN FALSE;
    END IF;

    slot := jsonb_set(slot, ARRAY['status'], to_jsonb('accepted'::TEXT), TRUE);
    slot := jsonb_set(slot, ARRAY['accepted_at'], to_jsonb(NOW()::TEXT), TRUE);
    slot := jsonb_set(slot, ARRAY['accepted_by'], to_jsonb(COALESCE(caller.nick, '')::TEXT), TRUE);
    metrics := jsonb_set(metrics, request_path, slot, TRUE);

    UPDATE public.journal_days
    SET daily_metrics = metrics
    WHERE user_id = target_user_id
      AND trade_date = target_trade_date;

    RETURN TRUE;
END;
$$;

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
      AND public.app_can_view_user(target_user_id)
    ORDER BY jd.trade_date ASC;
$$;

REVOKE ALL ON FUNCTION public.save_mentor_comment(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_mentor_review_request(UUID, DATE, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_stats_comparison_journal(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_mentor_comment(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_mentor_review_request(UUID, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_stats_comparison_journal(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
