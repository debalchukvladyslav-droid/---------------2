import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('first import checks all three preset spreadsheets by exact profile last name', async () => {
    const source = await readFile(new URL('../js/google_sheet_connector.js', import.meta.url), 'utf8');
    const ids = [...source.matchAll(/'1[A-Za-z0-9_-]{20,}'/g)].map((match) => match[0]);
    assert.ok(new Set(ids).size >= 3);
    assert.match(source, /profile\?\.last_name/);
    assert.match(source, /normalizeExactSheetTitle\(sheet\.title\) === wanted/);
    assert.doesNotMatch(source.match(/export async function autoConnectTraderSheet[\s\S]*?\n}\n/)?.[0] || '', /includes\(wanted\)|wanted\.includes/);
    assert.match(source, /autoMapSheetColumns\(\{ silent: true \}\)/);
    assert.match(source, /await saveSheetMapping\(\)/);
});

test('admin testing panel exposes a force-run Auto table button only in admin rendering', async () => {
    const [admin, partial] = await Promise.all([
        readFile(new URL('../js/admin.js', import.meta.url), 'utf8'),
        readFile(new URL('../partials/views/admin-panel.html', import.meta.url), 'utf8'),
    ]);
    assert.match(partial, /id="admin-testing-panel"[^>]*hidden/);
    assert.match(admin, /if \(testingPanel\) testingPanel\.hidden = !fullAdmin/);
    assert.match(admin, /Автотаблиця/);
    assert.match(admin, /autoConnectTraderSheet\(\{ force: true \}\)/);
});
