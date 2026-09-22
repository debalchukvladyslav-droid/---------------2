import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as store from '../js/local_data_store.js';
import { createDataSyncEngine } from '../js/data_sync_engine.js';
import { fetchExcelDownload } from '../js/excel_download_core.js';
import { readSheetRangePages } from '../js/sheet_range_paging.js';
import { isRetryableSyncError } from '../js/data_sync_core.js';
import { rebaseUploadEpoch } from '../js/upload_queue_core.js';
import { loadBootProfile } from '../js/boot_profile.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });
test.after(() => store.closeLocalDataStore());
const date = '2026-09-17';
async function fixture() {
    const user = crypto.randomUUID();
    await store.saveSyncMetadata(user, { epoch: 1, cursor: 0, initialized: true });
    await store.cacheJournalRows(user, [{ trade_date: date, notes: 'base', pnl: 1, sync_version: 1 }]);
    const save = value => store.commitLocalChanges(user, [{ domain: 'journal', entityId: date, value }]);
    return { user, save };
}

for (const restored of [false, true]) {
    test(`local policy resumes persisted ${restored ? 'restore epoch' : 'conflict'} after reopening`, async () => {
        const { user, save } = await fixture();
        const first = await save({ notes: 'mine', pnl: 1 });
        await save({ notes: 'newest', pnl: 2 });
        const epoch = restored ? 2 : 1;
        if (restored) await store.replaceServerSnapshot(user, [{ trade_date: date, notes: 'restored', pnl: 9, kf: 5, sync_version: 10 }], { epoch, cursor: 10, initialized: true });
        else await store.acknowledgeOperations(user, [{ operationId: first.operationIds[0], status: 'conflict', epoch, version: 10, row: { notes: 'remote', pnl: 9, kf: 5 } }]);
        await store.closeLocalDataStore();
        let remote = { notes: 'remote', pnl: 9, kf: 5 };
        const { applyMergePatch } = await import('../js/data_sync_core.js');
        const engine = createDataSyncEngine({ store, conflictPolicy: 'local', schedule: () => 1, cancel() {},
            lock: async (_user, run) => run(), transport: {
                pull: async () => ({ epoch, cursor: 10, changes: [], hasMore: false }),
                apply: async (_user, operations) => ({ results: operations.map(operation => {
                    assert.equal(operation.epoch, epoch);
                    remote = applyMergePatch(remote, operation.patch);
                    return { operationId: operation.operationId, status: 'applied', epoch, version: 11, row: remote };
                }) }),
            },
        });
        engine.start(user);
        try { await engine.flush(); } finally { engine.stop(); }
        assert.equal((await store.listDataOperations(user)).length, 0);
        assert.equal(remote.notes, 'newest');
        assert.equal(remote.pnl, 2);
        assert.equal(remote.kf, 5);
        assert.equal((await store.readCachedDay(user, date)).row.notes, 'newest');
    });
}

test('duplicate acknowledgement cannot regress a newer pulled server revision', async () => {
    const { user, save } = await fixture();
    const pending = await save({ notes: 'mine', pnl: 1 });
    await store.applyRemoteChanges(user, { epoch: 1, cursor: 3, changes: [{ domain: 'journal', entityId: date, version: 3, epoch: 1, record: { notes: 'later server', pnl: 7 } }] });
    await store.acknowledgeOperations(user, [{ operationId: pending.operationIds[0], status: 'duplicate', epoch: 1, version: 2, row: { notes: 'mine', pnl: 1 } }]);
    const cached = await store.readCachedDay(user, date);
    assert.equal(cached.version, 3);
    assert.equal(cached.row.notes, 'later server');
    assert.equal(cached.row.pnl, 7);
});

test('snapshot rebases visible drafts without dropping later old-epoch edits', async () => {
    const { user, save } = await fixture();
    const first = await save({ notes: 'mine', pnl: 1 });
    await save({ notes: 'newest', pnl: 2 });
    await store.replaceServerSnapshot(user, [{ trade_date: date, notes: 'restored', pnl: 9, kf: 5, sync_version: 10 }], { epoch: 2, cursor: 10 });
    assert.equal((await store.readCachedDay(user, date)).row.notes, 'newest');
    await store.resolveDataOperation(user, first.operationIds[0], 'local');
    const cached = await store.readCachedDay(user, date);
    assert.equal(cached.row.notes, 'newest');
    assert.equal(cached.row.pnl, 2);
    assert.equal(cached.row.kf, 5);
});

test('Excel JSON response is followed to the actual workbook without leaking auth', async () => {
    const requests = [];
    const result = await fetchExcelDownload('private-jwt', async (url, options) => {
        requests.push({ url, options });
        return requests.length === 1 ? Response.json({ ok: true, downloadUrl: 'https://example.supabase.co/signed/file', filename: 'audit.xlsx' })
            : new Response(new Uint8Array([0x50, 0x4b, 3, 4]));
    });
    assert.equal(result.filename, 'audit.xlsx');
    assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [0x50, 0x4b, 3, 4]);
    assert.equal(requests[1].options.headers, undefined);
    await assert.rejects(fetchExcelDownload('jwt', async url => url === '/api/export'
        ? Response.json({ ok: true, downloadUrl: 'https://example.supabase.co/file' }) : new Response('', { status: 503 })), /503/);
});

test('large sheet pagination preserves gaps, hyperlinks and fails on network interruption', async () => {
    const ranges = [];
    const rows = await readSheetRangePages("'Trades'!A6:ZZ", { rowCount: async () => 1206, read: async range => {
        ranges.push(range);
        if (ranges.length !== 3) return [];
        const result = [['last page trade']]; result.hyperlinks = [['https://example.com/screen']]; return result;
    } });
    assert.deepEqual(ranges, ["'Trades'!A6:ZZ505", "'Trades'!A506:ZZ1005", "'Trades'!A1006:ZZ1206"]);
    assert.equal(rows[1000][0], 'last page trade');
    assert.equal(rows.hyperlinks[1000][0], 'https://example.com/screen');
    await assert.rejects(readSheetRangePages('A1:ZZ1001', { read: async range => {
        if (range.startsWith('A501:')) throw new TypeError('network interrupted');
        return [['first']];
    } }), /network interrupted/);
});

test('HTTP request timeout remains retryable without blocking durable edits', () => {
    assert.equal(isRetryableSyncError({ status: 408 }), true);
    assert.equal(isRetryableSyncError({ status: 429 }), true);
    assert.equal(isRetryableSyncError({ code: '22023', status: 400 }), false);
});

test('restored upload keeps its bytes, identity and TUS offset when rebased', async () => {
    const job = { id: 'audit', userId: 'owner', path: 'screenshots/owner/a.png', epoch: 1, blob: new Blob(['bytes']), offset: 3, sessionUrl: 'https://storage.example/tus/id', needsAttention: true };
    let saved;
    const rebased = await rebaseUploadEpoch(job, 2, async value => { saved = value; });
    assert.equal(saved, rebased);
    assert.equal(rebased.blob, job.blob);
    assert.equal(rebased.sessionUrl, job.sessionUrl);
    assert.equal(rebased.offset, 3);
    assert.equal(rebased.epoch, 2);
    assert.equal(rebased.needsAttention, false);
    await assert.rejects(rebaseUploadEpoch(job, 3, async () => { throw new Error('quota'); }), /quota/);
    assert.equal(job.epoch, 1);
});

test('quota failure rolls back both the visible draft and queue, then recovery succeeds', async () => {
    const { user, save } = await fixture();
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'sync-queue') throw new DOMException('Storage full', 'QuotaExceededError');
        return original.apply(this, args);
    };
    try { await assert.rejects(save({ notes: 'not committed', pnl: 1 }), { name: 'QuotaExceededError' }); }
    finally { IDBObjectStore.prototype.add = original; }
    assert.equal((await store.readCachedDay(user, date)).row.notes, 'base');
    assert.equal((await store.listDataOperations(user)).length, 0);
    await save({ notes: 'retry preserved', pnl: 1 });
    assert.equal((await store.listDataOperations(user)).length, 1);
});

test('service worker revalidates assets and does not cache an error navigation', async () => {
    const listeners = {};
    const calls = [];
    const writes = [];
    vm.runInNewContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), {
        URL, self: { addEventListener: (event, callback) => { listeners[event] = callback; } }, location: { origin: 'https://audit.test' },
        fetch: async (request, options) => { calls.push(options); return new Response('unavailable', { status: 503 }); },
        caches: { open: async () => ({ put: (...args) => writes.push(args) }) },
    });
    for (const request of [{ method: 'GET', url: 'https://audit.test/js/storage.js', destination: 'script' },
        { method: 'GET', url: 'https://audit.test/', mode: 'navigate' }]) {
        let result; listeners.fetch({ request, respondWith: promise => { result = promise; } });
        assert.equal((await result).status, 503);
    }
    assert.ok(calls.every(call => call.cache === 'no-cache'));
    assert.equal(writes.length, 0);
});

test('PWA registers when initialized after the window load event', async () => {
    const registrations = [];
    const source = (await readFile(new URL('../js/pwa.js', import.meta.url), 'utf8')).replaceAll('export function', 'function');
    vm.runInNewContext(`${source}\ninitPwa();`, {
        navigator: { serviceWorker: { addEventListener() {}, register: async (path, options) => { registrations.push({ path, options }); return { update() {} }; } } },
        location: { protocol: 'https:', hostname: 'audit.test' },
        document: { readyState: 'complete', documentElement: { classList: { toggle() {} } } },
        window: { matchMedia: () => ({ matches: false }), addEventListener() { throw new Error('load already fired'); } }, console,
    });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.updateViaCache, 'none');
});

test('offline restart keeps cached owner profile and network failure never becomes account rejection', async () => {
    const saved = new Map();
    const options = { readCached: async user => ({ value: saved.get(user) }), cache: async (user, _key, value) => saved.set(user, value),
        read: async () => ({ data: { nick: 'audit', role: 'trader', settings: { account_approved: true, screenMeta: { huge: 'excluded' } } } }) };
    await loadBootProfile('owner', options);
    assert.equal(saved.get('owner').settings.screenMeta, undefined);
    const offline = await loadBootProfile('owner', { ...options, online: false, read: () => { throw new Error('offline network called'); } });
    assert.equal(offline.data.nick, 'audit');
    await assert.rejects(loadBootProfile('other', { ...options, online: false }));
    await assert.rejects(loadBootProfile('owner', { ...options, read: async () => ({ error: new Error('Failed to fetch') }) }), /Failed to fetch/);
});
