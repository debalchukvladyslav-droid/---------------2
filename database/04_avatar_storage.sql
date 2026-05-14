INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS storage_avatars_read_authenticated ON storage.objects;
CREATE POLICY storage_avatars_read_authenticated
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS storage_avatars_insert_owner_or_admin ON storage.objects;
CREATE POLICY storage_avatars_insert_owner_or_admin
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'avatars'
    AND (
        public.app_is_admin()
        OR split_part(name, '/', 1) = auth.uid()::TEXT
    )
);

DROP POLICY IF EXISTS storage_avatars_update_owner_or_admin ON storage.objects;
CREATE POLICY storage_avatars_update_owner_or_admin
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'avatars'
    AND (
        public.app_is_admin()
        OR split_part(name, '/', 1) = auth.uid()::TEXT
    )
)
WITH CHECK (
    bucket_id = 'avatars'
    AND (
        public.app_is_admin()
        OR split_part(name, '/', 1) = auth.uid()::TEXT
    )
);

DROP POLICY IF EXISTS storage_avatars_delete_owner_or_admin ON storage.objects;
CREATE POLICY storage_avatars_delete_owner_or_admin
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'avatars'
    AND (
        public.app_is_admin()
        OR split_part(name, '/', 1) = auth.uid()::TEXT
    )
);

NOTIFY pgrst, 'reload schema';
