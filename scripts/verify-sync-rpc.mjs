import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10);
if (!fixturePath) throw new Error('Use --fixture=<synthetic-account-file>');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!fixture.email?.startsWith('sync-audit-') || !fixture.email.endsWith('@example.invalid')) {
    throw new Error('Only synthetic audit accounts are permitted');
}
const configSource = await readFile('config.js', 'utf8');
const configValue = name => configSource.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)`))?.[1];
const url = (fixture.url || configValue('supabaseUrl')).replace(/\/$/, '');
const anon = configValue('supabaseAnonKey');
const calls = [];
let token = anon;
async function request(path, body, method = 'POST') {
    const started = performance.now();
    const response = await fetch(`${url}${path}`, { method, headers: {
        apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    calls.push({ path: path.split('?')[0], status: response.status,
        ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text) });
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.code || data.message || text.slice(0, 200)}`);
    return data;
}

const session = await request('/auth/v1/token?grant_type=password', { email: fixture.email, password: fixture.password });
token = session.access_token;
const state = await request('/rest/v1/rpc/get_data_sync_state', { p_user_id: fixture.owner });
const date = '2198-09-23';
const rows = await request(`/rest/v1/journal_days?user_id=eq.${fixture.owner}&trade_date=eq.${date}&select=*`, undefined, 'GET');
const current = rows[0] || {};
const operation = { operationId: randomUUID(), userId: fixture.owner, domain: 'journal', entityId: date,
    epoch: state.epoch, baseVersion: current.sync_version || 0, base: { notes: current.notes ?? null },
    patch: { notes: `sync-rpc-probe-${new Date().toISOString()}` } };
const applied = await request('/rest/v1/rpc/apply_data_operations', { p_operations: [operation], p_atomic: false });
assert.equal(applied.results[0].status, 'applied');
const duplicate = await request('/rest/v1/rpc/apply_data_operations', { p_operations: [operation], p_atomic: false });
assert.equal(duplicate.results[0].status, 'duplicate');
const pulled = await request('/rest/v1/rpc/pull_data_changes', { p_cursor: state.cursor, p_limit: 500, p_user_id: fixture.owner });
assert.ok(pulled.changes.some(change => change.operationId === operation.operationId));
const concurrentPulls = await Promise.all(Array.from({ length: 8 }, () =>
    request('/rest/v1/rpc/pull_data_changes', { p_cursor: state.cursor, p_limit: 500, p_user_id: fixture.owner })));
assert.ok(concurrentPulls.every(page => page.cursor >= pulled.cursor));
console.log(JSON.stringify({ passed: true, calls, checks: [
    'authenticated apply returned applied', 'duplicate delivery returned duplicate',
    'cursor pull included the operation', 'eight concurrent cursor pulls returned successfully',
] }, null, 2));
