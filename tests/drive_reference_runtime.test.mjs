import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
let PGlite;
try { ({ PGlite } = await import('../.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js')); } catch {}

test('Drive runtime repair works without applying unrelated quota/recovery migrations', { skip: !PGlite }, async t => {
    const db = new PGlite();
    t.after(() => db.close());
    const read = name => readFile(new URL(name, import.meta.url),'utf8');
    await db.exec(await read('./fixtures/recovery_schema.sql'));
    for (const migration of ['20260914140339_durable_recovery_sync.sql','20260914140454_reliable_source_integrations.sql',
        '20261111091818_repair_drive_reference_runtime.sql','20261111093210_preserve_legacy_drive_paths.sql']) {
        await db.exec(await read(`../supabase/migrations/${migration}`));
    }
    const query = async (sql,args=[]) => (await db.query(sql,args)).rows;
    const owner='11111111-1111-4111-8111-111111111111';
    await query('insert into auth.users(id) values($1)',[owner]);
    await query("insert into public.profiles(id,nick) values($1,'drive-test')",[owner]);
    const connection=(await query("insert into integration_connections(user_id,kind,resource_id) values($1,'drive','folder') returning id",[owner]))[0].id;
    const state=(await query('select public.get_source_sync_state($1) state',[owner]))[0].state;
    const metadata=JSON.stringify({source_file_id:'original',original_name:'chart.png',mime_type:'image/png',byte_size:123});
    const register=epoch=>query('select public.register_drive_screenshot_reference($1,$2,$3::jsonb) result',[connection,epoch,metadata]);
    const result=(await register(state.epoch))[0].result;
    assert.equal(result.record.quality_details.storageBackend,'drive');
    assert.equal(result.record.quality_details.folderId,'folder');
    assert.equal(result.record.storage_path,`screenshots/${owner}/drive/original/reference`);
    assert.equal((await register(state.epoch))[0].result.record.id,result.record.id);
    assert.equal((await query('select count(*)::int n from storage.objects'))[0].n,0);
    const legacyPath=`screenshots/${owner}/legacy-original_chart.png`;
    const legacy=(await query("insert into screenshots(user_id,storage_path,source) values($1,$2,'upload') returning id",[owner,legacyPath]))[0];
    const legacyMetadata=JSON.stringify({source_file_id:'legacy-original',original_name:'chart.png',mime_type:'image/png',byte_size:123});
    const adopted=(await query('select public.register_drive_screenshot_reference($1,$2,$3::jsonb) result',[connection,state.epoch,legacyMetadata]))[0].result.record;
    assert.equal(adopted.id,legacy.id);
    assert.equal(adopted.storage_path,legacyPath);
    assert.equal(adopted.source,'drive');
    assert.equal(adopted.source_file_id,'legacy-original');
    assert.equal(adopted.quality_details.storageBackend,'drive');
    assert.equal((await query('select count(*)::int n from screenshots'))[0].n,2);
    assert.equal((await query('select count(*)::int n from storage.objects'))[0].n,0);
    await query('update screenshots set deleted_at=now() where id=$1',[legacy.id]);
    const deleted=(await query('select public.register_drive_screenshot_reference($1,$2,$3::jsonb) result',[connection,state.epoch,legacyMetadata]))[0].result;
    assert.equal(deleted.reason,'deleted_on_site');
    await assert.rejects(register(state.epoch+1),/Stale source job epoch/);
    await db.exec('set role authenticated');
    await assert.rejects(query('select public.get_source_sync_state($1)',[owner]),/permission denied/);
    await assert.rejects(register(state.epoch),/permission denied/);
    await db.exec('reset role');
});
