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
