// Default: read-only plan. --archive writes verified encrypted archives to the
// existing private Drive remote. It never deletes database rows or Storage bytes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { archiveHash, sealArchive, openArchive, restoreEntry, sqlString, historyArchiveQuery } from '../lib/recovery_archive.js';

const run = promisify(execFile);
const root = resolve(process.env.BACKUP_WORKDIR || '.recovery');
const folder = join(root, 'free-tier-archive');
await mkdir(folder, { recursive: true });
const cli = resolve('node_modules/supabase/dist/supabase.js');
if ((await readFile('supabase/.temp/project-ref','utf8')).trim() !== 'gijarvlerztfggxhuvow') throw new Error('Unexpected linked Supabase project');
let queryId = 0;
async function query(sql) {
    const file = join(folder, `query-${process.pid}-${queryId++}.sql`);
    await writeFile(file, sql);
    try {
        const command = process.env.SUPABASE_CLI_BIN || process.execPath;
        const prefix = process.env.SUPABASE_CLI_BIN ? [] : [cli];
        const result = await run(command, [...prefix, 'db', 'query', '--linked', '--output', 'json', '--file', file], { maxBuffer: 128 * 1024 * 1024 })
            .catch(error=>{throw new Error(`Maintenance SQL failed (${error.code || 'database unavailable'}); query output was withheld`);});
        const response = JSON.parse(result.stdout);
        return response.rows || [];
    } finally { await rm(file, { force: true }); }
}
const rclone = process.env.RCLONE_BIN || (process.platform === 'win32'
    ? resolve('.tools/rclone/expanded-v1.75.1/rclone-v1.75.1-windows-amd64/rclone.exe') : 'rclone');
const rcloneArgs = process.env.RCLONE_CONFIG ? ['--config', process.env.RCLONE_CONFIG] : [];
const remote = process.env.RECOVERY_ARCHIVE_REMOTE || 'gdrive:TraderJournalBackups/free-tier-archive';
const password = process.env.RESTIC_PASSWORD || await readFile(join(root, 'restic-recovery-key.txt'), 'utf8').then(value => value.trim()).catch(() => '');
async function remoteRun(args, options = {}) {
    return run(rclone, [...rcloneArgs, ...args], { maxBuffer: 128 * 1024 * 1024, ...options });
}

if (process.argv.includes('--extract')) {
    const input = process.argv[process.argv.indexOf('--extract') + 1];
    const id = process.argv[process.argv.indexOf('--point') + 1];
    const archive = openArchive(await readFile(input), password);
    const record = archive.records?.find(item => item.metadata?.id === id);
    if (!record) throw new Error('Restore point not found in this archive');
    const output = join(folder, `${id}.tjbackup.json`);
    await writeFile(output, JSON.stringify(restoreEntry(record)));
    console.log(JSON.stringify({ output }));
    process.exit(0);
}

const plan = (await query(`select jsonb_build_object(
    'databaseBytes',pg_database_size(current_database()),
    'restorePoints',(select count(*) from data_recovery.restore_points),
    'olderThanNewestThree',(select count(*) from (select row_number() over(partition by user_id order by created_at desc,id desc) as rank from data_recovery.restore_points) p where rank>3),
    'historyRows',(select count(*) from data_recovery.change_history),
    'storage',(select jsonb_object_agg(bucket_id,bytes) from (select bucket_id,sum((metadata->>'size')::bigint) as bytes from storage.objects group by bucket_id) b)
) as plan`))[0].plan;
await writeFile(join(folder, 'plan.json'), JSON.stringify(plan, null, 2));
console.log(JSON.stringify({ mode: process.argv.includes('--archive') ? 'archive' : 'plan', ...plan }));
if (!process.argv.includes('--archive')) process.exit(0);
if (password.length < 16) throw new Error('Set RESTIC_PASSWORD before archiving');
let state = { version: 1, points: {}, lastHistoryId: 0 };
try {
    const saved = await remoteRun(['cat', `${remote}/state.tjarchive`], { encoding: 'buffer' });
    state = openArchive(saved.stdout, password);
} catch (error) {
    if (!/not found|doesn't exist|directory not found|object not found/i.test(String(error.stderr || error.message))) throw error;
}
async function uploadVerified(name, payload) {
    const bytes = sealArchive(payload, password);
    if (name !== 'state.tjarchive') name = name.replace(/\.tjarchive$/, `-${archiveHash(bytes).slice(0,16)}.tjarchive`);
    const path = join(folder, name);
    await writeFile(path, bytes);
    await remoteRun(['copyto', path, `${remote}/${name}`, '--checksum']);
    const downloaded = (await remoteRun(['cat', `${remote}/${name}`], { encoding: 'buffer' })).stdout;
    if (archiveHash(bytes) !== archiveHash(downloaded)) throw new Error('Independent archive checksum mismatch');
    openArchive(downloaded, password);
    return { archive_path: `${remote}/${name}`, archive_sha256: archiveHash(bytes), verified_at: new Date().toISOString() };
}
async function saveState() { await uploadVerified('state.tjarchive', state); }

const points = await query(`select p.id,p.user_id,p.checksum,p.snapshot_path,p.created_at,
    (select updated_at::text from storage.objects o where o.bucket_id='journal-backups' and o.name=p.snapshot_path) as storage_updated_at
    from data_recovery.restore_points p order by p.created_at,p.id`);
let storageRestricted = false;
let skipped = 0;
let archived = 0;
for (let offset = 0; offset < points.length; offset += 5) {
    const batch = points.slice(offset, offset + 5).filter(point => state.points[point.id]?.checksum !== point.checksum);
    const inline = batch.filter(point => !point.snapshot_path);
    const records = inline.length ? await query(`select 'restore_point' as kind,
        jsonb_build_object('id',id,'userId',user_id,'createdAt',created_at,'reason',reason,'epoch',epoch,'cursor',cursor,'counts',counts,'checksum',checksum,'scope',scope) as metadata,
        snapshot::text as "snapshotText" from data_recovery.restore_points where id in (${inline.map(p => sqlString(p.id)+'::uuid').join(',')})`) : [];
    for (const point of batch.filter(point => point.snapshot_path)) {
        if (storageRestricted) { skipped++; continue; }
        const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for offloaded points');
        const response = await fetch(`${base}/storage/v1/object/authenticated/journal-backups/${point.snapshot_path.split('/').map(encodeURIComponent).join('/')}`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000),
        });
        if (response.status === 402) { storageRestricted = true; skipped++; await response.body?.cancel(); continue; }
        if (!response.ok) throw new Error(`Offloaded restore point download failed: HTTP ${response.status}`);
        const snapshotText = await response.text();
        if (!JSON.parse(snapshotText)?.tables) throw new Error('Invalid offloaded snapshot');
        const metadata = (await query(`select jsonb_build_object('id',id,'userId',user_id,'createdAt',created_at,'reason',reason,'epoch',epoch,'cursor',cursor,'counts',counts,'checksum',checksum,'scope',scope) as value from data_recovery.restore_points where id=${sqlString(point.id)}::uuid`))[0].value;
        metadata.storagePath = point.snapshot_path;
        metadata.storageUpdatedAt = point.storage_updated_at;
        metadata.storedFileSha256 = archiveHash(snapshotText);
        records.push({ kind: 'restore_point', metadata, snapshotText });
    }
    if (!records.length) continue;
    for (const record of records) {
        if (!JSON.parse(record.snapshotText)?.tables) throw new Error('Snapshot payload is missing');
        const point = batch.find(point => point.id === record.metadata.id);
        if (!point?.snapshot_path && archiveHash(record.snapshotText) !== record.metadata.checksum) throw new Error('Database snapshot checksum mismatch');
    }
    const receipt = await uploadVerified(`points-${records[0].metadata.id}.tjarchive`, { version: 1, records });
    const rows = records.map(record => ({ restore_point_id: record.metadata.id, user_id: record.metadata.userId, checksum: record.metadata.checksum,
        ...receipt, metadata: record.metadata }));
    await query(`insert into data_recovery.restore_point_archives select x.restore_point_id,x.user_id,x.checksum,x.archive_path,x.archive_sha256,now(),x.verified_at,x.metadata
        from jsonb_to_recordset(${sqlString(JSON.stringify(rows))}::jsonb) as x(restore_point_id uuid,user_id uuid,checksum text,archive_path text,archive_sha256 text,verified_at timestamptz,metadata jsonb)
        on conflict(restore_point_id) do update set archive_path=excluded.archive_path,archive_sha256=excluded.archive_sha256,verified_at=excluded.verified_at,checksum=excluded.checksum,metadata=excluded.metadata`);
    rows.forEach(row => { state.points[row.restore_point_id] = row; });
    archived += rows.length;
    await saveState();
    console.log(JSON.stringify({ archivedPoints: archived, skippedPoints: skipped }));
}

let historyCursor = 0;
for (;;) {
    const page = (await query(historyArchiveQuery(historyCursor,200,true)))[0].page;
    if (!page.rows.length) break;
    const first = page.rows[0].metadata.id, last = page.rows.at(-1).metadata.id;
    const receipt = await uploadVerified(`history-${first}-${last}.tjarchive`, page);
    const rowIds = page.rows.map(row=>Number(row.metadata.id));
    await query(`insert into data_recovery.history_archives(first_id,last_id,archive_path,archive_sha256,verified_at,row_ids)
        values(${Number(first)},${Number(last)},${sqlString(receipt.archive_path)},${sqlString(receipt.archive_sha256)},${sqlString(receipt.verified_at)}::timestamptz,array[${rowIds.join(',')}]::bigint[])
        on conflict(first_id,last_id) do update set archive_path=excluded.archive_path,archive_sha256=excluded.archive_sha256,verified_at=excluded.verified_at,row_ids=excluded.row_ids`);
    historyCursor = Number(last);
    state.lastHistoryId = last;
    await saveState();
    console.log(JSON.stringify({ archivedHistoryThrough: last }));
}
console.log(JSON.stringify({ archivedPoints: archived, skippedPoints: skipped, archivedHistoryThrough: state.lastHistoryId, deleted: 0 }));
if (process.argv.includes('--prune')) {
    const receipts = await query(`select distinct archive_path,archive_sha256 from data_recovery.restore_point_archives
        union select distinct archive_path,archive_sha256 from data_recovery.history_archives`);
    if (!receipts.length) throw new Error('Refusing cleanup without an independently verified archive');
    for (const receipt of receipts) {
        const bytes = (await remoteRun(['cat',receipt.archive_path],{encoding:'buffer'})).stdout;
        if (archiveHash(bytes)!==receipt.archive_sha256) throw new Error('Archive changed since verification; cleanup cancelled');
        openArchive(bytes,password);
    }
    const sql = (await readFile('database/free_tier_cleanup.sql','utf8')).replace(/^rollback;$/m,'commit;');
    await query(sql);
    const retiredFiles = await query(`select o.name,o.updated_at from storage.objects o
        join data_recovery.restore_point_archives a on a.metadata->>'storagePath'=o.name
        where o.bucket_id='journal-backups' and a.verified_at is not null
          and o.updated_at=nullif(a.metadata->>'storageUpdatedAt','')::timestamptz
          and not exists(select 1 from data_recovery.restore_points p where p.snapshot_path=o.name)
        order by o.name`);
    let deletedFiles = 0;
    for(let offset=0;offset<retiredFiles.length;offset+=50) {
        const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
        const base=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
        if(!base||!key)throw new Error('Storage cleanup requires the service environment');
        const response=await fetch(`${base}/storage/v1/object/journal-backups`,{method:'DELETE',
            headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
            body:JSON.stringify({prefixes:retiredFiles.slice(offset,offset+50).map(row=>row.name)}),signal:AbortSignal.timeout(30000)});
        if(response.status===402){storageRestricted=true;await response.body?.cancel();break;}
        if(!response.ok)throw new Error(`Storage retirement failed: HTTP ${response.status}`);
        deletedFiles+=retiredFiles.slice(offset,offset+50).length;
    }
    console.log(JSON.stringify({cleanupCommitted:true,retiredBackupFiles:deletedFiles,storageRestricted}));
}
