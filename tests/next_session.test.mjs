import assert from 'node:assert/strict';
import test from 'node:test';
import { addCalendarDays, isTradingDay, nextTradingDay } from '../lib/aggressiveness_core.js';
import { nextSessionClock } from '../lib/next_session_service.js';
import {
    NEXT_WEIGHTS,
    buildEdgeSeries,
    combineNextSession,
    entryLevelMetrics,
    normalizeJournalRows,
    normalizeMechanicalSignal,
    predictNextSession,
    premarketAdjustment,
    regimeState,
    tickerDayOutcomes,
} from '../lib/next_session_core.js';

function tradingDates(start, count) {
    const dates = [];
    let cursor = start;
    while (dates.length < count) {
        if (isTradingDay(cursor)) dates.push(cursor);
        cursor = addCalendarDays(cursor, 1);
    }
    return dates;
}

function barsFor(dates) {
    const series = (start) => dates.map((date, index) => ({ date, close: start * (1 + index * 0.0004) }));
    return {
        SPY: series(100), QQQ: series(100), IWM: series(90), IWC: series(80),
        XBI: series(70), ARKK: series(60), SMH: series(110),
        VIX: dates.map((date) => ({ date, close: 16 })),
        US10Y: dates.map((date) => ({ date, close: 4.2 })),
        OIL: dates.map((date) => ({ date, close: 80 })),
    };
}

test('a skipped trade keeps its mechanical R and is not counted as zero', () => {
    const signal = normalizeMechanicalSignal({
        symbol: 'ABCD',
        type: 'не брав',
        net: 0,
        sheet: { profitRisk: '-1.4', spreadsheetId: 'book', sheetRow: 12 },
    }, { traderId: 'trader-1', tradingDate: '2026-09-23' });
    assert.equal(signal.mechanicalResultR, -1.4);
    assert.equal(signal.traderResultR, 0);
    assert.equal(signal.isNotTaken, true);
    assert.equal(signal.isWin, false);
    const again = normalizeJournalRows([
        { user_id: 'trader-1', trade_date: '2026-09-23', daily_metrics: { trades: [{ symbol: 'ABCD', type: 'не брав', net: 0, sheet: { profitRisk: '-1.4', spreadsheetId: 'book', sheetRow: 12 } }] } },
        { user_id: 'trader-1', trade_date: '2026-09-23', daily_metrics: { trades: [{ symbol: 'ABCD', type: 'не брав', net: 0, sheet: { profitRisk: '-1.4', spreadsheetId: 'book', sheetRow: 12 } }] } },
    ]);
    assert.equal(again.length, 1);
    assert.equal(entryLevelMetrics(again).entryMeanR, -1.4);
});

test('one ticker with several traders is one observation', () => {
    const outcomes = tickerDayOutcomes([
        { tradingDate: '2026-09-23', ticker: 'ABCD', traderId: 'a', mechanicalResultR: 2, sourceImportId: 'a' },
        { tradingDate: '2026-09-23', ticker: 'ABCD', traderId: 'a', mechanicalResultR: 3, sourceImportId: 'b' },
        { tradingDate: '2026-09-23', ticker: 'ABCD', traderId: 'c', mechanicalResultR: -1, sourceImportId: 'c' },
        { tradingDate: '2026-09-23', ticker: 'WXYZ', traderId: 'a', mechanicalResultR: -0.5, sourceImportId: 'd' },
    ]);
    assert.equal(outcomes.length, 2);
    const abcd = outcomes.find((row) => row.ticker === 'ABCD');
    assert.equal(abcd.signalCount, 3);
    assert.equal(abcd.uniqueTraders, 2);
    assert.equal(abcd.medianR, 2);
    assert.equal(abcd.worked, true);
    const edge = buildEdgeSeries(outcomes)[0];
    assert.equal(edge.uniqueTickers, 2);
    assert.equal(edge.dumpBreadth, 0.5);
    assert.equal(edge.signalCount, 4);
    assert.equal(edge.repeatPressure, 0.5);
});

test('edge history does not use a future day when scoring an earlier day', () => {
    const dates = tradingDates('2026-06-01', 8);
    const outcomes = dates.slice(0, 7).map((date, index) => ({
        tradingDate: date, ticker: 'AAA', signalCount: 1, uniqueTraders: 1,
        medianR: index < 6 ? 0.2 : 4, meanR: 0.2, bestR: 0.2, worstR: 0.2,
        worked: true, hit1r: false, hit2r: false, hit3r: false,
    }));
    const before = buildEdgeSeries(outcomes);
    const leaked = buildEdgeSeries([...outcomes, {
        tradingDate: dates[7], ticker: 'ZZZ', signalCount: 1, uniqueTraders: 1,
        medianR: -5, meanR: -5, bestR: -5, worstR: -5,
        worked: false, hit1r: false, hit2r: false, hit3r: false,
    }]);
    assert.equal(leaked[5].actualEdgeScore, before[5].actualEdgeScore);
    assert.notEqual(leaked.at(-1).date, before.at(-1).date);
});

test('next-session prediction ignores the target day market and mechanical results', () => {
    const dates = tradingDates('2026-04-01', 90);
    const featureDate = dates.at(-2);
    const targetDate = nextTradingDay(featureDate);
    const bars = barsFor(dates.slice(0, -1));
    const pastSignals = dates.slice(0, -2).map((date) => ({
        tradingDate: date, ticker: 'MECH', traderId: 'office', mechanicalResultR: 0.4, sourceImportId: date,
    }));
    const original = predictNextSession({ barsByKey: bars, signals: pastSignals, featureDate, premarket: 0 });
    assert.equal(original.complete, true, original.missing?.join(','));
    assert.equal(original.targetDate, targetDate);
    assert.equal(original.featureDate, featureDate);
    const leakedBars = structuredClone(bars);
    for (const key of Object.keys(leakedBars)) {
        leakedBars[key].push({ date: targetDate, close: leakedBars[key].at(-1).close * 0.5 });
    }
    const leakedSignals = [...pastSignals, {
        tradingDate: targetDate, ticker: 'MECH', traderId: 'office', mechanicalResultR: 12, sourceImportId: 'future',
    }];
    const leaked = predictNextSession({ barsByKey: leakedBars, signals: leakedSignals, featureDate, premarket: 0 });
    assert.equal(leaked.basePrediction, original.basePrediction);
    assert.equal(leaked.marketLeading, original.marketLeading);
    assert.equal(leaked.laggedMechanical, original.laggedMechanical);
});

test('fixed weights, premarket cap and recovery state', () => {
    assert.equal(NEXT_WEIGHTS.market + NEXT_WEIGHTS.lagged + NEXT_WEIGHTS.transition, 1);
    assert.ok(Math.abs(combineNextSession(72, 38, 84).score - 66.5) < 1e-9);
    assert.equal(combineNextSession(72, null, null).mode, 'market-only');
    assert.equal(regimeState({ market: 72, lagged: 38, transition: 84, acceleration: 42 }), 'RECOVERY');
    assert.equal(regimeState({ market: 30, lagged: 20, transition: 30, acceleration: -5 }), 'OFF');
    assert.equal(premarketAdjustment({ SPY: 0.05, QQQ: 0.05, IWM: 0.05 }), 10);
    assert.equal(premarketAdjustment({ SPY: -0.05, QQQ: -0.05, IWM: -0.05 }), -10);
    assert.equal(nextTradingDay('2026-07-02'), '2026-07-06');
    const afterClose = nextSessionClock(new Date('2026-09-24T21:00:00Z'));
    assert.equal(afterClose.featureDate, '2026-09-24');
    assert.equal(afterClose.targetDate, '2026-09-25');
    assert.equal(afterClose.phase, 'closed');
    const saturday = nextSessionClock(new Date('2026-09-26T15:00:00Z'));
    assert.equal(saturday.featureDate, '2026-09-25');
    assert.equal(saturday.targetDate, '2026-09-28');
    const morning = nextSessionClock(new Date('2026-09-24T14:00:00Z'));
    assert.equal(morning.targetDate, '2026-09-24');
    assert.equal(morning.featureDate, '2026-09-23');
});
