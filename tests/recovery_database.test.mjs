import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Install @electric-sql/pglite in .tools/pglite, or provide PGLITE_MODULE. This
// executes PostgreSQL and PL/pgSQL, without contacting the production database.
let PGlite;
try {
    ({ PGlite } = await import(process.env.PGLITE_MODULE
        ? pathToFileURL(resolve(process.env.PGLITE_MODULE)).href
        : new URL('../.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href));
} catch { /* An explicit skip keeps ordinary browser-only installs lightweight. */ }

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
let db;
async function query(sql, params = []) {
    try { return (await db.query(sql, params)).rows; }
    catch (error) { throw new Error(`${error.message}: ${error.where || ''}; ${error.internalQuery || sql}`); }
}
async function rpc(name, params = [], casts = []) {
    const result = await query(`select public.${name}(${params.map((_, n) => `$${n + 1}${casts[n] ? '::' + casts[n] : ''}`).join(',')}) as result`, params);
    return result[0].result;
}
function operation(n, patch, baseVersion = 0, base = {}, options = {}) {
    return { operationId: id(n), userId: owner, domain: 'journal', entityId: '2026-09-01', epoch: 1, baseVersion, base, patch, ...options };
}

test('recovery database executes real SQL and protects changes and restore transactions', { skip: !PGlite }, async t => {
    db = new PGlite();
    await db.exec(await readFile(new URL('./fixtures/recovery_schema.sql', import.meta.url), 'utf8'));
    t.after(() => db.close());
    for (const filename of ['20260914140339_durable_recovery_sync.sql', '20260914140454_reliable_source_integrations.sql', '20260916191838_fix_recovery_health_snapshot.sql', '20260917031703_optimize_recovery_query_payloads.sql']) {
        const sql = await readFile(new URL(`../supabase/migrations/${filename}`, import.meta.url), 'utf8');
        try { await db.exec(sql); } catch (error) {
            const position = Number(error.position || 0);
            throw new Error(`${filename}:${sql.slice(0, position).split('\n').length}: ${error.message}; ${error.where || ''}; ${error.internalQuery || sql.slice(Math.max(0, position - 150), position + 150)}`);
        }
    }
    await query('insert into auth.users(id) values($1),($2)', [owner, other]);
    await query("insert into profiles(id,nick,settings) values($1,'owner','{\"account_approved\":true}'),($2,'other','{}')", [owner, other]);
    await query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec('set role authenticated');

    await t.test('state and owner authorization', async () => {
        const state = await rpc('get_data_sync_state');
        assert.equal(state.epoch, 1);
        assert.equal(state.settings.account_approved, true);
        await assert.rejects(rpc('get_data_sync_state', [other], ['uuid']), /Data access denied/);
    });
    await t.test('health works with Storage owner_id column and isolates owner bytes', async () => {
        await db.exec('reset role');
        await query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('files',$1,$2,'{\"size\":123}'),('files',$3,$4,'{\"size\":999}')", [owner+'/a', owner, other+'/b', other]);
        await db.exec('set role authenticated');
        const health = await rpc('get_data_health');
        assert.equal(health.usage.storageBytes, 123);
        assert.equal(health.historyRetentionDays, 30);
    });
    let first;
    await t.test('write, duplicate retry and disjoint concurrent merge', async () => {
        first = await rpc('apply_data_operations', [[operation(1, { notes: 'first', pnl: 5, daily_metrics: { checklist: 'done' } })]], ['jsonb']);
        assert.equal(first.results[0].status, 'applied');
        const duplicate = await rpc('apply_data_operations', [[operation(1, { notes: 'first', pnl: 5, daily_metrics: { checklist: 'done' } })]], ['jsonb']);
        assert.equal(duplicate.results[0].status, 'duplicate');
        assert.equal(duplicate.cursor, first.cursor);
        const a = await rpc('apply_data_operations', [[operation(2, { notes: 'device A' }, 1, { notes: 'first', pnl: 5 })]], ['jsonb']);
        assert.equal(a.results[0].status, 'applied');
        const b = await rpc('apply_data_operations', [[operation(3, { pnl: 12 }, 1, { notes: 'first', pnl: 5 })]], ['jsonb']);
        assert.equal(b.results[0].status, 'applied');
        assert.equal(b.results[0].row.notes, 'device A');
        assert.equal(b.results[0].row.pnl, 12);
    });
    await t.test('conflicting changes are retained and do not overwrite', async () => {
        const conflict = await rpc('apply_data_operations', [[operation(4, { notes: 'device B' }, 1, { notes: 'first' })]], ['jsonb']);
        assert.equal(conflict.results[0].status, 'conflict');
        assert.ok(conflict.results[0].conflictId);
        assert.equal(conflict.results[0].row.notes, 'device A');
        await assert.rejects(rpc('apply_data_operations', [[operation(1, { notes: 'different request' })]], ['jsonb']), /reused with different content/);
    });
    await t.test('atomic import rolls back every row on conflict', async () => {
        const result = await rpc('apply_data_operations', [[
            operation(5, { notes: 'must roll back' }, 0, {}, { entityId: '2020-01-01' }),
            operation(6, { notes: 'conflict' }, 1, { notes: 'first' }),
        ], true], ['jsonb', 'boolean']);
        assert.equal(result.results[0].status, 'conflict');
        assert.equal(result.results[0].row, null);
        assert.equal(result.results[0].version, 0);
        assert.equal(result.results[1].row.trade_date, '2026-09-01');
        assert.equal(result.results[1].row.notes, 'device A');
        assert.equal((await query("select count(*)::int as n from journal_days where trade_date='2020-01-01'"))[0].n, 0);
    });
    await t.test('old direct clients cannot bypass operation revisions', async () => {
        await assert.rejects(query("update journal_days set notes='old-client' where user_id=$1", [owner]), /CLIENT_UPGRADE_REQUIRED/);
        await assert.rejects(query("update profiles set settings='{}' where id=$1", [owner]), /CLIENT_UPGRADE_REQUIRED/);
        await assert.rejects(query('select * from data_recovery.change_history'), /permission denied/);
    });
    await t.test('snapshot and restore preserve journal IDs and child annotations', async () => {
        const journalId = first.results[0].row.id;
        await db.exec('reset role');
        await query("insert into trade_multimodal_inputs(user_id,journal_day_id,audio_transcript) values($1,$2,'human transcript')", [owner, journalId]);
        await db.exec('set role authenticated');
        const point = await rpc('create_restore_point');
        const original = await rpc('export_data_snapshot');
        assert.equal(original.tables.trade_multimodal_inputs[0].audio_transcript, 'human transcript');
        await rpc('apply_data_operations', [[operation(7, { notes: 'new day' }, 0, {}, { entityId: '2026-09-02' })]], ['jsonb']);
        const preview = await rpc('preview_restore', [point.id], ['uuid']);
        assert.equal(preview.canRestore, true);
        const restored = await rpc('restore_data', [point.id, 1], ['uuid', 'bigint']);
        assert.equal(restored.epoch, 2);
        assert.ok(restored.preRestorePointId);
        const after = await rpc('export_data_snapshot');
        assert.equal(after.tables.journal_days.length, original.tables.journal_days.length);
        assert.equal(after.tables.journal_days[0].id, journalId);
        assert.equal(after.tables.trade_multimodal_inputs[0].audio_transcript, 'human transcript');
        const stale = await rpc('apply_data_operations', [[operation(8, { notes: 'old offline edit' }, 1, { notes: 'first' })]], ['jsonb']);
        assert.equal(stale.results[0].status, 'stale_epoch');
    });
    await t.test('history changes page without missing cursors', async () => {
        const page = await rpc('pull_data_changes', [0, 2], ['bigint','integer']);
        assert.equal(page.changes.length, 2);
        assert.equal(page.hasMore, true);
        const next = await rpc('pull_data_changes', [page.cursor, 2000], ['bigint','integer']);
        assert.ok(next.changes.every(row => row.cursor > page.cursor));
        assert.ok(next.changes.some(row => row.domain === 'restore'));
        const audit = await rpc('list_data_history', [null, null, 500], ['uuid','bigint','integer']);
        assert.ok(audit.length >= page.changes.length);
        assert.ok(audit.every(row => row.source && row.created_at));
    });
    await t.test('cursor pulls compact repeated settings revisions without skipping their cursor', async () => {
        await db.exec('reset role');
        await query(`insert into data_recovery.change_history(user_id,cursor,epoch,table_name,entity_id,domain,new_record,version)
            values($1::uuid,9001,2,'profiles',$1::text,'settings','{"settings":{"screenMeta":{"old":true}}}',1),
                  ($1::uuid,9002,2,'profiles',$1::text,'settings','{"settings":{"screenMeta":{"new":true}}}',2)`, [owner]);
        await query('update data_recovery.owner_state set cursor=9002,epoch=2 where user_id=$1', [owner]);
        await db.exec('set role authenticated');
        const page = await rpc('pull_data_changes', [9000, 50], ['bigint', 'integer']);
        assert.equal(page.cursor, 9002);
        assert.equal(page.changes.length, 1);
        assert.equal(page.changes[0].record.screenMeta.new, true);
    });
});
