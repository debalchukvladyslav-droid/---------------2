import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attachBestExitResult,
    bestExitWindowNY,
    buildExitTimeCaptureSeries,
    buildLowTimeFrequencySeries,
    calculateShortExitComparison,
    collectTimedShortTrades,
    isExcludedStopTakeExit,
    isMarketOpenStopTrade,
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

test('collects closed shorts with a known exit reason except Stop and Take variants', () => {
    const journal = { '2026-07-10': { trades: [
        { symbol: 'AAA', type: 'Short', opened: '09:31', entry: 10, exit: 9, sheet: { exit: 'manual' } },
        { symbol: 'BBB', type: 'Short', opened: '09:32', entry: 10, exit: 11, sheet: { exit: 'Stop Loss' } },
        { symbol: 'CCC', type: 'Short', opened: '09:33', entry: 10, exit: 8, sheet: { exit: 'TP' } },
        { symbol: 'DDD', type: 'Short', opened: '09:34', entry: 10, exit: 9.5, closeReason: 'cover' },
        { symbol: 'EMPTY', type: 'Short', opened: '09:35', entry: 10, exit: 9.4 },
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
    assert.equal(rows[0].tradeIndex, 0);
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

test('detects a losing position held through the 09:30 NY market open', () => {
    assert.equal(isMarketOpenStopTrade({ opened: '2026-08-20 08:45', closed: '2026-08-20 09:31', net: -100 }, '2026-08-20'), true);
    assert.equal(isMarketOpenStopTrade({ opened: '2026-08-19 16:00', closed: '2026-08-20 09:35', net: -50 }, '2026-08-20'), true);
    assert.equal(isMarketOpenStopTrade({ opened: '08:45', closed: '09:29', net: -100 }, '2026-08-20'), false);
    assert.equal(isMarketOpenStopTrade({ opened: '09:30', closed: '09:40', net: -100 }, '2026-08-20'), false);
    assert.equal(isMarketOpenStopTrade({ opened: '08:45', closed: '09:40', net: 20 }, '2026-08-20'), false);
});

test('market-open stop filter includes only automatically detected losses, including Stop and blank reasons', () => {
    const journal = { '2026-08-20': { trades: [
        { symbol: 'AAA', type: 'Short', opened: '08:40', closed: '09:31', entry: 10, exit: 11, net: -100, sheet: { exit: 'Stop Loss' } },
        { symbol: 'BBB', type: 'Short', opened: '08:50', closed: '09:45', entry: 5, exit: 6, net: -50 },
        { symbol: 'CCC', type: 'Short', opened: '09:31', closed: '09:45', entry: 5, exit: 6, net: -50, sheet: { exit: 'manual' } },
    ] } };
    const rows = collectTimedShortTrades(journal, null, { marketOpenStopsOnly: true });
    assert.deepEqual(rows.map((row) => row.symbol), ['AAA', 'BBB']);
    assert.ok(rows.every((row) => row.isMarketOpenStop));
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

test('calculates hypothetical short Gross from entry, selected price and shares', () => {
    assert.deepEqual(calculateShortExitComparison({ entryPrice: 10, actualExitPrice: 9.4, selectedPrice: 8.9, qty: 500 }), {
        actualGross: 300,
        selectedGross: 550,
        difference: 250,
    });
    assert.equal(calculateShortExitComparison({ entryPrice: 10, actualExitPrice: 9, selectedPrice: 8, qty: null }), null);
});

test('groups captured movement by ten-minute actual exit windows', () => {
    const series = buildExitTimeCaptureSeries([
        { exitMinute: 601, capturePct: 40 },
        { exitMinute: 609, capturePct: 80 },
        { exitMinute: 615, capturePct: 90 },
        { exitMinute: 721, capturePct: 100 },
        { exitMinute: 620, capturePct: null },
    ]);
    assert.deepEqual(series, [
        { minute: 600, label: '10:00', capturePct: 60, count: 2 },
        { minute: 610, label: '10:10', capturePct: 90, count: 1 },
    ]);
});

test('builds low-time percentages from Polygon lows independently of actual exits', () => {
    const series = buildLowTimeFrequencySeries([
        { lowTime: '2026-07-10T14:42:00.000Z', exitMinute: 580 },
        { lowTime: '2026-07-11T14:47:00.000Z', exitMinute: 700 },
        { lowTime: '2026-07-12T15:05:00.000Z', exitMinute: null },
        { lowTime: '' },
    ]);
    assert.equal(series.length, 2);
    assert.deepEqual({ ...series[0], percent: undefined }, { minute: 640, label: '10:40', percent: undefined, count: 2, total: 3 });
    assert.deepEqual({ ...series[1], percent: undefined }, { minute: 660, label: '11:00', percent: undefined, count: 1, total: 3 });
    assert.ok(Math.abs(series[0].percent - 200 / 3) < 1e-10);
    assert.ok(Math.abs(series[1].percent - 100 / 3) < 1e-10);
});

test('low-time frequency can ignore every low before 10:00 NY', () => {
    const rows = [
        { lowTime: '2026-07-10T13:45:00.000Z' },
        { lowTime: '2026-07-10T14:05:00.000Z' },
        { lowTime: '2026-07-10T14:07:00.000Z' },
    ];
    const series = buildLowTimeFrequencySeries(rows, { minMinute: 600 });
    assert.equal(series.length, 1);
    assert.deepEqual({ ...series[0], percent: Math.round(series[0].percent) }, { minute: 600, label: '10:00', percent: 100, count: 2, total: 2 });
});

test('keeps waiting when Polygon has not returned a market row yet', () => {
    assert.equal(attachBestExitResult({ entryPrice: 10, actualExitPrice: 9 }, null), null);
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
