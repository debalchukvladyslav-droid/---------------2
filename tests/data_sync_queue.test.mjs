import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const store = await import('../js/local_data_store.js');
const user = '11111111-1111-4111-8111-111111111111';

test.before(async () => {
    await store.saveSyncMetadata(user, { epoch: 1, cursor: 0, nextSequence: 0, initialized: true });
});

test.after(async () => {
    await store.closeLocalDataStore();
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('strum-local-data');
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
    });
});

test('acknowledging an older save never discards a newer local edit', async () => {
    const first = await store.commitLocalChanges(user, [{
        domain: 'journal', entityId: '2026-09-15', value: { notes: 'first', pnl: 1 },
    }]);
    const second = await store.commitLocalChanges(user, [{
        domain: 'journal', entityId: '2026-09-15', value: { notes: 'second', pnl: 1 },
    }]);

    await store.acknowledgeOperations(user, [{
        operationId: first.operationIds[0], status: 'applied', version: 1, epoch: 1,
        row: { user_id: user, trade_date: '2026-09-15', notes: 'first', pnl: 1 },
    }]);

    const cached = await store.readCachedDay(user, '2026-09-15');
    assert.equal(cached.row.notes, 'second');
    assert.equal(cached.dirty, 1);
    assert.deepEqual((await store.listDataOperations(user)).map(item => item.operationId), second.operationIds);
});

test('restore epochs quarantine old edits and require an explicit choice', async () => {
    await store.applyRemoteChanges(user, { epoch: 2, cursor: 9, resetRequired: true, changes: [] });
    const [stale] = await store.listDataOperations(user);
    assert.equal(stale.status, 'stale_epoch');

    const resolved = await store.resolveDataOperation(user, stale.operationId, 'server');
    assert.equal(resolved.choice, 'server');
    assert.equal((await store.listDataOperations(user)).length, 0);
});

test('queues are isolated by account', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    await store.saveSyncMetadata(other, { epoch: 1, cursor: 0, initialized: true });
    await store.commitLocalChanges(other, [{ domain: 'settings', entityId: other, value: { theme: 'dark' } }]);
    assert.equal((await store.listDataOperations(user)).length, 0);
    assert.equal((await store.listDataOperations(other)).length, 1);
});

for (const choice of ['server', 'local']) {
    test(`resolving ${choice} preserves later edits and unrelated server fields`, async () => {
        const account = crypto.randomUUID();
        const date = '2026-09-16';
        await store.saveSyncMetadata(account, { epoch: 1, initialized: true });
        await store.cacheJournalRows(account, [{ trade_date: date, notes: 'base', pnl: 1, sync_version: 1 }]);
        const first = await store.commitLocalChanges(account, [{ domain: 'journal', entityId: date, value: { notes: 'mine', pnl: 1 } }]);
        const second = await store.commitLocalChanges(account, [{ domain: 'journal', entityId: date, value: { notes: 'mine', pnl: 2 } }]);
        await store.acknowledgeOperations(account, [{ operationId: first.operationIds[0], status: 'conflict', version: 2, epoch: 1,
            row: { notes: 'remote', pnl: 1, kf: 5 } }]);
        const resolution = await store.resolveDataOperation(account, first.operationIds[0], choice);
        const cached = await store.readCachedDay(account, date);
        assert.equal(cached.row.notes, choice === 'local' ? 'mine' : 'remote');
        assert.equal(cached.row.pnl, 2);
        assert.equal(cached.row.kf, 5);
        assert.equal(cached.dirty, 1);
        const queued = await store.listDataOperations(account);
        assert.equal(queued.at(-1).operationId, second.operationIds[0]);
        if (choice === 'local') {
            assert.equal(queued[0].operationId, resolution.operationId);
            assert.deepEqual(queued[0].patch, { notes: 'mine' });
        }
    });
    test(`resolving ${choice} after restore uses the restored server snapshot`, async () => {
        const account = crypto.randomUUID();
        const date = '2026-09-17';
        await store.saveSyncMetadata(account, { epoch: 1, initialized: true });
        await store.cacheJournalRows(account, [{ trade_date: date, notes: 'base', pnl: 1, sync_version: 1 }]);
        const first = await store.commitLocalChanges(account, [{ domain: 'journal', entityId: date, value: { notes: 'draft', pnl: 1 } }]);
        await store.replaceServerSnapshot(account, [{ trade_date: date, notes: 'restored', pnl: 9, sync_version: 10 }], { epoch: 2, cursor: 10 });
        const result = await store.resolveDataOperation(account, first.operationIds[0], choice);
        const cached = await store.readCachedDay(account, date);
        assert.equal(cached.row.notes, choice === 'local' ? 'draft' : 'restored');
        assert.equal(cached.row.pnl, 9);
        assert.equal(cached.version, 10);
        if (result.operationId) {
            await store.acknowledgeOperations(account, [{ operationId: result.operationId, status: 'applied', epoch: 2, version: 11,
                row: { notes: 'draft', pnl: 9 } }]);
            assert.equal((await store.readCachedDay(account, date)).dirty, 0);
        }
    });
}
