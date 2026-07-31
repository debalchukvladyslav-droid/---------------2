-- Durable screenshot manifest. Image bytes live in the private `screenshots` bucket.
ALTER TABLE public.screenshots
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload',
    ADD COLUMN IF NOT EXISTS source_file_id TEXT,
    ADD COLUMN IF NOT EXISTS original_name TEXT,
    ADD COLUMN IF NOT EXISTS mime_type TEXT,
    ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_modified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS screenshots_user_storage_path_key
    ON public.screenshots(user_id, storage_path);
CREATE UNIQUE INDEX IF NOT EXISTS screenshots_user_source_file_key
    ON public.screenshots(user_id, source, source_file_id)
    WHERE source_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS screenshots_user_created_idx
    ON public.screenshots(user_id, created_at DESC);

ALTER TABLE public.screenshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS screenshots_owner_or_admin ON public.screenshots;
CREATE POLICY screenshots_owner_or_admin ON public.screenshots
FOR ALL TO authenticated
USING (auth.uid() = user_id OR public.app_is_admin())
WITH CHECK (auth.uid() = user_id OR public.app_is_admin());

NOTIFY pgrst, 'reload schema';
