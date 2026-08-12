-- Reduce repeated RLS auth function evaluation and cover foreign-key lookups.
-- This migration intentionally preserves every policy's access semantics.

CREATE INDEX IF NOT EXISTS ai_evaluation_cases_created_by_idx
    ON public.ai_evaluation_cases (created_by);
CREATE INDEX IF NOT EXISTS ai_evaluation_cases_user_id_idx
    ON public.ai_evaluation_cases (user_id);
CREATE INDEX IF NOT EXISTS ai_evaluation_results_run_id_idx
    ON public.ai_evaluation_results (run_id);
CREATE INDEX IF NOT EXISTS ai_learning_examples_journal_day_id_idx
    ON public.ai_learning_examples (journal_day_id);
CREATE INDEX IF NOT EXISTS ai_learning_examples_reviewed_by_idx
    ON public.ai_learning_examples (reviewed_by);
CREATE INDEX IF NOT EXISTS ai_learning_examples_run_id_idx
    ON public.ai_learning_examples (run_id);
CREATE INDEX IF NOT EXISTS ai_learning_jobs_created_by_idx
    ON public.ai_learning_jobs (created_by);
CREATE INDEX IF NOT EXISTS ai_learning_jobs_last_run_id_idx
    ON public.ai_learning_jobs (last_run_id);
CREATE INDEX IF NOT EXISTS ai_learning_runs_created_by_idx
    ON public.ai_learning_runs (created_by);
CREATE INDEX IF NOT EXISTS ai_paper_signals_learning_example_id_idx
    ON public.ai_paper_signals (learning_example_id);
CREATE INDEX IF NOT EXISTS profiles_team_id_idx
    ON public.profiles (team_id);
CREATE INDEX IF NOT EXISTS screenshots_journal_id_idx
    ON public.screenshots (journal_id);
CREATE INDEX IF NOT EXISTS stop_review_mistakes_mistake_id_idx
    ON public.stop_review_mistakes (mistake_id);

ALTER POLICY ai_paper_signals_owner_insert ON public.ai_paper_signals
    WITH CHECK (((SELECT auth.uid()) = user_id) AND resolved_at IS NULL AND outcome_r IS NULL);
ALTER POLICY ai_paper_signals_owner_read ON public.ai_paper_signals
    USING ((SELECT auth.uid()) = user_id);
ALTER POLICY ai_paper_signals_owner_update ON public.ai_paper_signals
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY ai_logs_owner_only ON public.ai_request_logs
    USING (((SELECT auth.uid()) = user_id) OR app_is_admin())
    WITH CHECK (((SELECT auth.uid()) = user_id) OR app_is_admin());
ALTER POLICY ai_user_patterns_own_or_admin ON public.ai_user_patterns
    USING ((user_id = (SELECT auth.uid())) OR app_is_admin());

ALTER POLICY google_sheet_sync_configs_insert_owner ON public.google_sheet_sync_configs
    WITH CHECK (app_is_approved() AND ((SELECT auth.uid()) = user_id) AND enabled = false);
ALTER POLICY google_sheet_sync_configs_read_owner ON public.google_sheet_sync_configs
    USING (app_is_approved() AND ((SELECT auth.uid()) = user_id));
ALTER POLICY google_sheet_sync_configs_update_owner ON public.google_sheet_sync_configs
    USING (app_is_approved() AND ((SELECT auth.uid()) = user_id))
    WITH CHECK (app_is_approved() AND ((SELECT auth.uid()) = user_id) AND enabled = false);

ALTER POLICY journal_backups_delete_own ON public.journal_backups
    USING (app_is_approved() AND user_id = (SELECT auth.uid()));
ALTER POLICY journal_backups_insert_own ON public.journal_backups
    WITH CHECK (app_is_approved() AND user_id = (SELECT auth.uid()));
ALTER POLICY journal_backups_read_own ON public.journal_backups
    USING (app_is_approved() AND user_id = (SELECT auth.uid()));
ALTER POLICY journal_backups_update_own ON public.journal_backups
    USING (app_is_approved() AND user_id = (SELECT auth.uid()))
    WITH CHECK (app_is_approved() AND user_id = (SELECT auth.uid()));

ALTER POLICY journal_days_delete_owner_or_admin ON public.journal_days
    USING (app_is_approved() AND (((SELECT auth.uid()) = user_id) OR app_is_admin()));
ALTER POLICY journal_days_insert_owner_or_same_team_mentor ON public.journal_days
    WITH CHECK (app_is_approved() AND ((SELECT auth.uid()) = user_id));
ALTER POLICY journal_days_update_owner_or_same_team_mentor ON public.journal_days
    USING (app_is_approved() AND ((SELECT auth.uid()) = user_id))
    WITH CHECK (app_is_approved() AND ((SELECT auth.uid()) = user_id));

ALTER POLICY profiles_insert_own ON public.profiles
    WITH CHECK ((id = (SELECT auth.uid())) OR app_is_admin());
ALTER POLICY profiles_read_authenticated ON public.profiles
    USING ((id = (SELECT auth.uid())) OR (app_is_approved() AND (app_is_admin() OR app_is_mentor())));
ALTER POLICY profiles_update_own_or_admin ON public.profiles
    USING ((id = (SELECT auth.uid())) OR app_is_admin())
    WITH CHECK ((id = (SELECT auth.uid())) OR app_is_admin());

ALTER POLICY screenshots_owner_or_admin ON public.screenshots
    USING (((SELECT auth.uid()) = user_id) OR app_is_admin())
    WITH CHECK (((SELECT auth.uid()) = user_id) OR app_is_admin());
ALTER POLICY stop_mistakes_owner_write ON public.stop_mistakes
    USING (app_is_approved() AND ((SELECT auth.uid()) = user_id))
    WITH CHECK (app_is_approved() AND ((SELECT auth.uid()) = user_id));
ALTER POLICY stop_reviews_owner_write ON public.stop_reviews
    USING (app_is_approved() AND ((SELECT auth.uid()) = user_id))
    WITH CHECK (app_is_approved() AND ((SELECT auth.uid()) = user_id));
ALTER POLICY stop_review_mistakes_owner_write ON public.stop_review_mistakes
    USING (
        app_is_approved()
        AND EXISTS (
            SELECT 1
            FROM public.stop_reviews AS review
            WHERE review.id = stop_review_mistakes.review_id
              AND review.user_id = (SELECT auth.uid())
        )
    )
    WITH CHECK (
        app_is_approved()
        AND EXISTS (
            SELECT 1
            FROM public.stop_reviews AS review
            WHERE review.id = stop_review_mistakes.review_id
              AND review.user_id = (SELECT auth.uid())
        )
        AND EXISTS (
            SELECT 1
            FROM public.stop_mistakes AS mistake
            WHERE mistake.id = stop_review_mistakes.mistake_id
              AND mistake.user_id = (SELECT auth.uid())
        )
    );

ALTER POLICY storage_backgrounds_insert_auth_uid_folder ON storage.objects
    WITH CHECK (
        app_is_approved()
        AND bucket_id = 'backgrounds'
        AND split_part(name, '/', 1) = (SELECT auth.uid())::TEXT
    );
ALTER POLICY storage_backgrounds_owner_or_admin ON storage.objects
    USING (
        bucket_id = 'backgrounds'
        AND (app_is_admin() OR split_part(name, '/', 1) = (SELECT auth.uid())::TEXT)
    )
    WITH CHECK (
        bucket_id = 'backgrounds'
        AND (app_is_admin() OR split_part(name, '/', 1) = (SELECT auth.uid())::TEXT)
    );
ALTER POLICY storage_backgrounds_update_auth_uid_folder ON storage.objects
    USING (
        app_is_approved()
        AND bucket_id = 'backgrounds'
        AND split_part(name, '/', 1) = (SELECT auth.uid())::TEXT
    )
    WITH CHECK (
        app_is_approved()
        AND bucket_id = 'backgrounds'
        AND split_part(name, '/', 1) = (SELECT auth.uid())::TEXT
    );

ALTER POLICY storage_screenshots_delete_owner_or_admin ON storage.objects
    USING (
        bucket_id = 'screenshots'
        AND (
            app_is_admin()
            OR app_user_id_for_nick(split_part(name, '/', 1)) = (SELECT auth.uid())
        )
    );
ALTER POLICY storage_screenshots_insert_auth_uid_folder ON storage.objects
    WITH CHECK (
        app_is_approved()
        AND bucket_id = 'screenshots'
        AND split_part(name, '/', 1) = (SELECT auth.uid())::TEXT
    );
ALTER POLICY storage_screenshots_update_auth_uid_folder ON storage.objects
    USING (
        app_is_approved()
        AND bucket_id = 'screenshots'
        AND split_part(name, '/', 1) = (SELECT auth.uid())::TEXT
    )
    WITH CHECK (
        app_is_approved()
        AND bucket_id = 'screenshots'
        AND split_part(name, '/', 1) = (SELECT auth.uid())::TEXT
    );
ALTER POLICY storage_screenshots_update_owner_or_admin ON storage.objects
    USING (
        bucket_id = 'screenshots'
        AND (
            app_is_admin()
            OR app_user_id_for_nick(split_part(name, '/', 1)) = (SELECT auth.uid())
        )
    )
    WITH CHECK (
        bucket_id = 'screenshots'
        AND (
            app_is_admin()
            OR app_user_id_for_nick(split_part(name, '/', 1)) = (SELECT auth.uid())
        )
    );
ALTER POLICY storage_screenshots_write_owner_or_admin ON storage.objects
    WITH CHECK (
        bucket_id = 'screenshots'
        AND (
            app_is_admin()
            OR app_user_id_for_nick(split_part(name, '/', 1)) = (SELECT auth.uid())
        )
    );
