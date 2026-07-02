-- Open read-only profile viewing for every authenticated user.
-- Keep writes owner-only, with narrow mentor RPCs for review work.

CREATE OR REPLACE FUNCTION public.app_is_mentor()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid()
          AND (role = 'mentor' OR mentor_enabled = TRUE)
    );
$$;

CREATE OR REPLACE FUNCTION public.app_can_view_user(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT auth.uid() IS NOT NULL AND target_user_id IS NOT NULL;
$$;

DROP POLICY IF EXISTS journal_days_insert_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_insert_owner_or_same_team_mentor
ON public.journal_days
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS journal_days_update_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_update_owner_or_same_team_mentor
ON public.journal_days
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS storage_screenshots_read_owner_or_same_team_mentor ON storage.objects;
CREATE POLICY storage_screenshots_read_owner_or_same_team_mentor
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'screenshots'
    AND auth.uid() IS NOT NULL
);

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
    SELECT *
    INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NOT (caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only mentors can write mentor comments';
    END IF;

    IF target_user_id = caller.id THEN
        RAISE EXCEPTION 'Mentor comment is only for another profile';
    END IF;

    INSERT INTO public.journal_days (user_id, trade_date, mentor_comment, daily_metrics)
    VALUES (target_user_id, target_trade_date, COALESCE(comment_text, ''), '{}'::jsonb)
    ON CONFLICT (user_id, trade_date)
    DO UPDATE SET mentor_comment = EXCLUDED.mentor_comment;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_mentor_comment(UUID, DATE, TEXT) TO authenticated;

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
    path TEXT[];
BEGIN
    SELECT *
    INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NOT (caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only mentors can accept review requests';
    END IF;

    IF target_user_id = caller.id THEN
        RAISE EXCEPTION 'Review request acceptance is only for another profile';
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
        path := ARRAY['review_requests', 'by_screen', screen_path];
    ELSE
        path := ARRAY['review_requests', request_kind];
    END IF;

    slot := metrics #> path;
    IF slot IS NULL
        OR slot->>'status' <> 'pending'
        OR slot->>'mentor_user_id' <> caller.id::TEXT THEN
        RETURN FALSE;
    END IF;

    slot := jsonb_set(slot, ARRAY['status'], to_jsonb('accepted'::TEXT), TRUE);
    slot := jsonb_set(slot, ARRAY['accepted_at'], to_jsonb(NOW()::TEXT), TRUE);
    slot := jsonb_set(slot, ARRAY['accepted_by'], to_jsonb(COALESCE(caller.nick, '')::TEXT), TRUE);
    metrics := jsonb_set(metrics, path, slot, TRUE);

    UPDATE public.journal_days
    SET daily_metrics = metrics
    WHERE user_id = target_user_id
      AND trade_date = target_trade_date;

    RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_mentor_review_request(UUID, DATE, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
