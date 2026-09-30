-- The authenticated role cancels every statement after 8s. team_directory only
-- reads the small roster, but it starts while journal boot still holds the
-- database, so that shared limit was canceling the sidebar load.

CREATE OR REPLACE FUNCTION public.team_directory()
RETURNS TABLE (
    id UUID,
    nick TEXT,
    first_name TEXT,
    last_name TEXT,
    team TEXT,
    mentor_enabled BOOLEAN,
    role TEXT,
    settings JSONB
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '12s'
SET lock_timeout = '4s'
AS $$
    SELECT
        p.id,
        p.nick,
        p.first_name,
        p.last_name,
        NULLIF(BTRIM(p.team), '') AS team,
        p.mentor_enabled,
        p.role,
        jsonb_strip_nulls(jsonb_build_object(
            'avatar_url', CASE
                WHEN length(BTRIM(COALESCE(p.settings->>'avatar_url', ''))) BETWEEN 1 AND 2000
                    THEN BTRIM(p.settings->>'avatar_url')
                ELSE NULL
            END,
            'avatar_emoji', NULLIF(left(BTRIM(COALESCE(p.settings->>'avatar_emoji', '')), 16), ''),
            'defaultDayloss', CASE
                WHEN jsonb_typeof(p.settings->'defaultDayloss') = 'number' THEN p.settings->'defaultDayloss'
                ELSE NULL
            END,
            'monthlyDayloss', (
                SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
                FROM jsonb_each(
                    CASE
                        WHEN jsonb_typeof(p.settings->'monthlyDayloss') = 'object' THEN p.settings->'monthlyDayloss'
                        ELSE '{}'::jsonb
                    END
                ) AS entry
                WHERE entry.key ~ '^\d{4}-\d{2}$'
                  AND jsonb_typeof(entry.value) = 'number'
            )
        )) AS settings
    FROM public.profiles AS p
    WHERE public.app_is_approved()
      AND p.nick IS NOT NULL
      AND BTRIM(p.nick) <> ''
      AND NOT COALESCE((p.settings->>'account_blocked')::boolean, FALSE)
      AND (
          p.id = (SELECT auth.uid())
          OR COALESCE((p.settings->>'account_approved')::boolean, FALSE)
          OR p.role IN ('admin', 'mentor')
          OR p.mentor_enabled IS TRUE
      )
    ORDER BY p.team NULLS LAST, p.nick;
$$;

REVOKE ALL ON FUNCTION public.team_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_directory() TO authenticated;

NOTIFY pgrst, 'reload schema';
