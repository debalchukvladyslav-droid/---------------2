-- Approved users can see the team roster and read teammates' journals.
-- Full profile rows stay private: profiles.settings holds API keys and other secrets.

CREATE OR REPLACE FUNCTION public.app_can_read_journal(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.app_is_approved()
       AND target_user_id IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM public.profiles AS target
           WHERE target.id = target_user_id
             AND NOT COALESCE((target.settings->>'account_blocked')::boolean, FALSE)
             AND (
                 target.id = (SELECT auth.uid())
                 OR COALESCE((target.settings->>'account_approved')::boolean, FALSE)
                 OR target.role IN ('admin', 'mentor')
                 OR target.mentor_enabled IS TRUE
             )
       );
$$;

REVOKE ALL ON FUNCTION public.app_can_read_journal(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_read_journal(UUID) TO authenticated;

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

ALTER POLICY journal_days_read_owner_or_same_team_mentor ON public.journal_days
    USING (public.app_can_read_journal(user_id));

ALTER POLICY trades_select ON public.trades
    USING (public.app_can_read_journal(user_id));

ALTER POLICY trade_criteria_snapshots_select ON public.trade_criteria_snapshots
    USING (public.app_can_read_journal(user_id));

CREATE OR REPLACE FUNCTION public.app_can_view_storage_owner(owner_key TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.app_can_read_journal(public.app_storage_owner_user_id(owner_key));
$$;

DROP POLICY IF EXISTS screenshots_read_approved_directory ON public.screenshots;
CREATE POLICY screenshots_read_approved_directory
ON public.screenshots
FOR SELECT
TO authenticated
USING (public.app_can_read_journal(user_id));

NOTIFY pgrst, 'reload schema';
