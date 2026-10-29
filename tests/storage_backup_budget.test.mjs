import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupStorage } from '../scripts/backup-storage.mjs';
import { reserveSharedCacheStorage } from '../supabase/functions/_shared/storage_budget.js';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'tj-storage-budget-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let downloads = 0;
    let bytes = Buffer.from('chart');
    const options = { root, url: 'https://test.invalid', key: 'test', maxDownloadBytes: 5,
        fetchImpl: async url => {
            if (url.endsWith('/bucket')) return Response.json([{ id: 'screenshots' }]);
            if (url.includes('/object/list/')) return Response.json([{ id: '1', name: 'chart.png', updated_at: 'revision-1', metadata: { size: 5 } }]);
            downloads++;
            return new Response(bytes);
        } };
    return { root, options, count: () => downloads, setBytes: value => { bytes = value; } };
}

test('a missing Storage cache cannot trigger an unbudgeted full download', async t => {
    const f = await fixture(t);
    await assert.rejects(backupStorage({ ...f.options, maxDownloadBytes: 4 }), /No files downloaded/);
    assert.equal(f.count(), 0);
    await assert.rejects(readFile(join(f.root, 'storage-manifest.json')), /ENOENT/);
});

test('unchanged, verified files survive a zero-byte download budget', async t => {
    const f = await fixture(t);
    const initial = await backupStorage(f.options);
    assert.equal(initial.downloadedBytes, 5);
    const reused = await backupStorage({ ...f.options, maxDownloadBytes: 0 });
    assert.equal(reused.reused, 1);
    assert.equal(reused.downloadedBytes, 0);
    assert.equal(f.count(), 1);
});

test('corrupt local cache or manifest never produces a verified backup', async t => {
    const f = await fixture(t);
    await backupStorage(f.options);
    await writeFile(join(f.root, 'storage/screenshots/chart.png'), 'wrong');
    await assert.rejects(backupStorage(f.options), /Checksum mismatch/);
    await writeFile(join(f.root, 'storage-manifest.json'), '{broken');
    await assert.rejects(backupStorage(f.options), /unreadable/);
    assert.equal(f.count(), 1);
});

test('an object growing after inventory is cancelled without replacing its manifest', async t => {
    const f = await fixture(t);
    f.setBytes(Buffer.from('larger than expected'));
    await assert.rejects(backupStorage(f.options), /Object grew during backup/);
    await assert.rejects(readFile(join(f.root, 'storage-manifest.json')), /ENOENT/);
});

test('derived Storage copies require the common capacity reservation', async () => {
    const requests = [];
    const rest = async (path, options) => {
        requests.push({ path, ...JSON.parse(options.body) });
        return Response.json({ allowed: false });
    };
    await assert.rejects(reserveSharedCacheStorage(rest, 'AAPL/2026-10-29.json', 100), /STORAGE_BUDGET_LIMIT/);
    assert.equal(requests[0].p_bucket, 'polygon-cache');
    assert.equal(requests[0].p_bytes, 100);
    await reserveSharedCacheStorage(async () => Response.json({ allowed: true }), 'AAPL/2026-10-29.json', 100);
    await assert.rejects(reserveSharedCacheStorage(async () => new Response('', { status: 503 }), 'path', 100), /503/);
});
