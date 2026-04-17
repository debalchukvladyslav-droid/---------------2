-- Remove broad legacy storage access. Specific owner/mentor/admin policies are
-- created in database/security/01_enable_rls.sql.

DROP POLICY IF EXISTS "Public Access" ON storage.objects;

NOTIFY pgrst, 'reload schema';
