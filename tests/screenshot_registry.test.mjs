import test from 'node:test';
import assert from 'node:assert/strict';
import { removeScreenshotFromAppData, screenshotStillListed, selectRegistryBackfills } from '../js/screenshot_registry_core.js';

test('Drive sync backfills only screenshots missing from the registry', () => {
    const records = [
        { existingPath: 'screenshots/user/already.png' },
        { existingPath: 'screenshots/user/missing.png' },
        { existingPath: '' },
    ];
    const rows = [{ storage_path: 'screenshots/user/already.png' }];

    assert.deepEqual(selectRegistryBackfills(records, rows), [records[1]]);
});

test('deleting a screenshot removes it from the visible lists and blocks Drive from copying it back', () => {
    const path = 'screenshots/user/drive/file123/hash.png';
    const appData = {
        unassignedImages: [path, 'screenshots/user/keep.png'],
        screenMeta: { [path]: { driveId: 'file123', driveName: 'chart.png' } },
        screenTags: { [path]: ['AAPL'] },
        screenDiscipline: { [path]: 4 },
        settings: {},
        journal: {
            '2026-10-01': { screenshots: { good: [path, 'screenshots/user/keep.png'], bad: [] } },
        },
    };

    const dirty = removeScreenshotFromAppData(appData, path);

    assert.deepEqual(dirty, ['2026-10-01']);
    assert.deepEqual(appData.unassignedImages, ['screenshots/user/keep.png']);
    assert.deepEqual(appData.journal['2026-10-01'].screenshots.good, ['screenshots/user/keep.png']);
    assert.equal(appData.screenMeta[path], undefined);
    assert.equal(appData.screenTags[path], undefined);
    assert.deepEqual(appData.settings.driveDeletedIds, ['file123']);
    assert.equal(screenshotStillListed(appData, path), false);
    assert.equal(screenshotStillListed(appData, 'screenshots/user/keep.png'), true);
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
