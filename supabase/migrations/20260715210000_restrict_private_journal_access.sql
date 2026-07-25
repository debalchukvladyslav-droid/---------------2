-- Restore least-privilege access after the temporary open-profile migration.
-- Owners see their own journal, admins see all, and mentors see trader journals.

CREATE OR REPLACE FUNCTION public.app_can_view_user(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        auth.uid() = target_user_id
        OR public.app_is_admin()
        OR public.app_is_mentor();
$$;

REVOKE ALL ON FUNCTION public.app_can_view_user(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_can_view_user(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.app_user_id_for_nick(target_nick TEXT)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.profiles WHERE nick = target_nick LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.app_storage_owner_user_id(owner_key TEXT)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE
        WHEN owner_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN owner_key::UUID
        ELSE public.app_user_id_for_nick(owner_key)
    END;
$$;

CREATE OR REPLACE FUNCTION public.app_can_view_storage_owner(owner_key TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.app_can_view_user(public.app_storage_owner_user_id(owner_key));
$$;

REVOKE ALL ON FUNCTION public.app_user_id_for_nick(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_storage_owner_user_id(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_can_view_storage_owner(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_user_id_for_nick(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_storage_owner_user_id(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_view_storage_owner(TEXT) TO authenticated;

DROP POLICY IF EXISTS profiles_read_authenticated ON public.profiles;
CREATE POLICY profiles_read_authenticated
ON public.profiles
FOR SELECT
TO authenticated
USING (
    id = auth.uid()
    OR public.app_is_admin()
    OR public.app_is_mentor()
);

DROP POLICY IF EXISTS journal_days_read_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_read_owner_or_same_team_mentor
ON public.journal_days
FOR SELECT
TO authenticated
USING (public.app_can_view_user(user_id));

DROP POLICY IF EXISTS storage_screenshots_read_owner_or_same_team_mentor ON storage.objects;
CREATE POLICY storage_screenshots_read_owner_or_same_team_mentor
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'screenshots'
    AND public.app_can_view_storage_owner(split_part(name, '/', 1))
);

NOTIFY pgrst, 'reload schema';
