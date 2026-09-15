import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
test('restore verification rejects corruption in either database or Storage bytes', async t => {
    const root = await mkdtemp(join(tmpdir(), 'journal-backup-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const database = Buffer.from('test database archive');
    const screenshot = Buffer.from('test image');
    await mkdir(join(root, 'storage', 'screenshots'), { recursive: true });
    await writeFile(join(root, 'database.dump'), database);
    await writeFile(join(root, 'database.sha256'), `${hash(database)}  .recovery/database.dump\n`);
    await writeFile(join(root, 'storage', 'screenshots', 'image.png'), screenshot);
    await writeFile(join(root, 'storage-manifest.json'), JSON.stringify({ version: 1, objectCount: 1, totalBytes: screenshot.length,
        objects: [{ bucket: 'screenshots', path: 'image.png', size: screenshot.length, sha256: hash(screenshot) }] }));
    const verify = () => run(process.execPath, [fileURLToPath(new URL('../scripts/verify-storage-backup.mjs', import.meta.url)), root]);
    assert.equal(JSON.parse((await verify()).stdout).verifiedObjects, 1);
    await writeFile(join(root, 'database.dump'), 'corrupted database');
    await assert.rejects(verify(), /Database archive checksum mismatch/);
    await writeFile(join(root, 'database.dump'), database);
    await writeFile(join(root, 'storage', 'screenshots', 'image.png'), 'bad image');
    await assert.rejects(verify(), /Invalid backup object/);
});
