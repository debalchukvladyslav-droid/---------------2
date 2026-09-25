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

test('shared workbook bootstrap opens every sheet in a preset book', () => {
    assert.equal(canBootstrapSharedTraderSheet(trader, presetId), true);
    assert.equal(canBootstrapSharedTraderSheet(trader, presetId, '  дебальчук '), true);
    assert.equal(canBootstrapSharedTraderSheet(trader, presetId, 'Іваненко'), true);
    assert.equal(canBootstrapSharedTraderSheet(trader, '1b4eep8h6YOB8_-i4_ug2p8BuYd4Cfo7IqAIrGG2W23M'), true);
    assert.equal(canBootstrapSharedTraderSheet(trader, 'unknown-sheet'), false);
    assert.equal(canBootstrapSharedTraderSheet({ role: 'trader', last_name: '' }, presetId), false);
    assert.equal(canBootstrapSharedTraderSheet({ role: 'admin', last_name: 'Дебальчук' }, presetId), false);
});

test('bootstrap metadata lists every sheet so the trader can choose', () => {
    const connection = { bootstrap: true, ownerSheetTitle: 'Дебальчук', ownerFirstName: 'Влад', ownerNick: 'andvav', scope: '' };
    const sheets = [
        { title: 'Іваненко', index: 0 },
        { title: 'Дебальчук', index: 1 },
        { title: 'Дебальчук Андрій', index: 2 },
        { title: 'Кость', index: 3 },
    ];
    assert.deepEqual(visibleSpreadsheetSheets(sheets, connection).map((sheet) => sheet.title), ['Іваненко', 'Дебальчук', 'Дебальчук Андрій', 'Кость']);
    assert.equal(assertBootstrapSheetRange(connection, "'Іваненко'!A1:ZZ1"), 'Іваненко');
    assert.equal(assertBootstrapSheetRange(connection, "'Дебальчук Андрій'!A1:ZZ1"), 'Дебальчук Андрій');
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
