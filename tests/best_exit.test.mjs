import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attachBestExitResult,
    collectTimedShortTrades,
    isTimeExitTrade,
    summarizeBestExits,
} from '../js/best_exit_core.js';

test('recognizes only time exits', () => {
    assert.equal(isTimeExitTrade({ sheet: { exit: ' По часу ' } }), true);
    assert.equal(isTimeExitTrade({ sheet: { exit: 'стоп' } }), false);
});

test('collects short time exits from the selected dates and clamps entry to market open', () => {
    const journal = {
        '2026-07-10': {
            trades: [
                { symbol: 'AAPL', type: 'Short', opened: '2026-07-10 09:12:00', entry: 10, exit: 9, qty: 100, sheet: { exit: 'по часу' } },
                { symbol: 'TSLA', type: 'Long', opened: '09:45:00', entry: 20, sheet: { exit: 'по часу' } },
            ],
        },
        '2026-07-11': {
            trades: [{ symbol: 'AMD', type: 'Short', opened: '09:50:00', entry: 5, sheet: { exit: 'по часу' } }],
        },
    };
    const rows = collectTimedShortTrades(journal, new Set(['2026-07-10']));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entryMinute, 570);
    assert.equal(rows[0].symbol, 'AAPL');
});

test('excludes a time exit opened at or after noon New York', () => {
    const journal = {
        '2026-07-10': {
            trades: [
                { symbol: 'AAPL', type: 'Short', opened: '11:59:00', entry: 10, sheet: { exit: 'по часу' } },
                { symbol: 'TSLA', type: 'Short', opened: '12:00:00', entry: 20, sheet: { exit: 'по часу' } },
            ],
        },
    };
    const rows = collectTimedShortTrades(journal, new Set(['2026-07-10']));
    assert.deepEqual(rows.map((row) => row.symbol), ['AAPL']);
});

test('calculates best short exit and aggregate opportunity', () => {
    const row = attachBestExitResult(
        { entryPrice: 10, actualExitPrice: 9, qty: 100, symbol: 'AAPL', date: '2026-07-10' },
        { low: 8, lowTime: '2026-07-10T15:00:00.000Z' },
    );
    assert.equal(row.bestPnl, 200);
    assert.equal(row.extraPnl, 100);
    assert.equal(row.capturePct, 50);
    const summary = summarizeBestExits([row]);
    assert.equal(summary.bestPnl, 200);
    assert.equal(summary.extraPnl, 100);
});
