// Legacy Firebase migration entrypoint.
// The app now runs on Supabase. Keep this file harmless so old console snippets
// do not try to import the removed js/firebase.js module.

window.migrateToSubcollections = async function migrateToSubcollections() {
    console.warn(
        [
            'Firebase migration is disabled in this Supabase build.',
            'Use database/01_init_tables.sql for the base schema.',
            'Use database/ai/01_ai_request_logs.sql for AI request logs.',
            'Use database/security/01_enable_rls.sql when you are ready to enable RLS.'
        ].join('\n')
    );
};

window.showSupabaseMigrationInfo = function showSupabaseMigrationInfo() {
    return {
        baseSchema: 'database/01_init_tables.sql',
        aiLogs: 'database/ai/01_ai_request_logs.sql',
        productionRls: 'database/security/01_enable_rls.sql'
    };
};
