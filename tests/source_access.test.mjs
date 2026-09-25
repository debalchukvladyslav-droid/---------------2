import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    SHARED_TRADER_SPREADSHEET_IDS,
    canBootstrapSharedTraderSheet,
    visibleSpreadsheetSheets,
    assertBootstrapSheetRange,
} from '../lib/source_access.js';

const presetId = SHARED_TRADER_SPREADSHEET_IDS[0];
const trader = { role: 'trader', last_name: 'Дебальчук' };

test('shared workbook bootstrap allows only the profile last name', () => {
    assert.equal(canBootstrapSharedTraderSheet(trader, presetId), true);
    assert.equal(canBootstrapSharedTraderSheet(trader, presetId, '  дебальчук '), true);
    assert.equal(canBootstrapSharedTraderSheet(trader, presetId, 'Іваненко'), false);
    assert.equal(canBootstrapSharedTraderSheet(trader, 'unknown-sheet'), false);
    assert.equal(canBootstrapSharedTraderSheet({ role: 'trader', last_name: '' }, presetId), false);
    assert.equal(canBootstrapSharedTraderSheet({ role: 'admin', last_name: 'Дебальчук' }, presetId), false);
});

test('bootstrap metadata and ranges stay on the owner sheet', () => {
    const connection = { bootstrap: true, ownerSheetTitle: 'Дебальчук', scope: '' };
    const sheets = [
        { title: 'Іваненко', index: 0 },
        { title: 'Дебальчук', index: 1 },
        { title: 'Кость', index: 2 },
    ];
    assert.deepEqual(visibleSpreadsheetSheets(sheets, connection).map((sheet) => sheet.title), ['Дебальчук']);
    assert.equal(assertBootstrapSheetRange(connection, "'Дебальчук'!A1:ZZ1"), 'Дебальчук');
    assert.throws(() => assertBootstrapSheetRange(connection, "'Іваненко'!A1:ZZ1"), (error) => error.code === 'SOURCE_CONNECTION_REQUIRED');
    assert.throws(() => assertBootstrapSheetRange(connection, 'A1:ZZ1'), (error) => error.code === 'SOURCE_CONNECTION_REQUIRED');
});

test('preset ids and sheet read gate stay wired together', async () => {
    const [connector, view, sheetsService, syncConfig] = await Promise.all([
        readFile(new URL('../js/google_sheet_connector.js', import.meta.url), 'utf8'),
        readFile(new URL('../partials/views/sheet-import-view.html', import.meta.url), 'utf8'),
        readFile(new URL('../api/sheets-service.js', import.meta.url), 'utf8'),
        readFile(new URL('../api/google-sheet-sync-config.js', import.meta.url), 'utf8'),
    ]);
    for (const id of SHARED_TRADER_SPREADSHEET_IDS) {
        assert.match(connector, new RegExp(id));
        assert.match(view, new RegExp(id));
    }
    assert.match(sheetsService, /resolveSheetReadAccess/);
    assert.match(sheetsService, /visibleSpreadsheetSheets/);
    assert.match(sheetsService, /assertBootstrapSheetRange/);
    assert.match(syncConfig, /canBootstrapSharedTraderSheet/);
});
