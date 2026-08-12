-- SECURITY DEFINER functions bypass RLS and PostgreSQL grants EXECUTE to
-- PUBLIC by default. Remove that implicit API surface, then grant only the
-- entry points required by the application.
DO $migration$
DECLARE
    fn RECORD;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
    LOOP
        EXECUTE format(
            'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
            fn.signature
        );
        -- Backend code uses the service role for workers and maintenance. Keep
        -- that trusted path intact while removing browser-callable defaults.
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.signature);
    END LOOP;
END
$migration$;

-- Some older installations were assembled from the database/security scripts
-- before all SQL moved into formal migrations. Grant conditionally so this
-- hardening migration remains safe across that known schema drift.
DO $migration$
DECLARE
    permission RECORD;
    fn REGPROCEDURE;
BEGIN
    FOR permission IN
        SELECT * FROM (VALUES
            -- Authentication screen: intentionally callable before login.
            ('public.login_email_for_nick(text)', 'anon, authenticated'),
            ('public.public_team_names()', 'anon, authenticated'),
            -- RLS predicates and authenticated application helpers.
            ('public.app_is_admin()', 'authenticated'),
            ('public.app_is_mentor()', 'authenticated'),
            ('public.app_is_approved()', 'authenticated'),
            ('public.app_user_id_for_nick(text)', 'authenticated'),
            ('public.app_can_view_user(uuid)', 'authenticated'),
            ('public.app_can_view_storage_owner(text)', 'authenticated'),
            ('public.repair_my_telegram_profile()', 'authenticated'),
            -- User actions that perform authorization in their function body.
            ('public.save_mentor_comment(uuid,date,text)', 'authenticated'),
            ('public.accept_mentor_review_request(uuid,date,text,text)', 'authenticated'),
            ('public.get_stats_comparison_journal(uuid)', 'authenticated'),
            ('public.mentor_move_trader_team(uuid,text)', 'authenticated'),
            ('public.delete_team(text)', 'authenticated'),
            ('public.rename_team(text,text)', 'authenticated'),
            -- Vector retrieval is server-only, never a browser RPC.
            ('public.match_ai_learning_examples(extensions.vector,integer)', 'service_role'),
            ('public.match_ai_learning_examples_scoped(extensions.vector,uuid,integer,double precision)', 'service_role'),
            ('public.match_ai_learning_examples_holdout(extensions.vector,uuid,date,uuid,integer,double precision)', 'service_role')
        ) AS required(signature, roles)
    LOOP
        fn := to_regprocedure(permission.signature);
        IF fn IS NOT NULL THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', fn, permission.roles);
        END IF;
    END LOOP;
END
$migration$;

-- Trigger functions are not browser RPCs. Pin their lookup path without
-- granting direct execution to anon/authenticated roles.
DO $migration$
BEGIN
    IF to_regprocedure('public.set_updated_at()') IS NOT NULL THEN
        ALTER FUNCTION public.set_updated_at() SET search_path = public;
    END IF;
    IF to_regprocedure('public.delete_user_totally()') IS NOT NULL THEN
        ALTER FUNCTION public.delete_user_totally() SET search_path = public, auth;
    END IF;
END
$migration$;

NOTIFY pgrst, 'reload schema';
