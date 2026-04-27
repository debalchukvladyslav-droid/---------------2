-- The app sidebar/team list expects every signed-in user to see the profile
-- directory. Journal data is still protected separately by journal_days RLS.

DROP POLICY IF EXISTS profiles_read_for_login_and_team ON public.profiles;
DROP POLICY IF EXISTS profiles_read_authenticated ON public.profiles;
CREATE POLICY profiles_read_authenticated
ON public.profiles
FOR SELECT
TO authenticated
USING (TRUE);

NOTIFY pgrst, 'reload schema';
