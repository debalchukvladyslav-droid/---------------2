-- Delete a team reliably. Participants are moved to the default team
-- (stored as NULL in profiles), and the optional teams row is removed too.

CREATE OR REPLACE FUNCTION public.delete_team(target_team TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller public.profiles%ROWTYPE;
    normalized_team TEXT;
BEGIN
    normalized_team := NULLIF(BTRIM(COALESCE(target_team, '')), '');

    IF normalized_team IS NULL OR normalized_team = 'Без куща' THEN
        RAISE EXCEPTION 'Default team cannot be deleted';
    END IF;

    SELECT *
    INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NOT (caller.role = 'admin' OR caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only admins or mentors can delete teams';
    END IF;

    IF caller.role <> 'admin' AND COALESCE(caller.team, 'Без куща') <> normalized_team THEN
        RAISE EXCEPTION 'Mentor can delete only own team';
    END IF;

    PERFORM set_config('app.telegram_profile_repair', 'on', TRUE);

    UPDATE public.profiles
    SET team = NULL,
        updated_at = NOW()
    WHERE team = normalized_team;

    DELETE FROM public.teams
    WHERE name = normalized_team;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_team(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
