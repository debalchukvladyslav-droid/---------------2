import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingDriveFiles, runDriveSourceSync } from '../lib/source_worker.js';

const file = { id: 'file-1', name: 'chart.png', mimeType: 'image/png', size: '100', modifiedTime: '2026-10-29T09:00:00Z' };
const connection = { id: 'connection', user_id: 'owner', resource_id: 'folder' };

function dependencies(files = [file]) {
    const calls = [];
    let epoch = 1;
    return { calls, setEpoch: value => { epoch = value; }, options: {
        getToken: async () => 'token',
        driveJson: async (path, token, query) => { assert.equal(query.pageSize, '1000'); return { files }; },
        rest: async (path, init) => {
            calls.push(path);
            return path.endsWith('get_source_sync_state') ? { epoch } : { skipped: false };
        },
        restAll: async path => { calls.push(path); return []; },
    } };
}

test('unchanged Drive inventory reads only the small epoch response from Supabase', async () => {
    const f = dependencies();
    const first = await runDriveSourceSync(connection, f.options);
    assert.equal(first.copied, 1);
    assert.ok(first.revision.startsWith('drive-v2:'));
    f.calls.length = 0;
    const next = await runDriveSourceSync({ ...connection, last_revision: first.revision }, f.options);
    assert.equal(next.unchanged, true);
    assert.deepEqual(f.calls, ['rpc/get_source_sync_state']);
    f.setEpoch(2);
    await runDriveSourceSync({ ...connection, last_revision: first.revision }, f.options);
    assert.ok(f.calls.some(path => path.startsWith('screenshots?')));
});

test('an interrupted indexing pass cannot be mistaken for a completed revision', async () => {
    const f = dependencies();
    const interrupted = await runDriveSourceSync(connection, { ...f.options, deadline: 0 });
    assert.equal(interrupted.continue, true);
    assert.equal(interrupted.revision, null);
    const resumed = await runDriveSourceSync({ ...connection, last_revision: interrupted.revision }, f.options);
    assert.equal(resumed.copied, 1);
    assert.equal(resumed.continue, false);
});

test('Drive result ordering does not cause another full registry read', async () => {
    const files = [file, { ...file, id: 'file-2' }];
    const f = dependencies(files);
    const first = await runDriveSourceSync(connection, f.options);
    files.reverse();
    f.calls.length = 0;
    assert.equal((await runDriveSourceSync({ ...connection, last_revision: first.revision }, f.options)).unchanged, true);
    assert.equal(f.calls.length, 1);
});

test('Drive reconciliation preserves deleted files and accepts only valid matching timestamps', () => {
    const files = [file, { ...file, id: 'deleted' }, { ...file, id: 'new' }, { ...file, id: 'bad-date', modifiedTime: 'bad' }];
    const rows = [{ source_file_id: file.id, source_modified_at: file.modifiedTime },
        { source_file_id: 'deleted', deleted_at: '2026-10-29' }, { source_file_id: 'bad-date', source_modified_at: 'bad' }];
    assert.deepEqual(pendingDriveFiles(files, rows).map(item => item.id), ['new', 'bad-date']);
});
