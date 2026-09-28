import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analysisPrompt,
    collectExportTrades,
    formulaStopPrice,
    resolveTradeStop,
} from '../js/research_export_core.js';

test('stop for a take or time exit is entry plus consolidation cents', () => {
    assert.equal(formulaStopPrice(1.03, 10), 1.13);
    const journal = { '2026-06-02': { trades: [
        { symbol: 'ABC', type: 'Short', opened: '10:05:00', closed: '11:10:00', entry: 1.03, exit: 0.9, qty: 500, net: 65, sheet: { exit: 'по часу', entryPrice: 1.03, consolidateCents: 10, tradeType: 'Синя' } },
        { symbol: 'DEF', type: 'Short', opened: '10:06', closed: '10:40', entry: 1.03, exit: 0.8, qty: 100, net: 23, sheet: { exit: 'тейк', consolidateCents: '10' } },
    ] } };
    const trades = collectExportTrades(journal, { includePolygon: false });
    assert.equal(trades[0].stop.price, 1.13);
    assert.equal(trades[0].stop.source, 'sheet');
    assert.equal(trades[1].stop.price, 1.13);
    assert.equal(trades[1].stop.source, 'sheet');
    assert.equal(trades[1].exitPrice, 0.8);
});

test('a buy after the short is the stop line', () => {
    const stopped = resolveTradeStop({ isShort: true, entryPrice: 1.03, exitPrice: 1.2, exitReason: 'стоп', consolidateCents: 10 });
    assert.equal(stopped.price, 1.2);
    assert.equal(stopped.source, 'cover');
    const unlabeled = resolveTradeStop({ isShort: true, entryPrice: 1.03, exitPrice: 1.18, exitReason: '', consolidateCents: 10 });
    assert.equal(unlabeled.price, 1.18);
    assert.equal(unlabeled.source, 'cover');
});

test('drops setups that were not taken and names each chart', () => {
    const journal = { '2026-06-02': { trades: [
        { symbol: 'SKIP', type: 'не брав', entry: 1, exit: 1.1, sheet: { tradeType: 'не брав' } },
        { symbol: 'ABC', type: 'Short', opened: '09:31', entry: 2, exit: 1.8, sheet: { tradeType: 'фіолетова не брав', exit: 'тейк', consolidateCents: 20 } },
        { symbol: 'ABC', type: 'Short', opened: '10:01', entry: 1.03, exit: 0.95, sheet: { exit: 'по часу', consolidateCents: 10, tradeType: 'Зелена' } },
        { symbol: 'ABC', type: 'Short', opened: '10:20', entry: 1.1, exit: 1, sheet: { exit: 'тейк', consolidateCents: 8, tradeType: 'Зелена' } },
    ] } };
    const trades = collectExportTrades(journal);
    assert.deepEqual(trades.map((trade) => trade.chart), ['charts/2026-06-02_ABC_1.png', 'charts/2026-06-02_ABC_2.png']);
    assert.equal(trades[0].entryPrice, 1.03);
});

test('says when a stop cannot be calculated', () => {
    const stop = resolveTradeStop({ isShort: true, entryPrice: 1.03, exitPrice: 0.9, exitReason: 'тейк' });
    assert.equal(stop.price, null);
    assert.match(stop.note, /немає консолідації/i);
});

test('reads consolidation from the main sheet, then the cumulative sheet', () => {
    const journal = { '2026-06-03': { trades: [
        { symbol: 'MAIN', type: 'Short', opened: '09:40', entry: 1.03, exit: 0.97, net: 30 },
        { symbol: 'CUM', type: 'Short', opened: '09:41', entry: 2, exit: 1.7, net: 40 },
    ] } };
    const sheetRows = { book: { '2026-06-03': [
        { symbol: 'MAIN', sheet: { entryPrice: 1.03, consolidateCents: 10, exit: 'по часу', growthPct: 80, traderComment: 'чисто' } },
    ] } };
    const cumulativeSheetRows = { book: { '2026-06-03': [
        { symbol: 'MAIN', sheet: { entryPrice: 1.03, consolidateCents: 99, exit: 'стоп' } },
        { symbol: 'CUM', sheet: { entryPrice: 2, consolidateCents: 15, exit: 'тейк', riskUsd: 50 } },
    ] } };
    const trades = collectExportTrades(journal, { sheetRows, cumulativeSheetRows, includeSheet: true, includePolygon: false });
    assert.equal(trades[0].stop.price, 1.13);
    assert.equal(trades[0].stop.source, 'sheet');
    assert.equal(trades[0].sheet.growthPct, 80);
    assert.equal(trades[0].sheet.traderComment, 'чисто');
    assert.equal(trades[1].stop.price, 2.15);
    assert.equal(trades[1].sheet.riskUsd, 50);
    assert.equal(trades[1].polygon, undefined);
});

test('polygon criteria stay null until they exist and can be left out', () => {
    const journal = { '2026-06-04': { trades: [
        { symbol: 'ATR', type: 'Short', opened: '09:31', entry: 4, exit: 3.5, marketCriteria: { atr: 0.42, vol_pre_by_minute: { '571': 2500000 }, shs_float_display: '3.2M' } },
    ], tradePolygons: {} } };
    const [withPolygon] = collectExportTrades(journal, { includeSheet: false });
    assert.equal(withPolygon.sheet, undefined);
    assert.equal(withPolygon.polygon.atr, 0.42);
    assert.equal(withPolygon.polygon.volPre, 2500000);
    assert.equal(withPolygon.polygon.float, '3.2M');
    assert.equal(withPolygon.polygon.avgVol, null);
    const [bare] = collectExportTrades(journal, { includePolygon: false, includeSheet: false });
    assert.equal(bare.polygon, undefined);
});

test('the model prompt forbids invented fields', () => {
    assert.match(analysisPrompt(), /не вигадуй/i);
    assert.match(analysisPrompt(), /1\.03 \+ 10/);
});
