-- Existing accounts keep access. New accounts require an explicit admin decision.
UPDATE public.profiles
SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('account_approved', TRUE)
WHERE NOT (COALESCE(settings, '{}'::jsonb) ? 'account_approved');

CREATE OR REPLACE FUNCTION public.app_is_approved()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid()
          AND (
              role = 'admin'
              OR COALESCE((settings->>'account_approved')::boolean, FALSE)
          )
          AND NOT COALESCE((settings->>'account_blocked')::boolean, FALSE)
    );
$$;

REVOKE ALL ON FUNCTION public.app_is_approved() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_approved() TO authenticated;

CREATE OR REPLACE FUNCTION public.app_can_view_user(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.app_is_approved()
       AND target_user_id IS NOT NULL
       AND (
           auth.uid() = target_user_id
           OR public.app_is_admin()
           OR public.app_is_mentor()
       );
$$;

CREATE OR REPLACE FUNCTION public.app_protect_profile_privileged_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() = 'service_role' OR current_setting('app.telegram_profile_repair', TRUE) = 'on' THEN
        RETURN NEW;
    END IF;
    IF public.app_is_admin() THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.role := 'trader';
        NEW.mentor_enabled := FALSE;
        NEW.settings := COALESCE(NEW.settings, '{}'::jsonb)
            || jsonb_build_object('account_approved', FALSE);
        RETURN NEW;
    END IF;
    NEW.role := OLD.role;
    NEW.mentor_enabled := OLD.mentor_enabled;
    NEW.team := OLD.team;
    NEW.nick := OLD.nick;
    NEW.email := OLD.email;
    NEW.settings := jsonb_set(
        jsonb_set(
            COALESCE(NEW.settings, '{}'::jsonb),
            '{account_approved}',
            COALESCE(OLD.settings->'account_approved', 'false'::jsonb),
            TRUE
        ),
        '{registration_request}',
        COALESCE(OLD.settings->'registration_request', 'null'::jsonb),
        TRUE
    );
    NEW.settings := jsonb_set(
        NEW.settings,
        '{account_blocked}',
        COALESCE(OLD.settings->'account_blocked', 'false'::jsonb),
        TRUE
    );
    RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS profiles_read_authenticated ON public.profiles;
CREATE POLICY profiles_read_authenticated
ON public.profiles FOR SELECT TO authenticated
USING (
    id = auth.uid()
    OR (public.app_is_approved() AND (public.app_is_admin() OR public.app_is_mentor()))
);

DROP POLICY IF EXISTS journal_days_insert_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_insert_owner_or_same_team_mentor
ON public.journal_days FOR INSERT TO authenticated
WITH CHECK (public.app_is_approved() AND auth.uid() = user_id);

DROP POLICY IF EXISTS journal_days_update_owner_or_same_team_mentor ON public.journal_days;
CREATE POLICY journal_days_update_owner_or_same_team_mentor
ON public.journal_days FOR UPDATE TO authenticated
USING (public.app_is_approved() AND auth.uid() = user_id)
WITH CHECK (public.app_is_approved() AND auth.uid() = user_id);

DROP POLICY IF EXISTS journal_days_delete_owner_or_admin ON public.journal_days;
CREATE POLICY journal_days_delete_owner_or_admin
ON public.journal_days FOR DELETE TO authenticated
USING (public.app_is_approved() AND (auth.uid() = user_id OR public.app_is_admin()));

DROP POLICY IF EXISTS google_sheet_sync_configs_read_owner ON public.google_sheet_sync_configs;
CREATE POLICY google_sheet_sync_configs_read_owner
ON public.google_sheet_sync_configs FOR SELECT TO authenticated
USING (public.app_is_approved() AND auth.uid() = user_id);

DROP POLICY IF EXISTS google_sheet_sync_configs_insert_owner ON public.google_sheet_sync_configs;
CREATE POLICY google_sheet_sync_configs_insert_owner
ON public.google_sheet_sync_configs FOR INSERT TO authenticated
WITH CHECK (public.app_is_approved() AND auth.uid() = user_id AND enabled = FALSE);

DROP POLICY IF EXISTS google_sheet_sync_configs_update_owner ON public.google_sheet_sync_configs;
CREATE POLICY google_sheet_sync_configs_update_owner
ON public.google_sheet_sync_configs FOR UPDATE TO authenticated
USING (public.app_is_approved() AND auth.uid() = user_id)
WITH CHECK (public.app_is_approved() AND auth.uid() = user_id AND enabled = FALSE);

DROP POLICY IF EXISTS stop_mistakes_owner_write ON public.stop_mistakes;
CREATE POLICY stop_mistakes_owner_write ON public.stop_mistakes
FOR ALL TO authenticated
USING (public.app_is_approved() AND auth.uid() = user_id)
WITH CHECK (public.app_is_approved() AND auth.uid() = user_id);

DROP POLICY IF EXISTS stop_reviews_owner_write ON public.stop_reviews;
CREATE POLICY stop_reviews_owner_write ON public.stop_reviews
FOR ALL TO authenticated
USING (public.app_is_approved() AND auth.uid() = user_id)
WITH CHECK (public.app_is_approved() AND auth.uid() = user_id);

DROP POLICY IF EXISTS stop_review_mistakes_owner_write ON public.stop_review_mistakes;
CREATE POLICY stop_review_mistakes_owner_write ON public.stop_review_mistakes
FOR ALL TO authenticated
USING (
    public.app_is_approved() AND EXISTS (
        SELECT 1 FROM public.stop_reviews review
        WHERE review.id = review_id AND review.user_id = auth.uid()
    )
)
WITH CHECK (
    public.app_is_approved()
    AND EXISTS (
        SELECT 1 FROM public.stop_reviews review
        WHERE review.id = review_id AND review.user_id = auth.uid()
    )
    AND EXISTS (
        SELECT 1 FROM public.stop_mistakes mistake
        WHERE mistake.id = mistake_id AND mistake.user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS journal_backups_read_own ON public.journal_backups;
CREATE POLICY journal_backups_read_own ON public.journal_backups
FOR SELECT TO authenticated
USING (public.app_is_approved() AND user_id = auth.uid());

DROP POLICY IF EXISTS journal_backups_insert_own ON public.journal_backups;
CREATE POLICY journal_backups_insert_own ON public.journal_backups
FOR INSERT TO authenticated
WITH CHECK (public.app_is_approved() AND user_id = auth.uid());

DROP POLICY IF EXISTS journal_backups_update_own ON public.journal_backups;
CREATE POLICY journal_backups_update_own ON public.journal_backups
FOR UPDATE TO authenticated
USING (public.app_is_approved() AND user_id = auth.uid())
WITH CHECK (public.app_is_approved() AND user_id = auth.uid());

DROP POLICY IF EXISTS journal_backups_delete_own ON public.journal_backups;
CREATE POLICY journal_backups_delete_own ON public.journal_backups
FOR DELETE TO authenticated
USING (public.app_is_approved() AND user_id = auth.uid());

DROP POLICY IF EXISTS storage_screenshots_insert_auth_uid_folder ON storage.objects;
CREATE POLICY storage_screenshots_insert_auth_uid_folder ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    public.app_is_approved()
    AND bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_screenshots_update_auth_uid_folder ON storage.objects;
CREATE POLICY storage_screenshots_update_auth_uid_folder ON storage.objects
FOR UPDATE TO authenticated
USING (
    public.app_is_approved()
    AND bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
)
WITH CHECK (
    public.app_is_approved()
    AND bucket_id = 'screenshots'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_backgrounds_insert_auth_uid_folder ON storage.objects;
CREATE POLICY storage_backgrounds_insert_auth_uid_folder ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    public.app_is_approved()
    AND bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

DROP POLICY IF EXISTS storage_backgrounds_update_auth_uid_folder ON storage.objects;
CREATE POLICY storage_backgrounds_update_auth_uid_folder ON storage.objects
FOR UPDATE TO authenticated
USING (
    public.app_is_approved()
    AND bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
)
WITH CHECK (
    public.app_is_approved()
    AND bucket_id = 'backgrounds'
    AND split_part(name, '/', 1) = auth.uid()::TEXT
);

NOTIFY pgrst, 'reload schema';
