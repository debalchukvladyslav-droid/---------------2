import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
    '../supabase/migrations/20260813120000_harden_security_definer_execute.sql',
    import.meta.url,
);
const performanceMigrationUrl = new URL(
    '../supabase/migrations/20260813123000_optimize_rls_and_fk_indexes.sql',
    import.meta.url,
);
const mentorMigrationUrl = new URL(
    '../supabase/migrations/20260813113000_secure_mentor_review_rpcs.sql',
    import.meta.url,
);

test('SECURITY DEFINER migration removes implicit PUBLIC execution', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    assert.match(sql, /WHERE n\.nspname = 'public'\s+AND p\.prosecdef/i);
    assert.match(
        sql,
        /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/i,
    );
    assert.match(sql, /GRANT EXECUTE ON FUNCTION %s TO service_role/i);
    assert.match(sql, /login_email_for_nick\(text\)', 'anon, authenticated/i);
    assert.match(sql, /match_ai_learning_examples\(extensions\.vector,integer\)', 'service_role/i);
    assert.match(sql, /to_regprocedure\(permission\.signature\)/i);
    assert.match(sql, /ALTER FUNCTION public\.set_updated_at\(\) SET search_path = public/i);
    assert.match(sql, /ALTER FUNCTION public\.delete_user_totally\(\) SET search_path = public, auth/i);
    assert.doesNotMatch(sql, /delete_user_totally\(\)', 'authenticated/i);
    assert.doesNotMatch(
        sql,
        /match_ai_learning_examples[^\n]+', '(?:anon|authenticated)/i,
    );
});

test('database performance migration covers foreign keys and caches auth.uid in RLS', async () => {
    const sql = await readFile(performanceMigrationUrl, 'utf8');
    const indexStatements = sql.match(/CREATE INDEX IF NOT EXISTS/gi) || [];

    assert.equal(indexStatements.length, 13);
    assert.match(sql, /ON public\.profiles \(team_id\)/i);
    assert.match(sql, /ON public\.screenshots \(journal_id\)/i);
    assert.match(sql, /ON public\.stop_review_mistakes \(mistake_id\)/i);
    assert.match(sql, /ALTER POLICY profiles_read_authenticated/i);
    assert.match(sql, /ALTER POLICY storage_screenshots_write_owner_or_admin ON storage\.objects/i);
    assert.match(sql, /\(SELECT auth\.uid\(\)\)/i);
    assert.doesNotMatch(sql, /(?<!SELECT )auth\.uid\(\)/i);
});

test('mentor RPC migration restores review actions and protects comparison data', async () => {
    const sql = await readFile(mentorMigrationUrl, 'utf8');

    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.save_mentor_comment/i);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.accept_mentor_review_request/i);
    assert.match(sql, /IF NOT public\.app_is_approved\(\)/i);
    assert.match(sql, /request_kind NOT IN \('screens_general', 'calendar_profit', 'screen_item'\)/i);
    assert.match(sql, /public\.app_can_view_user\(target_user_id\)/i);
    assert.match(sql, /daily_metrics, '\{\}'::jsonb\) - 'review_requests'/i);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_stats_comparison_journal\(UUID\) FROM PUBLIC, anon/i);
});
