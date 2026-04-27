-- Mentors can see every trader's journal and move any trader between teams.
-- They still cannot change roles, delete accounts, or move mentors/admins.

CREATE OR REPLACE FUNCTION public.app_can_view_user(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT auth.uid() = target_user_id
        OR public.app_is_admin()
        OR public.app_is_mentor();
$$;

DROP POLICY IF EXISTS journal_days_insert_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_insert_owner_or_same_team_mentor
ON public.journal_days
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id OR public.app_is_admin() OR public.app_is_mentor());

DROP POLICY IF EXISTS journal_days_update_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_update_owner_or_same_team_mentor
ON public.journal_days
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id OR public.app_is_admin() OR public.app_is_mentor())
WITH CHECK (auth.uid() = user_id OR public.app_is_admin() OR public.app_is_mentor());

CREATE OR REPLACE FUNCTION public.mentor_move_trader_team(target_user_id UUID, target_team TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller public.profiles%ROWTYPE;
    target public.profiles%ROWTYPE;
    normalized_team TEXT;
BEGIN
    SELECT *
    INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF caller.role = 'admin' THEN
        normalized_team := NULLIF(BTRIM(COALESCE(target_team, '')), '');
        PERFORM set_config('app.telegram_profile_repair', 'on', TRUE);
        UPDATE public.profiles
        SET team = normalized_team,
            updated_at = NOW()
        WHERE id = target_user_id;
        RETURN;
    END IF;

    IF NOT (caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only mentors can move traders';
    END IF;

    SELECT *
    INTO target
    FROM public.profiles
    WHERE id = target_user_id;

    IF target.id IS NULL THEN
        RAISE EXCEPTION 'Target profile not found';
    END IF;

    IF target.id = caller.id THEN
        RAISE EXCEPTION 'Mentor cannot move own profile';
    END IF;

    IF target.role IN ('admin', 'mentor') OR target.mentor_enabled = TRUE THEN
        RAISE EXCEPTION 'Mentor can move traders only';
    END IF;

    normalized_team := NULLIF(BTRIM(COALESCE(target_team, '')), '');
    PERFORM set_config('app.telegram_profile_repair', 'on', TRUE);

    UPDATE public.profiles
    SET team = normalized_team,
        updated_at = NOW()
    WHERE id = target_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mentor_move_trader_team(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
