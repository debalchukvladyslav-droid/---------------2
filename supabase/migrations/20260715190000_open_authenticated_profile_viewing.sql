-- Every authenticated team member may open every other member read-only.
-- Mutation policies remain owner/admin/RPC scoped.

CREATE OR REPLACE FUNCTION public.app_can_view_user(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT auth.uid() IS NOT NULL AND target_user_id IS NOT NULL;
$$;

DROP POLICY IF EXISTS profiles_read_for_login_and_team ON public.profiles;
DROP POLICY IF EXISTS profiles_read_authenticated ON public.profiles;
CREATE POLICY profiles_read_authenticated
ON public.profiles
FOR SELECT
TO authenticated
USING (TRUE);

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
USING (bucket_id = 'screenshots' AND auth.uid() IS NOT NULL);

NOTIFY pgrst, 'reload schema';
