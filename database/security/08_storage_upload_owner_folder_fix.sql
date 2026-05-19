-- Repair Storage uploads for the current authenticated user.
-- Run this in Supabase SQL Editor if uploads fail with:
-- "new row violates row-level security policy" for screenshots/<auth.uid()>/...

INSERT INTO storage.buckets (id, name, public)
VALUES
    ('screenshots', 'screenshots', false),
    ('backgrounds', 'backgrounds', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS storage_screenshots_select_auth_uid_folder ON storage.objects;
CREATE POLICY storage_screenshots_select_auth_uid_folder
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_screenshots_insert_auth_uid_folder ON storage.objects;
CREATE POLICY storage_screenshots_insert_auth_uid_folder
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_screenshots_update_auth_uid_folder ON storage.objects;
CREATE POLICY storage_screenshots_update_auth_uid_folder
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
)
WITH CHECK (
    bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_backgrounds_select_auth_uid_folder ON storage.objects;
CREATE POLICY storage_backgrounds_select_auth_uid_folder
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_backgrounds_insert_auth_uid_folder ON storage.objects;
CREATE POLICY storage_backgrounds_insert_auth_uid_folder
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_backgrounds_update_auth_uid_folder ON storage.objects;
CREATE POLICY storage_backgrounds_update_auth_uid_folder
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
)
WITH CHECK (
    bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

NOTIFY pgrst, 'reload schema';
