import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataSyncEngine } from '../js/data_sync_engine.js';

test('later edits of a conflicted entity are not sent before resolution', async () => {
    const queue = [1, 2].map(n => ({ operationId: String(n), userId: 'owner', domain: 'journal', entityId: '2026-09-15', status: 'pending' }));
    const sent = [];
    const engine = createDataSyncEngine({
        store: {
            readSyncMetadata: async () => ({ epoch: 1, cursor: 0 }),
            listDataOperations: async () => queue,
            applyRemoteChanges: async () => ({ changed: [] }),
            acknowledgeOperations: async (_user, results) => {
                for (const result of results) queue.find(op => op.operationId === result.operationId).status = result.status;
                return [];
            },
        },
        transport: {
            pull: async () => ({ epoch: 1, cursor: 0, changes: [] }),
            apply: async (_user, operations) => {
                sent.push(...operations.map(op => op.operationId));
                return { results: operations.map(op => ({ operationId: op.operationId, status: 'conflict' })) };
            },
        },
        lock: async (_user, run) => run(),
        schedule: () => 1, cancel: () => {},
    });
    engine.start('owner');
    await assert.rejects(engine.flush(), { code: 'SYNC_CONFLICT' });
    assert.deepEqual(sent, ['1']);
    assert.equal(queue[1].status, 'pending');
    engine.stop();
});

test('account switch during a network request schedules synchronization for the new account', async () => {
    let release;
    const suspended = new Promise(resolve => { release = resolve; });
    const seen = [];
    let scheduled;
    const engine = createDataSyncEngine({
        store: {
            readSyncMetadata: async () => ({ epoch: 1, cursor: 0 }),
            listDataOperations: async () => [],
            applyRemoteChanges: async () => ({ changed: [] }),
        },
        transport: { pull: async user => {
            seen.push(user);
            if (user === 'old') await suspended;
            return { epoch: 1, cursor: 0, changes: [] };
        } },
        lock: async (_user, run) => run(),
        schedule: (callback, delay) => { scheduled = { callback, delay }; return 1; },
        cancel: () => { scheduled = null; },
    });
    engine.start('old');
    const oldRequest = engine.sync();
    await new Promise(resolve => setImmediate(resolve));
    engine.start('new');
    const waiting = engine.sync();
    release();
    await Promise.all([oldRequest, waiting]);
    assert.equal(scheduled.delay, 0);
    await engine.sync();
    assert.ok(seen.includes('new'));
    engine.stop();
});
