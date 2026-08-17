import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('server backups derive ownership from the verified Supabase session', () => {
    const source = readFileSync(new URL('../js/backups.js', import.meta.url), 'utf8');
    const helper = source.match(/async function getServerBackupUserId\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    assert.match(helper, /supabase\.auth\.getUser\(\)/);
    assert.doesNotMatch(helper, /if\s*\(state\.myUserId\)\s*return/);
    assert.match(helper, /return authenticatedUserId/);
});
