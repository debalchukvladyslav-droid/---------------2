import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    BREADTH_FIELDS,
    SCORE_VERSION,
    addCalendarDays,
    aggressivenessStatus,
    displaySessionDate,
    isTradingDay,
    previousTradingDay,
    scoreByQuintileExpectancy,
    scoreSessionFromBars,
} from '../lib/aggressiveness_core.js';
import { buildHistoricalBacktest, planGaugeWrite, regimeRow } from '../lib/aggressiveness_service.js';

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
    const series = (start, drift = 0.0002) => {
        let price = start;
        return dates.map((date, index) => {
            price *= 1 + drift + (index % 9) * 0.00005;
            return { date, close: price, high: price * 1.01, low: price * 0.99, open: price };
        });
    };
    return {
        SPY: series(100, 0.0002),
        QQQ: series(100, 0.00035),
        IWM: series(90, 0.0001),
        IWC: series(80, -0.0001),
        XBI: series(70, 0.0004),
        ARKK: series(60, 0.00015),
        SMH: series(110, 0.00045),
        VIX: dates.map((date, index) => ({ date, close: 16 + (index % 11) * 0.15 })),
        US10Y: dates.map((date, index) => ({ date, close: 4.1 + index * 0.002 })),
        OIL: dates.map((date, index) => ({ date, close: 78 + Math.sin(index / 4) * 2 })),
    };
}

function mechanicalFor(dates, result = 0.25) {
    const byDate = {};
    for (const date of dates) {
        byDate[date] = {
            entries: 4,
            totalR: result * 4,
            rPerTrade: result,
            wins: 2,
            winRate: 0.5,
            avgWinner: 1.1,
            avgLoser: -0.6,
        };
    }
    return byDate;
}

function quintileSamples(results) {
    const samples = [];
    results.forEach((result, quintile) => {
        for (let index = 0; index < 16; index += 1) {
            samples.push({ value: quintile * 10 + index * 0.01, entries: 1, totalR: result });
        }
    });
    return samples;
}

test('quintile expectancy follows history and is not a fixed direction', () => {
    const lowIsGood = quintileSamples([1, 0.2, 0, -0.2, -1]);
    const low = scoreByQuintileExpectancy(lowIsGood, 0.05);
    const high = scoreByQuintileExpectancy(lowIsGood, 40.1);
    assert.equal(low.quintile, 1);
    assert.equal(high.quintile, 5);
    assert.ok(low.score > high.score + 15, `${low.score} vs ${high.score}`);
    const flipped = scoreByQuintileExpectancy(quintileSamples([-1, -0.2, 0, 0.2, 1]), 0.05);
    assert.ok(flipped.score < low.score - 15);
    const hump = quintileSamples([-0.4, 1.2, 0.1, 0, -0.8]);
    const middle = scoreByQuintileExpectancy(hump, 10.05);
    const tail = scoreByQuintileExpectancy(hump, 40.1);
    assert.equal(middle.quintile, 2);
    assert.ok(middle.score > tail.score);
});

test('a three-day bucket cannot become a 100 score', () => {
    const samples = [];
    for (let index = 0; index < 37; index += 1) samples.push({ value: 0, entries: 1, totalR: 0 });
    for (let index = 0; index < 3; index += 1) samples.push({ value: 1000 + index, entries: 1, totalR: 5 });
    const mapped = scoreByQuintileExpectancy(samples, 1001);
    assert.equal(mapped.sample, 3);
    assert.ok(mapped.score < 70, `shrunk score ${mapped.score}`);
    assert.ok(mapped.shrunk);
});

test('session score ignores same-day prices and same-day mechanical results', () => {
    const dates = tradingDates('2026-01-05', 70);
    const session = dates.at(-1);
    const bars = barsFor(dates);
    const mechanical = mechanicalFor(dates.slice(0, -1));
    const original = scoreSessionFromBars(bars, session, { mechanicalByDate: mechanical });
    assert.equal(original.complete, true, (original.missing || []).join(','));
    assert.equal(original.infoThrough, previousTradingDay(session));
    assert.ok(original.infoThrough < session);

    const leakedBars = structuredClone(bars);
    for (const key of Object.keys(leakedBars)) {
        const last = leakedBars[key].at(-1);
        leakedBars[key].push({ date: session, close: last.close * 0.4, high: last.close, low: last.close * 0.3 });
    }
    const leakedMechanical = {
        ...mechanical,
        [session]: { entries: 8, totalR: 40, rPerTrade: 5, wins: 8, winRate: 1, avgWinner: 5, avgLoser: null },
    };
    const leaked = scoreSessionFromBars(leakedBars, session, { mechanicalByDate: leakedMechanical });
    assert.equal(leaked.displayScore, original.displayScore);
    assert.equal(leaked.ruleScore, original.ruleScore);
    assert.equal(leaked.analogScore, original.analogScore);
    assert.ok(leaked.analogs.every((analog) => analog.date < session));
    assert.equal(leaked.liveAdjustment, 0);
});

test('historical analogs are strictly earlier than the session', () => {
    const dates = tradingDates('2026-03-02', 60);
    const session = dates.at(-1);
    const scored = scoreSessionFromBars(barsFor(dates), session, { mechanicalByDate: mechanicalFor(dates.slice(0, -1)) });
    assert.equal(scored.complete, true);
    assert.ok(scored.analogs.length >= 8);
    assert.ok(scored.analogs.every((analog) => analog.date < session));
});

test('Friday close becomes Monday score, including after the finalize window', () => {
    assert.equal(displaySessionDate(new Date('2026-09-26T15:00:00Z')), '2026-09-28');
    assert.equal(displaySessionDate(new Date('2026-09-25T21:00:00Z')), '2026-09-28');
    assert.equal(displaySessionDate(new Date('2026-09-28T14:00:00Z')), '2026-09-28');
    const dates = tradingDates('2026-06-01', 90);
    const monday = '2026-09-28';
    const friday = '2026-09-25';
    assert.equal(previousTradingDay(monday), friday);
    const scored = scoreSessionFromBars(barsFor(dates), monday, { mechanicalByDate: mechanicalFor(dates.filter((date) => date < monday)) });
    assert.equal(scored.complete, true, (scored.missing || []).join(','));
    assert.equal(scored.infoThrough, friday);
    assert.equal(scored.sessionDate, monday);
});

test('a full market holiday rolls the score to the next trading session', () => {
    assert.equal(isTradingDay('2026-07-03'), false);
    assert.equal(displaySessionDate(new Date('2026-07-03T15:00:00Z')), '2026-07-06');
    assert.equal(previousTradingDay('2026-07-06'), '2026-07-02');
    assert.equal(displaySessionDate(new Date('2026-11-27T17:30:00Z')), '2026-11-27');
    assert.equal(displaySessionDate(new Date('2026-11-27T18:20:00Z')), '2026-11-30');
});

test('missing breadth is reported and is not invented', () => {
    const dates = tradingDates('2026-02-02', 60);
    const session = dates.at(-1);
    const bars = barsFor(dates);
    const mechanical = mechanicalFor(dates.slice(0, -1));
    const bare = scoreSessionFromBars(bars, session, { mechanicalByDate: mechanical });
    assert.equal(bare.complete, true);
    assert.equal(bare.components.breadth, null);
    assert.equal(bare.features.nyseDeclinerRatio, null);
    assert.equal(bare.breadthUnavailable, true);
    for (const field of ['nyseAdvancers', 'nyseDecliners', 'nasdaqUpVolume', 'nyseNewLows']) {
        assert.ok(bare.coverageGaps.includes(field));
    }
    assert.deepEqual([...bare.coverageGaps], [...BREADTH_FIELDS]);
    const breadthByDate = {};
    for (const date of dates) {
        breadthByDate[date] = {
            nyseAdvancers: 1900,
            nyseDecliners: 1100,
            nasdaqAdvancers: 2100,
            nasdaqDecliners: 1400,
            nyseUpVolume: 2.2e9,
            nyseDownVolume: 1.4e9,
            nasdaqUpVolume: 3.1e9,
            nasdaqDownVolume: 1.8e9,
            nyseNewHighs: 70,
            nyseNewLows: 30,
            nasdaqNewHighs: 95,
            nasdaqNewLows: 40,
        };
    }
    const withBreadth = scoreSessionFromBars(bars, session, { mechanicalByDate: mechanical, breadthByDate });
    assert.equal(withBreadth.features.nyseDeclinerRatio, 1100 / 1900);
    assert.equal(withBreadth.breadthUnavailable, false);
    assert.ok(withBreadth.confidence > bare.confidence);
});

test('stored score is immutable and a new score_version does not replace the old row', async () => {
    assert.equal(SCORE_VERSION, 2);
    const computed = {
        complete: true,
        sessionDate: '2026-09-28',
        infoThrough: '2026-09-25',
        displayScore: 64,
        ruleScore: 62.4,
        analogScore: 67,
        confidence: 81,
        components: { smallMicro: 74, breadth: null, speculative: 56, broadMarket: 63, macro: 48 },
        features: { spy1d: 0.01, vix: 18 },
        analogExpectedR: 0.22,
        analogPositiveRate: 0.61,
        analogSampleSize: 18,
    };
    assert.equal(planGaugeWrite({ existing: { live_score: 41, score_version: 2 }, computed }).action, 'keep');
    assert.equal(planGaugeWrite({ existing: { live_score: 41, score_version: 1 }, computed }).action, 'keep');
    const inserted = planGaugeWrite({ existing: null, computed });
    assert.equal(inserted.action, 'insert');
    assert.equal(inserted.row.score_version, 2);
    assert.equal(inserted.row.live_adjustment, 0);
    assert.equal(inserted.row.live_frozen, true);
    assert.notEqual(regimeRow(computed).score_version, 1);
    const source = await readFile(new URL('../lib/aggressiveness_http.js', import.meta.url), 'utf8');
    assert.match(source, /on_conflict=date,score_version/);
    assert.match(source, /resolution=ignore-duplicates/);
    const migration = await readFile(new URL('../supabase/migrations/20260928183000_aggressiveness_v2.sql', import.meta.url), 'utf8');
    assert.match(migration, /score_version >= 2/);
    assert.match(migration, /daily_market_breadth/);
});

test('backtest sessions use the production scoring engine', async () => {
    const dates = tradingDates('2026-01-02', 140);
    const session = dates[45];
    const bars = barsFor(dates);
    const mechanical = mechanicalFor(dates);
    const report = await buildHistoricalBacktest(bars, mechanical, dates);
    const direct = scoreSessionFromBars(bars, session, { mechanicalByDate: mechanical });
    const row = report.sessions.find((item) => item.date === session);
    assert.equal(direct.complete, true);
    assert.equal(row.aggressivenessScore, direct.displayScore);
    assert.equal(row.previousMarketDate, direct.infoThrough);
    assert.ok(report.walkForward.folds.length >= 1);
    assert.equal(report.scoreVersion, SCORE_VERSION);
    assert.equal(aggressivenessStatus(64).label, 'Можна агресивніше');
    assert.equal(aggressivenessStatus(10).label, 'Майже не чіпати');
    assert.equal(aggressivenessStatus(90).label, 'Найзручніший режим');
});
