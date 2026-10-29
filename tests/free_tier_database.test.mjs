import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyArchiveQuery } from '../lib/recovery_archive.js';
let PGlite;
try { ({ PGlite } = await import('../.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js')); } catch {}

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

test('free tier SQL avoids duplicate history and registers Drive references with owner checks', { skip: !PGlite }, async t => {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(await readFile(new URL('./fixtures/recovery_schema.sql', import.meta.url), 'utf8'));
    await db.exec("create function public.app_can_view_user(target uuid) returns boolean language sql stable as $$ select target=auth.uid() or public.app_is_admin() $$");
    for (const file of ['20260914140339_durable_recovery_sync.sql', '20260914140454_reliable_source_integrations.sql',
        '20260916191838_fix_recovery_health_snapshot.sql', '20260925124500_normalize_trade_rows.sql',
        '20260925133000_fix_settings_sync_alias.sql', '20260925160000_polygon_shared_bars.sql',
        '20261029150057_reduce_redundant_sync_writes.sql', '20261029150718_drive_references_and_archived_backups.sql',
        '20261029152736_reserve_free_storage_capacity.sql', '20261029181000_bound_derived_market_caches.sql']) {
        try {
            let sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
            await db.exec(sql);
        }
        catch (error) { throw new Error(`${file}: ${error.message}; ${error.where || ''}`); }
    }
    const query = async (sql, args = []) => (await db.query(sql, args)).rows;
    await query('insert into auth.users(id) values($1),($2)', [owner, other]);
    await query("insert into public.profiles(id,nick,settings) values($1,'owner','{}'),($2,'other','{}')", [owner, other]);
    await query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);

    await t.test('a repeated heavy setting keeps its version, cursor and history unchanged', async () => {
        await query("insert into user_settings(user_id,key,value) values($1,'screenMeta','{\"a\":1}')", [owner]);
        const before = await query('select cursor from data_recovery.owner_state where user_id=$1', [owner]);
        await query("update user_settings set value='{\"a\":1}',version=version+1,updated_at=now() where user_id=$1", [owner]);
        assert.deepEqual(await query('select cursor from data_recovery.owner_state where user_id=$1', [owner]), before);
        assert.equal((await query('select version from user_settings where user_id=$1', [owner]))[0].version, 1);
        await query("update user_settings set value='{\"a\":2}',version=version+1 where user_id=$1", [owner]);
        assert.equal((await query('select version from user_settings where user_id=$1', [owner]))[0].version, 2);
    });
    const connection = (await query("insert into integration_connections(user_id,kind,resource_id) values($1,'drive','allowed-folder') returning id", [owner]))[0].id;
    await t.test('heartbeats remain stored but do not become user history', async () => {
        const before = await query('select cursor from data_recovery.owner_state where user_id=$1', [owner]);
        await query("update integration_connections set last_sync_at=now(),next_sync_at=now()+interval '5 minutes',last_revision='revision' where id=$1", [connection]);
        assert.deepEqual(await query('select cursor from data_recovery.owner_state where user_id=$1', [owner]), before);
        await query("update integration_connections set config='{\"folderLabel\":\"changed\"}' where id=$1", [connection]);
        assert.notDeepEqual(await query('select cursor from data_recovery.owner_state where user_id=$1', [owner]), before);
    });
    await t.test('reference creation needs no Storage object and preserves existing assignments', async () => {
        const metadata = { source_file_id: 'file-1', original_name: 'chart.png', mime_type: 'image/png', byte_size: 100, source_modified_at: '2026-10-29T00:00:00Z' };
        const call = () => query('select public.register_drive_screenshot_reference($1,1,$2::jsonb) as value', [connection, JSON.stringify(metadata)]);
        const first = (await call())[0].value.record;
        assert.equal(first.user_id, owner);
        assert.equal(first.quality_details.storageBackend, 'drive');
        assert.equal((await query('select count(*)::int as n from storage.objects'))[0].n, 0);
        assert.equal((await call())[0].value.record.id, first.id);
        await assert.rejects(query('select public.register_drive_screenshot_reference($1,999,$2::jsonb)', [connection, JSON.stringify(metadata)]), /Stale source job epoch/);
        await query('update screenshots set deleted_at=now() where id=$1', [first.id]);
        assert.equal((await call())[0].value.reason, 'deleted_on_site');
    });
    await t.test('ordinary authenticated clients cannot register arbitrary source files or read service epochs', async () => {
        await db.exec('set role authenticated');
        await assert.rejects(query("select public.register_drive_screenshot_reference($1,1,'{}')", [connection]), /permission denied/);
        await assert.rejects(query('select public.get_source_sync_state($1)', [other]), /permission denied/);
        await db.exec('reset role');
    });
    await t.test('unchanged source trades do not repeatedly increment versions', async () => {
        const trades = JSON.stringify([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', symbol: 'AAPL', net: 5 }]);
        await query("select data_recovery.project_day_trades($1,'2026-10-29',$2::jsonb)", [owner,trades]);
        const before = await query('select version from public.trades where user_id=$1', [owner]);
        await query("select data_recovery.project_day_trades($1,'2026-10-29',$2::jsonb)", [owner,trades]);
        assert.deepEqual(await query('select version from public.trades where user_id=$1', [owner]), before);
    });
    await t.test('encrypted history export dictionaries retain every exact payload', async () => {
        const page = (await query(historyArchiveQuery(0,200)))[0].page;
        assert.ok(page.rows.length>0);
        for (const row of page.rows) for (const hash of [row.oldHash,row.newHash].filter(Boolean)) {
            assert.equal(typeof page.payloads[hash], 'string');
            assert.doesNotThrow(()=>JSON.parse(page.payloads[hash]));
        }
    });
    await t.test('Storage reservations account for parallel uploads and are idempotent', async () => {
        await query("insert into storage.objects(bucket_id,name,metadata) values('screenshots','existing','{\"size\":875000000}')");
        const reserve = (path,bytes) => query("select public.reserve_storage_capacity($1,'screenshots',$2,$3) as result", [owner,owner+'/'+path,bytes]);
        assert.equal((await reserve('first',20000000))[0].result.allowed,true);
        assert.equal((await reserve('first',20000000))[0].result.allowed,true);
        assert.equal((await reserve('second',10000000))[0].result.allowed,false);
        assert.equal((await query("select public.reserve_storage_capacity($1,'journal-exports',$2,10000000) as result",[owner,owner+'/export.xlsx']))[0].result.allowed,false);
        await assert.rejects(query("select public.reserve_storage_capacity($1,'screenshots',$2,1)",[owner,other+'/image']),/Invalid storage reservation/);
        await query("delete from storage.objects where name='existing'");
    });
    await t.test('growing existing cache objects cannot bypass the global Storage cap', async () => {
        await query('delete from data_recovery.storage_upload_reservations');
        await query("insert into storage.objects(bucket_id,name,metadata) values('screenshots','existing','{\"size\":899999900}'),('polygon-cache','AAPL/chart.json','{\"size\":50}')");
        const reserve = bytes => query("select public.reserve_storage_capacity($1,'polygon-cache','AAPL/chart.json',$2) as result",[owner,bytes]);
        assert.equal((await reserve(150))[0].result.allowed,false);
        assert.equal((await reserve(50))[0].result.allowed,true);
        await query("update storage.objects set metadata='{\"size\":1000000000}' where name='existing'");
        assert.equal((await reserve(20))[0].result.allowed,true);
        await query("delete from storage.objects where name in ('existing','AAPL/chart.json')");
    });
    await t.test('cache high-water failures preserve existing bars and do not claim a missing range', async () => {
        await query("insert into polygon_bars(symbol,granularity,bar_ms,open,high,low,close) values('AAPL','minute',1,1,2,1,2)");
        const migration = await readFile(new URL('../supabase/migrations/20261029181000_bound_derived_market_caches.sql',import.meta.url),'utf8');
        const guard = migration.slice(migration.indexOf('create function'),migration.indexOf('revoke all'))
            .replace('create function','create or replace function');
        await db.exec(guard.replace('>=430000000','>=1'));
        try {
            await assert.rejects(query("insert into polygon_bars(symbol,granularity,bar_ms,open,high,low,close) values('AAPL','minute',2,1,2,1,2)"),/MARKET_CACHE_BUDGET_LIMIT/);
            await assert.rejects(query("insert into polygon_range_fetches(symbol,granularity,range_start,range_end,bar_count) values('AAPL','minute',1,2,2)"),/MARKET_CACHE_BUDGET_LIMIT/);
            assert.equal((await query('select count(*)::int as n from polygon_bars'))[0].n,1);
            assert.equal((await query('select count(*)::int as n from polygon_range_fetches'))[0].n,0);
        } finally { await db.exec(guard); }
    });
    await t.test('the database high-water guard rejects growth but allows reductions', async () => {
        const migration = await readFile(new URL('../supabase/migrations/20261029152736_reserve_free_storage_capacity.sql',import.meta.url),'utf8');
        const guard = migration.slice(migration.indexOf('create function data_recovery.guard_free_database_budget()'),migration.indexOf('revoke all on function data_recovery.guard_free_database_budget()'))
            .replace('create function','create or replace function');
        // Reach the branch without allocating hundreds of MB; include legacy
        // writes without app.data_operation_id so old clients cannot bypass it.
        await db.exec(guard.replace('>=475000000','>=1'));
        try {
            await assert.rejects(query("insert into journal_days(user_id,trade_date,notes) values($1,'2026-10-31','growth')",[owner]),/База майже заповнена/);
            await assert.rejects(query("insert into user_settings(user_id,key,value) values($1,'new-heavy-setting','{\"a\":1}')",[owner]),/База майже заповнена/);
            await query("update user_settings set value='{}',version=version+1 where user_id=$1 and key='screenMeta'",[owner]);
            assert.deepEqual((await query("select value from user_settings where user_id=$1 and key='screenMeta'",[owner]))[0].value,{});
        } finally { await db.exec(guard); }
    });
    await t.test('only independently archived points can rotate out of the newest three', async () => {
        const create = reason => query('select data_recovery.create_point($1,$2) as point',[owner,reason]);
        const first=(await create('manual'))[0].point;
        assert.equal((await create('daily'))[0].point.unchanged,true);
        await create('manual'); await create('manual');
        await assert.rejects(create('manual'),/зовнішній архів/);
        await query(`insert into data_recovery.restore_point_archives(restore_point_id,user_id,checksum,archive_path,archive_sha256,verified_at)
            values($1,$2,$3,'private-archive',$4,now())`,[first.id,owner,first.checksum,'a'.repeat(64)]);
        await create('manual');
        assert.equal((await query('select count(*)::int as n from data_recovery.restore_points where user_id=$1',[owner]))[0].n,3);
        assert.equal((await query('select count(*)::int as n from data_recovery.restore_points where id=$1',[first.id]))[0].n,0);
    });
    await t.test('cleanup preserves unarchived history, live journals and the newest three points', async () => {
        const history = await query(`insert into data_recovery.change_history(user_id,cursor,epoch,table_name,entity_id,domain,new_record,version,created_at)
            values($1,100001,1,'user_settings','test-duplicate','setting','{"same":true}',1,now()),
                  ($1,100002,1,'user_settings','test-duplicate','setting','{"same":true}',2,now()),
                  ($1,100003,1,'journal_days','unarchived','journal','{"keep":true}',1,'2026-01-01') returning id,cursor`,[owner]);
        const duplicate=history.find(row=>Number(row.cursor)===100002).id;
        await query('update data_recovery.owner_state set cursor=100003 where user_id=$1',[owner]);
        await query(`insert into data_recovery.history_archives(first_id,last_id,archive_path,archive_sha256,verified_at,row_ids)
            values($1,$1,'verified-history',$2,now(),array[$1]::bigint[])`,[duplicate,'b'.repeat(64)]);
        const before=(await query('select count(*)::int as n from data_recovery.change_history'))[0].n;
        const journals=await query('select user_id,trade_date,notes from journal_days order by user_id,trade_date');
        const sql=await readFile(new URL('../database/free_tier_cleanup.sql',import.meta.url),'utf8');
        await db.exec(sql);
        assert.equal((await query('select count(*)::int as n from data_recovery.change_history'))[0].n,before);
        await db.exec(sql.replace(/^rollback;$/m,'commit;'));
        assert.equal((await query('select count(*)::int as n from data_recovery.change_history'))[0].n,before-1);
        assert.deepEqual(await query('select user_id,trade_date,notes from journal_days order by user_id,trade_date'),journals);
        assert.ok(Number((await query('select minimum_cursor from data_recovery.owner_state where user_id=$1',[owner]))[0].minimum_cursor)>=100002);
        assert.equal((await query('select count(*)::int as n from data_recovery.restore_points where user_id=$1',[owner]))[0].n,3);
    });
    await t.test('scheduled database dumps fail before transferring an over-budget data set', async () => {
        const source = await readFile(new URL('../scripts/check-backup-budget.sql',import.meta.url),'utf8');
        await db.exec(source.replace(":'database_budget'",'20000000'));
        await assert.rejects(db.exec(source.replace(":'database_budget'",'1')),/DATABASE_BACKUP_BUDGET_LIMIT/);
        await db.exec('rollback');
        const report = await db.exec(await readFile(new URL('../database/free_tier_usage.sql',import.meta.url),'utf8'));
        assert.ok(report.some(result => result.rows?.[0]?.usage?.databaseBytes>0));
    });
});
