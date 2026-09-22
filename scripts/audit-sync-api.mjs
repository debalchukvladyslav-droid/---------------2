// Explicit opt-in. Only a newly created synthetic audit account is written.
// Credentials stay under the ignored .recovery directory; nothing is deleted.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import * as store from '../js/local_data_store.js';
import { createDataSyncEngine } from '../js/data_sync_engine.js';
const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10);
if (!process.argv.includes('--create-isolated-account') && !fixturePath) throw new Error('Use --create-isolated-account or --fixture=<synthetic-account-file>');
const env = { ...parseEnv(await readFile('.vercel/.env.production.local', 'utf8')), ...process.env };
const configSource = await readFile('config.js', 'utf8');
const configValue = name => configSource.match(new RegExp(`${name}\\s*:\\s*['\"]([^'\"]+)`))?.[1];
const url = (env.SUPABASE_URL && !env.SUPABASE_URL.includes('SENSITIVE') ? env.SUPABASE_URL : configValue('supabaseUrl')).replace(/\/$/, '');
const report = { startedAt: new Date().toISOString(), requests: [], checks: [] };
const service = env.SUPABASE_SERVICE_ROLE_KEY;
const anon = env.SUPABASE_ANON_KEY && !env.SUPABASE_ANON_KEY.includes('SENSITIVE') ? env.SUPABASE_ANON_KEY : configValue('supabaseAnonKey');
let token = service;
async function request(path, body, { key = anon, bearer = token, method = 'POST', expected = 200 } = {}) {
    const started = performance.now();
    const response = await fetch(`${url}${path}`, { method,
        headers: { apikey: key, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    report.requests.push({ path: path.split('?')[0], status: response.status, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text) });
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (response.status !== expected && !(expected === 200 && response.status === 201)) throw new Error(`${path.split('?')[0]} HTTP ${response.status}: ${data.code || data.error_code || data.message || 'unexpected response'}`);
    return data;
}
const rpc = (name, args = {}) => request(`/rest/v1/rpc/${name}`, args);
await mkdir('.recovery', { recursive: true });
const suffix = randomUUID().slice(0, 8);
const fixture = fixturePath ? JSON.parse(await readFile(fixturePath, 'utf8')) : null;
const email = fixture?.email || `sync-audit-${suffix}@example.invalid`;
const password = fixture?.password || `${randomUUID()}Aa1!`;
if (!email.startsWith('sync-audit-') || !email.endsWith('@example.invalid')) throw new Error('Only synthetic audit accounts are permitted');
try {
    const user = fixture ? { id: fixture.owner } : await request('/auth/v1/admin/users', { email, password, email_confirm: true, user_metadata: { nick: `sync_audit_${suffix}` } }, { key: service });
    const owner = user.id;
    assert.ok(owner);
    report.auditUserId = owner;
    if (!fixture) await writeFile(`.recovery/sync-audit-${suffix}.json`, JSON.stringify({ email, password, owner, url }));
    if (!fixture) await request('/rest/v1/profiles?on_conflict=id', { id: owner, nick: `sync_audit_${suffix}`, email, role: 'trader', settings: { account_approved: true } }, { key: service, method: 'POST' }).catch(async error => {
        // Auth may already have created this synthetic profile.
        if (!error.message.includes('409')) throw error;
        await request(`/rest/v1/profiles?id=eq.${owner}`, { settings: { account_approved: true } }, { key: service, method: 'PATCH' });
    });
    const session = await request('/auth/v1/token?grant_type=password', { email, password }, { bearer: anon });
    token = session.access_token;
    const state = await rpc('get_data_sync_state', { p_user_id: owner });
    Object.assign(globalThis, { indexedDB, IDBKeyRange });
    await store.saveSyncMetadata(owner, { ...state, initialized: true });
    const date = '2099-01-01';
    const operation = (patch, options = {}) => ({ operationId: randomUUID(), userId: owner, domain: 'journal', entityId: date, epoch: state.epoch, baseVersion: 0, base: {}, patch, ...options });
    const first = operation({ notes: 'audit base', pnl: 1 });
    const applied = await rpc('apply_data_operations', { p_operations: [first] });
    assert.equal(applied.results[0].status, 'applied');
    const duplicate = await rpc('apply_data_operations', { p_operations: [first] });
    assert.equal(duplicate.results[0].status, 'duplicate');
    assert.equal(duplicate.cursor, applied.cursor);
    report.checks.push('apply and duplicate delivery: same cursor');
    const point = await rpc('create_restore_point', { p_reason: 'isolated-sync-audit', p_user_id: owner });
    assert.ok((await rpc('list_restore_points', { p_user_id: owner })).some(item => item.id === point.id));
    await store.cacheJournalRows(owner, [applied.results[0].row]);
    await store.commitLocalChanges(owner, [{ domain: 'journal', entityId: date, value: { notes: 'local wins', pnl: 1 } }]);
    const remote = operation({ notes: 'other device', pnl: 7 }, { base: { notes: 'audit base', pnl: 1 }, baseVersion: applied.results[0].version });
    await rpc('apply_data_operations', { p_operations: [remote] });
    const transport = {
        metadata: user => rpc('get_data_sync_state', { p_user_id: user }),
        snapshot: user => request(`/rest/v1/journal_days?user_id=eq.${user}&select=*&order=trade_date`, undefined, { method: 'GET' }),
        pull: (user, cursor) => rpc('pull_data_changes', { p_user_id: user, p_cursor: cursor, p_limit: 2 }),
        apply: (_user, operations, atomic) => rpc('apply_data_operations', { p_operations: operations, p_atomic: atomic }),
        resolveConflict: (_user, id, resolution) => rpc('resolve_data_conflict', { p_conflict_id: id, p_resolution: resolution }),
    };
    const engine = createDataSyncEngine({ store, transport, conflictPolicy: 'local', schedule: () => 1, cancel() {}, lock: async (_user, run) => run() });
    engine.start(owner);
    try {
        await engine.flush();
        let rows = await transport.snapshot(owner);
        assert.equal(rows[0].notes, 'local wins');
        assert.equal(rows[0].pnl, 7);
        report.checks.push('real API conflict rebase preserves local note and unrelated remote pnl');
        await store.commitLocalChanges(owner, [{ domain: 'journal', entityId: date, value: { notes: 'offline during restore', pnl: 7 } }]);
        const preview = await rpc('preview_restore', { p_restore_point_id: point.id, p_user_id: owner });
        assert.equal(preview.canRestore, true);
        await rpc('restore_data', { p_restore_point_id: point.id, p_expected_epoch: preview.epoch, p_user_id: owner });
        await store.closeLocalDataStore();
        await engine.flush();
        rows = await transport.snapshot(owner);
        assert.equal(rows[0].notes, 'offline during restore');
        assert.equal(rows[0].pnl, 1);
        assert.equal((await store.listDataOperations(owner)).length, 0);
        report.checks.push('restore and reopened queue: local edit automatically resent on restored baseline');
        report.checks.push('cursor pagination: p_limit=2 drained successfully');
    } finally { engine.stop(); await store.closeLocalDataStore(); }
    report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
await writeFile('outputs/sync-audit-api.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
