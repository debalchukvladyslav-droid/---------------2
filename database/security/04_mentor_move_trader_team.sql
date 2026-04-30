-- Allow mentors to move traders/admins to another team from the admin panel,
-- without granting full profile administration.

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

    IF target.role = 'mentor' OR target.mentor_enabled = TRUE THEN
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
