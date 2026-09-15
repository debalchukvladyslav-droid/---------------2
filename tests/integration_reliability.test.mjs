import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPages } from '../lib/integration_io.js';
import { mergeSourceFields, mergeSiteAuthoritativeSheetRows } from '../js/integration_merge.js';

test('Drive pagination reads beyond 100 files and rejects incomplete inventories', async () => {
    const pages = new Map([
        ['', { files: Array.from({ length: 100 }, (_, index) => ({ id: `a${index}` })), nextPageToken: 'two' }],
        ['two', { files: Array.from({ length: 51 }, (_, index) => ({ id: `b${index}` })) }],
    ]);
    assert.equal((await collectPages(token => pages.get(token))).length, 151);
    await assert.rejects(collectPages(async () => ({ files: [], incompleteSearch: true })), /incomplete/i);
});

test('Google imports update their prior values and preserve later site edits', () => {
    assert.deepEqual(mergeSourceFields({ entry: 10, note: 'manual' }, { entry: 11, note: 'source' }, { entry: 10 }),
        { entry: 11, note: 'manual' });
    const journal = { '2026-09-15': { notes: 'keep me', trades: [{ symbol: 'ABC', net: 5, entry: 10,
        _sourceFields: { 'google:sheet:Trades': { fields: { entry: 10 }, sheet: {} } } }] } };
    const result = mergeSiteAuthoritativeSheetRows(journal, { '2026-09-15': [{ symbol: 'ABC', net: 5, entry: 11, sheet: {} }] },
        'sheet', { sheetTitle: 'Trades' });
    assert.equal(result.matchedSheetRows, 1);
    assert.equal(journal['2026-09-15'].notes, 'keep me');
    assert.equal(journal['2026-09-15'].trades[0].entry, 11);
});
