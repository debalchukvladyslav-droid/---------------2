import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = process.cwd();

function supabase(args, maxBuffer = 8 * 1024 * 1024) {
    const line = ['npx', 'supabase', ...args.map((arg) => /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)].join(' ');
    const executable = process.platform === 'win32' ? 'cmd.exe' : 'npx';
    const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', line] : ['supabase', ...args];
    return new Promise((resolve, reject) => {
        execFile(executable, commandArgs, { cwd, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
            if (error) reject(new Error((stderr || stdout || error.message).slice(0, 2000)));
            else resolve(stdout);
        });
    });
}

function rowsFromQuery(stdout) {
    const start = stdout.indexOf('{');
    if (start < 0) throw new Error('Query returned no JSON');
    const payload = JSON.parse(stdout.slice(start));
    return payload.rows || [];
}

const workdir = await mkdtemp(join(tmpdir(), 'restore-offload-'));
let queryCount = 0;
async function query(sql, maxBuffer) {
    const file = join(workdir, `query-${queryCount += 1}.sql`);
    await writeFile(file, sql);
    const stdout = await supabase(['db', 'query', '--linked', '--output', 'json', '-f', file], maxBuffer);
    return rowsFromQuery(stdout);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const candidates = await query(`
    select id::text as id, user_id::text as user_id
    from (
        select id, user_id, snapshot_path,
            row_number() over (partition by user_id order by created_at desc, id desc) as rn
        from data_recovery.restore_points
    ) ranked
    where rn > 1 and snapshot_path is null
    order by user_id, id
`);

console.error(`Offloading ${candidates.length} older restore points. The newest point for each account stays in the database.`);
const keyStdout = await supabase(['projects', 'api-keys', '--project-ref', 'gijarvlerztfggxhuvow', '--reveal', '--output', 'json']);
const keyStart = keyStdout.indexOf('[');
const keyList = JSON.parse(keyStdout.slice(keyStart));
const secret = keyList.find((item) => item.name === 'service_role' || item.type === 'secret' || String(item.api_key || '').startsWith('sb_secret_'));
const serviceKey = secret?.api_key || '';
if (!serviceKey) throw new Error('Service role key was not available for the storage upload.');
let moved = 0;
try {
    for (const point of candidates) {
        if (!uuid.test(point.id) || !uuid.test(point.user_id)) throw new Error('Unexpected restore point id');
        const path = `${point.user_id}/${point.id}.json`;
        const [row] = await query(
            `select snapshot from data_recovery.restore_points where id = '${point.id}'::uuid`,
            80 * 1024 * 1024,
        );
        if (!row?.snapshot || row.snapshot.offloaded) {
            console.error(`skip ${point.id}`);
            continue;
        }
        const body = JSON.stringify(row.snapshot);
        const uploaded = await fetch(`https://gijarvlerztfggxhuvow.supabase.co/storage/v1/object/journal-backups/${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${serviceKey}`,
                apikey: serviceKey,
                'Content-Type': 'application/json',
                'x-upsert': 'true',
            },
            body,
        });
        if (!uploaded.ok) {
            const detail = await uploaded.text();
            throw new Error(`Storage upload failed (${uploaded.status}): ${detail.slice(0, 300)}`);
        }
        await query(
            `select public.mark_restore_point_offloaded('${point.id}'::uuid, '${path}', '${point.user_id}'::uuid)`,
        );
        moved += 1;
        console.error(`moved ${moved}/${candidates.length} ${point.id}`);
    }
} finally {
    await rm(workdir, { recursive: true, force: true });
}
console.error(`Done. Moved ${moved} restore points to storage.`);
