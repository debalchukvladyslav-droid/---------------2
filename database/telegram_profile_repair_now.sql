-- One-off repair for Telegram profiles that were created with technical nicks
-- like tg_990223833. Run this in Supabase SQL Editor.

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
        nick = src.fixed_nick,
        email = src.fixed_nick || '@tradejournal.tg',
        settings = COALESCE(p.settings, '{}'::jsonb)
            || COALESCE(u.raw_user_meta_data, '{}'::jsonb)
            || jsonb_build_object(
                'auth_provider', 'telegram',
                'nick', src.fixed_nick,
                'display_name', src.fixed_nick
            ),
        updated_at = NOW()
    FROM auth.users u
    CROSS JOIN LATERAL (
        SELECT REGEXP_REPLACE(
            REGEXP_REPLACE(
                LOWER(
                    COALESCE(
                        NULLIF(BTRIM(u.raw_user_meta_data->>'nick'), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'display_name'), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'telegram_username'), ''),
                        NULLIF(BTRIM(p.first_name), ''),
                        NULLIF(BTRIM(u.raw_user_meta_data->>'first_name'), ''),
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
        ) AS fixed_nick
    ) src
    WHERE p.id = u.id
      AND p.nick ~ '^tg_?[0-9]+$'
      AND src.fixed_nick <> ''
      AND src.fixed_nick !~ '^tg_?[0-9]+$'
      AND (
          COALESCE(u.raw_user_meta_data->>'auth_provider', u.raw_app_meta_data->>'provider') = 'telegram'
          OR u.raw_user_meta_data ? 'telegram_id'
          OR p.email LIKE '%@telegram.%'
      );

    IF has_profile_guard THEN
        ALTER TABLE public.profiles ENABLE TRIGGER trg_profiles_protect_privileged_fields;
    END IF;
END;
$$;

SELECT id, nick, email, first_name, last_name, team, settings->>'auth_provider' AS auth_provider
FROM public.profiles
WHERE email LIKE '%@tradejournal.tg'
   OR nick ~ '^tg_?[0-9]+$'
ORDER BY updated_at DESC NULLS LAST;
