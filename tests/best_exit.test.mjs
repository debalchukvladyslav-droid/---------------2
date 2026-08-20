import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attachBestExitResult,
    bestExitWindowNY,
    collectTimedShortTrades,
    isExcludedStopTakeExit,
    isTimeExitTrade,
    summarizeBestExits,
} from '../js/best_exit_core.js';

test('recognizes only time exits', () => {
    assert.equal(isTimeExitTrade({ sheet: { exit: ' По часу ' } }), true);
    assert.equal(isTimeExitTrade({ sheet: { exit: 'стоп' } }), false);
});

test('excludes common Stop and Take spellings but keeps other closed exits', () => {
    ['stop', 'Stopped out', 'Stop Loss', 'SL', 'S/L', 'стоп', 'стопом', 'стоп-лосс', 'take', 'Take Profit', 'TP', 'T/P', 'target', 'тейк', 'тейк профіт', 'таргет'].forEach((reason) => assert.equal(isExcludedStopTakeExit({ sheet: { exit: reason } }), true, reason));
    ['по часу', 'manual', 'market', 'cover', 'закрив руками', ''].forEach((reason) => assert.equal(isExcludedStopTakeExit({ sheet: { exit: reason } }), false, reason));
});

test('collects every closed short except Stop and Take variants', () => {
    const journal = { '2026-07-10': { trades: [
        { symbol: 'AAA', type: 'Short', opened: '09:31', entry: 10, exit: 9, sheet: { exit: 'manual' } },
        { symbol: 'BBB', type: 'Short', opened: '09:32', entry: 10, exit: 11, sheet: { exit: 'Stop Loss' } },
        { symbol: 'CCC', type: 'Short', opened: '09:33', entry: 10, exit: 8, sheet: { exit: 'TP' } },
        { symbol: 'DDD', type: 'Short', opened: '09:34', entry: 10, exit: 9.5, closeReason: 'cover' },
        { symbol: 'EEE', type: 'Short', opened: '09:35', entry: 10 },
    ] } };
    assert.deepEqual(collectTimedShortTrades(journal).map((row) => row.symbol), ['AAA', 'DDD']);
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
                { symbol: 'AAPL', type: 'Short', opened: '11:59:00', entry: 10, exit: 9, sheet: { exit: 'по часу' } },
                { symbol: 'TSLA', type: 'Short', opened: '12:00:00', entry: 20, exit: 19, sheet: { exit: 'по часу' } },
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
    assert.equal(summary.avgCapturePct, 50);
});

test('formats the profitable exit minute as an aligned ten-minute New York window', () => {
    assert.equal(bestExitWindowNY('2026-07-10T14:47:00.000Z'), '10:40–10:49');
    assert.equal(bestExitWindowNY('2026-01-10T16:59:00.000Z'), '11:50–11:59');
    assert.equal(bestExitWindowNY('2026-07-10T16:00:00.000Z'), '');
    assert.equal(bestExitWindowNY('2026-07-10T17:32:00.000Z'), '');
    assert.equal(bestExitWindowNY('invalid'), '');
});

test('rejects cached best exits at noon or later in New York', () => {
    const trade = { entryPrice: 10, actualExitPrice: 9, qty: 100, symbol: 'AAPL', date: '2026-07-10' };
    assert.equal(attachBestExitResult(trade, { low: 8, lowTime: '2026-07-10T16:00:00.000Z' }), null);
    assert.equal(attachBestExitResult(trade, { low: 7, lowTime: '2026-07-10T17:32:00.000Z' }), null);
});
