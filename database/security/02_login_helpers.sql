-- Narrow public helpers for the auth screen.
-- These let the frontend log in by nick and show team choices without exposing
-- the whole profiles table to anon users.

CREATE OR REPLACE FUNCTION public.login_email_for_nick(target_nick TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT email
    FROM public.profiles
    WHERE nick = LOWER(TRIM(target_nick))
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.public_team_names()
RETURNS TABLE(name TEXT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT DISTINCT team AS name
    FROM public.profiles
    WHERE team IS NOT NULL AND BTRIM(team) <> ''
    UNION
    SELECT teams.name
    FROM public.teams
    WHERE teams.name IS NOT NULL AND BTRIM(teams.name) <> ''
    ORDER BY name;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (
        id,
        nick,
        email,
        first_name,
        last_name,
        team
    )
    VALUES (
        NEW.id,
        LOWER(COALESCE(NEW.raw_user_meta_data->>'nick', NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1))),
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
        COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
        COALESCE(
            NULLIF(BTRIM(COALESCE(NEW.raw_user_meta_data->>'team', '')), ''),
            'Без куща'
        )
    )
    ON CONFLICT (id) DO UPDATE
    SET
        email = EXCLUDED.email,
        first_name = COALESCE(NULLIF(public.profiles.first_name, ''), EXCLUDED.first_name),
        last_name = COALESCE(NULLIF(public.profiles.last_name, ''), EXCLUDED.last_name),
        team = COALESCE(NULLIF(BTRIM(public.profiles.team), ''), EXCLUDED.team),
        updated_at = NOW();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_auth_user_profile();

DROP TRIGGER IF EXISTS on_auth_user_updated_profile ON auth.users;
CREATE TRIGGER on_auth_user_updated_profile
AFTER UPDATE OF email, raw_user_meta_data ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_auth_user_profile();

GRANT EXECUTE ON FUNCTION public.login_email_for_nick(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_team_names() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
