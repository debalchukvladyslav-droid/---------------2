ALTER TABLE public.google_sheet_sync_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS google_sheet_sync_configs_insert_owner
ON public.google_sheet_sync_configs;
CREATE POLICY google_sheet_sync_configs_insert_owner
ON public.google_sheet_sync_configs
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id AND enabled = FALSE);

DROP POLICY IF EXISTS google_sheet_sync_configs_update_owner
ON public.google_sheet_sync_configs;
CREATE POLICY google_sheet_sync_configs_update_owner
ON public.google_sheet_sync_configs
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id AND enabled = FALSE);

-- The service role bypasses RLS. Enabling unattended sync must therefore be
-- performed only by trusted server/admin tooling after resource verification.
UPDATE public.google_sheet_sync_configs
SET enabled = FALSE,
    last_sync_status = 'disabled_security_review',
    updated_at = NOW()
WHERE enabled = TRUE;

NOTIFY pgrst, 'reload schema';
