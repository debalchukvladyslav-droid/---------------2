-- Rename a team and move all profiles from the old team name to the new one.

CREATE OR REPLACE FUNCTION public.rename_team(old_team TEXT, new_team TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller public.profiles%ROWTYPE;
    old_name TEXT;
    new_name TEXT;
BEGIN
    old_name := NULLIF(BTRIM(COALESCE(old_team, '')), '');
    new_name := NULLIF(BTRIM(COALESCE(new_team, '')), '');

    IF old_name IS NULL OR new_name IS NULL THEN
        RAISE EXCEPTION 'Team names are required';
    END IF;

    IF old_name = 'Без куща' OR new_name = 'Без куща' THEN
        RAISE EXCEPTION 'Default team cannot be renamed or used as target';
    END IF;

    IF old_name = new_name THEN
        RETURN;
    END IF;

    SELECT *
    INTO caller
    FROM public.profiles
    WHERE id = auth.uid();

    IF caller.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NOT (caller.role = 'admin' OR caller.role = 'mentor' OR caller.mentor_enabled = TRUE) THEN
        RAISE EXCEPTION 'Only admins or mentors can rename teams';
    END IF;

    IF caller.role <> 'admin' AND COALESCE(caller.team, 'Без куща') <> old_name THEN
        RAISE EXCEPTION 'Mentor can rename only own team';
    END IF;

    IF EXISTS (SELECT 1 FROM public.profiles WHERE team = new_name)
        OR EXISTS (SELECT 1 FROM public.teams WHERE name = new_name)
    THEN
        RAISE EXCEPTION 'Target team already exists';
    END IF;

    PERFORM set_config('app.telegram_profile_repair', 'on', TRUE);

    UPDATE public.profiles
    SET team = new_name,
        updated_at = NOW()
    WHERE team = old_name;

    DELETE FROM public.teams
    WHERE name = old_name;

    INSERT INTO public.teams (name)
    VALUES (new_name)
    ON CONFLICT (name) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rename_team(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
