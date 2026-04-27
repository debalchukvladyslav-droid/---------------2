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

CREATE OR REPLACE FUNCTION public.app_protect_profile_privileged_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() = 'service_role' OR current_setting('app.telegram_profile_repair', TRUE) = 'on' THEN
        RETURN NEW;
    END IF;

    IF public.app_is_admin() THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.role := 'trader';
        NEW.mentor_enabled := FALSE;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        NEW.role := OLD.role;
        NEW.mentor_enabled := OLD.mentor_enabled;
        NEW.team := OLD.team;
        NEW.nick := OLD.nick;
        NEW.email := OLD.email;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    derived_nick TEXT;
    derived_email TEXT;
    merged_settings JSONB;
    is_telegram BOOLEAN;
BEGIN
    is_telegram := COALESCE(NEW.raw_user_meta_data->>'auth_provider', NEW.app_metadata->>'provider') = 'telegram';

    derived_nick := LOWER(
        COALESCE(
            NULLIF(BTRIM(NEW.raw_user_meta_data->>'nick'), ''),
            NULLIF(BTRIM(NEW.raw_user_meta_data->>'display_name'), ''),
            NULLIF(BTRIM(NEW.raw_user_meta_data->>'telegram_username'), ''),
            SPLIT_PART(NEW.email, '@', 1)
        )
    );
    derived_nick := REGEXP_REPLACE(derived_nick, '[^a-z0-9_.]', '', 'g');
    derived_nick := REGEXP_REPLACE(derived_nick, '\.{2,}', '.', 'g');
    IF derived_nick = '' THEN
        derived_nick := SUBSTR(LOWER(REPLACE(NEW.id::TEXT, '-', '')), 1, 32);
    END IF;

    IF is_telegram THEN
        derived_email := derived_nick || '@tradejournal.tg';
        merged_settings := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('auth_provider', 'telegram');
    ELSE
        derived_email := NEW.email;
        merged_settings := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('auth_provider', 'email');
    END IF;

    INSERT INTO public.profiles (
        id,
        nick,
        email,
        first_name,
        last_name,
        team,
        settings
    )
    VALUES (
        NEW.id,
        derived_nick,
        derived_email,
        COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
        COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
        COALESCE(
            NULLIF(BTRIM(COALESCE(NEW.raw_user_meta_data->>'team', '')), ''),
            'Без куща'
        ),
        merged_settings
    )
    ON CONFLICT (id) DO UPDATE
    SET
        nick = CASE
            WHEN is_telegram AND public.profiles.nick ~ '^tg_?[0-9]+$'
            THEN EXCLUDED.nick
            ELSE public.profiles.nick
        END,
        email = EXCLUDED.email,
        first_name = COALESCE(NULLIF(public.profiles.first_name, ''), EXCLUDED.first_name),
        last_name = COALESCE(NULLIF(public.profiles.last_name, ''), EXCLUDED.last_name),
        team = COALESCE(NULLIF(BTRIM(public.profiles.team), ''), EXCLUDED.team),
        settings = COALESCE(public.profiles.settings, '{}'::jsonb) || EXCLUDED.settings,
        updated_at = NOW();

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.repair_my_telegram_profile()
RETURNS TABLE(id UUID, nick TEXT, email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    derived_nick TEXT;
    derived_email TEXT;
BEGIN
    SELECT REGEXP_REPLACE(
        REGEXP_REPLACE(
            LOWER(
                COALESCE(
                    NULLIF(BTRIM(u.raw_user_meta_data->>'nick'), ''),
                    NULLIF(BTRIM(u.raw_user_meta_data->>'display_name'), ''),
                    NULLIF(BTRIM(u.raw_user_meta_data->>'telegram_username'), ''),
                    NULLIF(BTRIM(p.first_name), ''),
                    NULLIF(BTRIM(u.raw_user_meta_data->>'first_name'), ''),
                    SPLIT_PART(u.email, '@', 1)
                )
            ),
            '[^a-z0-9_.]',
            '',
            'g'
        ),
        '\.{2,}',
        '.',
        'g'
    )
    INTO derived_nick
    FROM auth.users u
    JOIN public.profiles p ON p.id = u.id
    WHERE u.id = auth.uid()
      AND (
          COALESCE(u.raw_user_meta_data->>'auth_provider', u.raw_app_meta_data->>'provider') = 'telegram'
          OR u.raw_user_meta_data ? 'telegram_id'
          OR p.nick ~ '^tg_?[0-9]+$'
      )
    LIMIT 1;

    IF derived_nick IS NULL OR derived_nick = '' OR derived_nick ~ '^tg_?[0-9]+$' THEN
        RETURN;
    END IF;

    derived_email := derived_nick || '@tradejournal.tg';
    PERFORM set_config('app.telegram_profile_repair', 'on', TRUE);

    UPDATE public.profiles p
    SET
        nick = CASE
            WHEN p.nick ~ '^tg_?[0-9]+$' THEN derived_nick
            ELSE p.nick
        END,
        email = derived_email,
        settings = COALESCE(p.settings, '{}'::jsonb) || jsonb_build_object(
            'auth_provider', 'telegram',
            'nick', derived_nick,
            'display_name', derived_nick
        ),
        updated_at = NOW()
    WHERE p.id = auth.uid()
    RETURNING p.id, p.nick, p.email
    INTO id, nick, email;

    RETURN NEXT;
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
GRANT EXECUTE ON FUNCTION public.repair_my_telegram_profile() TO authenticated;

DO $$
DECLARE
    has_profile_guard BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_profiles_protect_privileged_fields'
          AND tgrelid = 'public.profiles'::regclass
          AND NOT tgisinternal
    )
    INTO has_profile_guard;

    IF has_profile_guard THEN
        ALTER TABLE public.profiles DISABLE TRIGGER trg_profiles_protect_privileged_fields;
    END IF;

    UPDATE public.profiles p
    SET
        nick = REGEXP_REPLACE(
            REGEXP_REPLACE(
                LOWER(
                    COALESCE(
                        NULLIF(BTRIM(u.raw_user_meta_data->>'nick'), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'display_name'), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'telegram_username'), ''),
                        p.nick
                    )
                ),
                '[^a-z0-9_.]',
                '',
                'g'
            ),
            '\.{2,}',
            '.',
            'g'
        ),
        email = REGEXP_REPLACE(
            REGEXP_REPLACE(
                LOWER(
                    COALESCE(
                        NULLIF(BTRIM(u.raw_user_meta_data->>'nick'), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'display_name'), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'telegram_username'), ''),
                        p.nick
                    )
                ),
                '[^a-z0-9_.]',
                '',
                'g'
            ),
            '\.{2,}',
            '.',
            'g'
        ) || '@tradejournal.tg',
        settings = COALESCE(p.settings, '{}'::jsonb)
            || COALESCE(u.raw_user_meta_data, '{}'::jsonb)
            || jsonb_build_object('auth_provider', 'telegram'),
        updated_at = NOW()
    FROM auth.users u
    WHERE p.id = u.id
      AND COALESCE(u.raw_user_meta_data->>'auth_provider', u.raw_app_meta_data->>'provider') = 'telegram'
      AND p.nick ~ '^tg_?[0-9]+$';

    IF has_profile_guard THEN
        ALTER TABLE public.profiles ENABLE TRIGGER trg_profiles_protect_privileged_fields;
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
