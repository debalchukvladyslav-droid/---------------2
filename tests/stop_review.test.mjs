import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStopReviewCandidates, isStopExitReason, normalizeStopExitReason } from '../js/stop_review_core.js';

test('normalizes and recognizes only the stop exit reason', () => {
    assert.equal(normalizeStopExitReason('  СтОп  '), 'стоп');
    assert.equal(isStopExitReason('СТОП'), true);
    assert.equal(isStopExitReason(' тейк '), false);
    assert.equal(isStopExitReason('по часу'), false);
    assert.equal(isStopExitReason(''), false);
});

test('groups stop trades and OCR screenshots by date and ticker', () => {
    const appData = {
        tickers: { 'screenshots/a.png': 'tsla', 'screenshots/b.png': 'TSLA', 'screenshots/c.png': 'NVDA' },
        journal: {
            '2026-07-10': {
                screenshots: { good: ['screenshots/a.png'], normal: [], bad: ['screenshots/b.png'], error: ['screenshots/c.png'] },
                trades: [
                    { symbol: 'TSLA', net: -40, stop: 320, type: 'Short', sheet: { exit: ' Стоп ', sheetRow: 21 } },
                    { symbol: 'tsla', net: -25, stop: 321, type: 'Short', sheet: { exit: 'СТОП', sheetRow: 22 } },
                    { symbol: 'NVDA', net: 50, sheet: { exit: 'тейк', sheetRow: 23 } },
                ],
            },
        },
    };
    const rows = buildStopReviewCandidates(appData, '2026-07-01', '2026-07-31');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, 'TSLA');
    assert.equal(rows[0].trade_refs.length, 2);
    assert.deepEqual(rows[0].screenshot_paths, ['screenshots/a.png', 'screenshots/b.png']);
});

test('keeps a stop candidate even when no OCR screenshot is available', () => {
    const rows = buildStopReviewCandidates({
        journal: {
            '2026-07-11': {
                trades: [{ symbol: 'AMD', net: -10, sheet: { exit: 'стоп' } }],
                screenshots: { good: ['screenshots/unknown.png'] },
            },
        },
        tickers: {},
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].screenshot_paths, []);
});
