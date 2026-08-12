import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRegistryBackfills } from '../js/screenshot_registry_core.js';

test('Drive sync backfills only screenshots missing from the registry', () => {
    const records = [
        { existingPath: 'screenshots/user/already.png' },
        { existingPath: 'screenshots/user/missing.png' },
        { existingPath: '' },
    ];
    const rows = [{ storage_path: 'screenshots/user/already.png' }];

    assert.deepEqual(selectRegistryBackfills(records, rows), [records[1]]);
});

test('Drive sync excludes ignored screenshots from registry backfill', () => {
    const records = [
        { existingPath: 'screenshots/user/ignored.png' },
        { existingPath: 'screenshots/user/missing.png' },
    ];

    assert.deepEqual(
        selectRegistryBackfills(records, [], new Set(['screenshots/user/ignored.png'])),
        [records[1]],
    );
});
