import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSupabaseConfig, schemaGateFailure, schemaUnavailable, verifyRecoverySchema } from '../scripts/verify-deployment-schema.mjs';

test('deployment schema gate can use the public browser config when build env is absent', () => {
    assert.deepEqual(publicSupabaseConfig("supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'publishable'"), {
        url: 'https://project.supabase.co', key: 'publishable',
    });
    assert.deepEqual(publicSupabaseConfig('window.TRADING_JOURNAL_CONFIG = {"supabaseUrl":"https://json.supabase.co","supabaseAnonKey":"json-key"};'), {
        url: 'https://json.supabase.co', key: 'json-key',
    });
});

test('deployment schema gate recognizes missing PostgREST objects', () => {
    assert.equal(schemaUnavailable(404, { code: 'PGRST202' }), true);
    assert.equal(schemaUnavailable(404, { code: 'PGRST205' }), true);
    assert.equal(schemaUnavailable(401, { code: '42501' }), false);
});

test('production deployment stops when a required recovery object is missing', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return calls === 1
            ? new Response(JSON.stringify({ code: '42501' }), { status: 401 })
            : new Response(JSON.stringify({ code: 'PGRST205' }), { status: 404 });
    };
    await assert.rejects(verifyRecoverySchema({ url: 'https://project.supabase.co', key: 'anon', fetchImpl }), /source_sync_jobs is missing/);
});

test('a network timeout does not fail the install gate', () => {
    assert.equal(schemaGateFailure(new Error('The operation was aborted due to timeout')), false);
    assert.equal(schemaGateFailure(new Error('source_sync_jobs is missing in Supabase. Apply the recovery migrations before deploying this client.')), true);
});

test('authorization errors prove that required objects exist', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ code: '42501' }), { status: 401 });
    assert.equal(await verifyRecoverySchema({ url: 'https://project.supabase.co', key: 'anon', fetchImpl }), true);
});
