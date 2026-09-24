import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    BASE_WEIGHTS,
    addCalendarDays,
    aggressivenessStatus,
    baseScore,
    broadMarketRegime,
    displaySessionDate,
    formatEtClock,
    finalAggressiveness,
    isTradingDay,
    piecewiseLinear,
    scoreConfidence,
    linearRelativeFallback,
    meltUpPenalty,
    microSmallBreadth,
    narrowLeadershipPenalty,
    nextLivePollDelay,
    rawLiveAdjustment,
    relativePercentile,
    recentAggressiveness,
    resolveWeights,
    scoreSessionFromBars,
    sessionPhase,
    smoothLiveAdjustment,
    speculativeAppetite,
    stressSafety,
    systemHealth,
    trailingPercentile,
} from '../lib/aggressiveness_core.js';
import { bucketStats, expandingWalkForward, featureStability, leaveOneMonthOut, tailComparison } from '../lib/aggressiveness_backtest.js';
import { applySeriesScale, normalizePolygonAggs, polygonBarDate, seriesScale } from '../lib/market_data_provider.js';
import { buildGauge, planGaugeWrite } from '../lib/aggressiveness_service.js';

test('component weights and status bands', () => {
    assert.equal(microSmallBreadth({ iwm5: 100, iwm10: 0, iwc5: 100, iwc10: 0 }), 55);
    assert.equal(speculativeAppetite({ xbi5: 0, xbi10: 100, arkk5: 0, arkk10: 100 }), 40);
    assert.equal(broadMarketRegime({ spy5d: 0.01, spy10d: 0.02, spy20d: 0.03, spyRv5: 0.008 }), 85);
    assert.equal(broadMarketRegime({ spy5d: -0.04, spy10d: -0.01, spy20d: -0.02, spyRv5: 0.004 }), 35);
    assert.ok(Math.abs(broadMarketRegime({ spy5d: 0.06, spy10d: 0.06, spy20d: 0.09, spyRv5: 0.02 }) - 23.75) < 1e-9);
    assert.ok(Math.abs(broadMarketRegime({ spy5d: 0.0049, spy10d: 0, spy20d: 0, spyRv5: 0.004 }) - broadMarketRegime({ spy5d: 0.005, spy10d: 0, spy20d: 0, spyRv5: 0.004 })) < 1);
    assert.equal(stressSafety({ vix: 36, vix1d: 0, vix5d: 0, us10y5dBp: 0, oil5d: 0, spy1d: 0, iwm1d: 0 }), 71);
    assert.equal(stressSafety({ vix: 16, vix1d: 0.05, vix5d: 0, us10y5dBp: 0, oil5d: 0, spy1d: 0, iwm1d: 0 }), 100);
    assert.equal(stressSafety({ vix: 16, vix1d: 0.08, vix5d: 0, us10y5dBp: 0, oil5d: 0, spy1d: 0, iwm1d: 0 }), 95);
    assert.equal(stressSafety({ vix: 16, vix1d: 0.12, vix5d: 0, us10y5dBp: 0, oil5d: 0, spy1d: 0, iwm1d: 0 }), 90);
    assert.ok(Math.abs(piecewiseLinear(0.079, [[0.05, 0], [0.08, -5], [0.12, -10]]) - piecewiseLinear(0.08, [[0.05, 0], [0.08, -5], [0.12, -10]])) < 1);
    assert.ok(Math.abs(stressSafety({ vix: 30, vix1d: 0.08, vix5d: 0.2, us10y5dBp: 30, oil5d: 0.12, spy1d: -0.02, iwm1d: -0.02 }) - 12.5) < 1e-9);
    assert.equal(narrowLeadershipPenalty({ qqq5: 0.03, iwm5: -0.02, smh5: 0.04, iwc5: -0.02, xbi5: -0.02 }), 18);
    assert.ok(Math.abs(meltUpPenalty({ spy20d: 0.09, vixPercentile: 10, iwmRs10: -0.01 }) - 7.5) < 1e-9);
    assert.equal(meltUpPenalty({ spy20d: 0.1, vixPercentile: 10, iwmRs10: -0.02 }), 10);
    assert.equal(meltUpPenalty({ spy20d: 0.09, vixPercentile: null, iwmRs10: -0.01 }), 0);
    const base = baseScore({ microSmall: 22, speculative: 48, broad: 62, stress: 74 });
    assert.ok(Math.abs(base - 47.5) < 1e-9);
    assert.ok(Math.abs(finalAggressiveness(base, 18, 0, 0) - 29.5) < 1e-9);
    assert.deepEqual(aggressivenessStatus(29.5).label, 'Обережно');
    assert.equal(aggressivenessStatus(0).label, 'Мінімальна');
    assert.equal(aggressivenessStatus(19).label, 'Мінімальна');
    assert.equal(aggressivenessStatus(40).label, 'Нейтральна');
    assert.equal(aggressivenessStatus(79).label, 'Агресивна');
    assert.equal(aggressivenessStatus(100).label, 'Максимальна');
    assert.equal(BASE_WEIGHTS.microSmall + BASE_WEIGHTS.speculative + BASE_WEIGHTS.broad + BASE_WEIGHTS.stress, 1);
});

test('percentile fallback and live adjustment clamps', () => {
    assert.equal(linearRelativeFallback(-0.03), 0);
    assert.equal(linearRelativeFallback(0), 50);
    assert.equal(linearRelativeFallback(0.03), 100);
    assert.equal(relativePercentile([0.01, 0.01]).method, 'linear-fallback');
    const sample = Array.from({ length: 60 }, (_, index) => index);
    assert.equal(trailingPercentile(sample), 100);
    assert.equal(rawLiveAdjustment({ SPY: 0.005, QQQ: 0.006, IWM: 0.005 }), 3.5);
    assert.equal(rawLiveAdjustment({ SPY: 0.004, QQQ: 0.004, IWM: -0.01 }), 2);
    assert.equal(rawLiveAdjustment({ SPY: -0.005, QQQ: -0.006, IWM: -0.005 }), -3.5);
    assert.equal(rawLiveAdjustment({ SPY: 0.005, QQQ: 0.006, IWM: 0.005, OIL: 0.02, US10Y_BP: 4 }), 2);
    assert.ok(Math.abs(rawLiveAdjustment({ VIX_FUTURES: -0.06 }, { priorShock: true }) - 1.5) < 1e-9);
    const premarketQuotes = {
        SPY: { fromPrevClose: 0.006, fromOpen: -0.01 },
        QQQ: { fromPrevClose: 0.007, fromOpen: -0.01 },
        IWM: { fromPrevClose: 0.006, fromOpen: -0.01 },
    };
    assert.equal(rawLiveAdjustment(premarketQuotes, { phase: 'premarket' }), 4);
    assert.equal(rawLiveAdjustment(premarketQuotes, { phase: 'open' }), -4);
    const fullHistory = Array.from({ length: 8 }, () => ({ method: 'percentile', sample: 126 }));
    assert.equal(scoreConfidence({ percentiles: fullHistory, microSmall: 50, speculative: 50, broad: 50, stress: 80 }), 100);
    const doubtful = scoreConfidence({
        soft: { IWC: 'stale', XBI: 'missing' },
        percentiles: fullHistory.map((item, index) => (index < 2 ? { method: 'linear-fallback', sample: 40 } : item)),
        microSmall: 10,
        speculative: 80,
        broad: 90,
        stress: 30,
        liveActive: true,
        liveFresh: false,
    });
    assert.ok(doubtful < 60);
    assert.equal(finalAggressiveness(55, 16, 0, 0), 39);
    assert.equal(smoothLiveAdjustment(null, 4), 1.4);
    assert.equal(smoothLiveAdjustment(0, -100), -8);
    assert.equal(systemHealth([{ entries: 2, totalR: 1 }, { entries: 2, totalR: -1 }]).usedInAggressiveness, false);
    assert.equal(resolveWeights().refit, false);
    assert.equal(resolveWeights().version, 1);
});

test('New York session clock, holidays and live poll window', () => {
    assert.equal(isTradingDay('2026-09-24'), true);
    assert.equal(isTradingDay('2026-09-26'), false);
    assert.equal(isTradingDay('2026-07-03'), false);
    assert.equal(displaySessionDate(new Date('2026-09-24T14:00:00Z')), '2026-09-24');
    assert.equal(displaySessionDate(new Date('2026-09-24T20:30:00Z')), '2026-09-24');
    assert.equal(displaySessionDate(new Date('2026-09-25T08:30:00Z')), '2026-09-25');
    assert.equal(displaySessionDate(new Date('2026-09-26T15:00:00Z')), '2026-09-25');
    assert.equal(sessionPhase(new Date('2026-09-24T14:00:00Z')), 'open');
    assert.equal(sessionPhase(new Date('2026-09-24T12:00:00Z')), 'premarket');
    assert.equal(sessionPhase(new Date('2026-09-24T16:00:00Z')), 'frozen');
    assert.equal(nextLivePollDelay(new Date('2026-09-24T16:00:00Z')), null);
    assert.ok(nextLivePollDelay(new Date('2026-09-24T12:00:00Z')) >= 5000);
    assert.ok(nextLivePollDelay(new Date('2026-09-24T14:00:00Z')) >= 5000);
    assert.equal(formatEtClock(null), '');
    assert.equal(formatEtClock(''), '');
});

function tradingDates(start, count) {
    const dates = [];
    let cursor = start;
    while (dates.length < count) {
        if (isTradingDay(cursor)) dates.push(cursor);
        cursor = addCalendarDays(cursor, 1);
    }
    return dates;
}

function walk(dates, daily, noise = 0, start = 100) {
    let price = start;
    const bars = dates.map((date, index) => {
        price *= 1 + daily + Math.sin(index * 1.3) * noise;
        return { date, close: price };
    });
    return { bars, end: price };
}

function regimeBars(lastDrift) {
    const dates = tradingDates('2025-06-02', 160);
    const calmDates = dates.slice(0, 140);
    const hotDates = dates.slice(140);
    const series = (lateDaily) => {
        const calm = walk(calmDates, 0.0002, 0.00005, 100);
        return [...calm.bars, ...walk(hotDates, lateDaily, 0, calm.end).bars];
    };
    return {
        dates,
        bars: {
            SPY: series(lastDrift.spy),
            QQQ: series(lastDrift.qqq),
            IWM: series(lastDrift.iwm),
            IWC: series(lastDrift.iwc),
            XBI: series(lastDrift.xbi),
            ARKK: series(lastDrift.arkk),
            SMH: series(lastDrift.smh),
            VIX: dates.map((date) => ({ date, close: 16 })),
            US10Y: dates.map((date, index) => ({ date, close: index < 155 ? 4 : 4 + (index - 154) * lastDrift.yieldStep })),
            OIL: [...walk(calmDates, 0, 0, 80).bars, ...walk(hotDates, lastDrift.oil, 0, 80).bars],
        },
    };
}

test('leadership divergence scores low and confirmed breadth scores higher', () => {
    const weak = regimeBars({ spy: 0.0035, qqq: 0.0085, iwm: 0.0005, iwc: 0, xbi: -0.0015, arkk: 0.009, smh: 0.0115, oil: 0.013, yieldStep: 0.04 });
    let next = addCalendarDays(weak.dates.at(-1), 1);
    while (!isTradingDay(next)) next = addCalendarDays(next, 1);
    const weakScore = scoreSessionFromBars(weak.bars, next, { liveAdjustment: 0, mechanicalExpectancy: 9 });
    assert.equal(weakScore.complete, true, weakScore.missing?.join(','));
    assert.ok(weakScore.displayScore >= 15 && weakScore.displayScore <= 40, JSON.stringify({
        display: weakScore.displayScore,
        base: weakScore.baseScore,
        components: weakScore.components,
        features: weakScore.features,
    }));
    const strong = regimeBars({ spy: 0.003, qqq: 0.0032, iwm: 0.008, iwc: 0.009, xbi: 0.008, arkk: 0.004, smh: 0.003, oil: 0, yieldStep: 0 });
    let strongSession = addCalendarDays(strong.dates.at(-1), 1);
    while (!isTradingDay(strongSession)) strongSession = addCalendarDays(strongSession, 1);
    const strongScore = scoreSessionFromBars(strong.bars, strongSession);
    assert.ok(strongScore.displayScore > weakScore.displayScore);
});

test('historical reconstruction ignores same-day and future bars', () => {
    const { dates, bars } = regimeBars({ spy: 0.001, qqq: 0.001, iwm: 0.001, iwc: 0.001, xbi: 0.001, arkk: 0.001, smh: 0.001, oil: 0, yieldStep: 0 });
    let session = addCalendarDays(dates.at(-1), 1);
    while (!isTradingDay(session)) session = addCalendarDays(session, 1);
    const original = scoreSessionFromBars(bars, session);
    const leaked = structuredClone(bars);
    for (const key of Object.keys(leaked)) {
        leaked[key].push({ date: session, close: leaked[key].at(-1).close * 0.4 });
        leaked[key].push({ date: addCalendarDays(session, 1), close: leaked[key].at(-1).close * 3 });
    }
    const reconstructed = scoreSessionFromBars(leaked, session);
    assert.equal(reconstructed.baseScore, original.baseScore);
    assert.equal(reconstructed.components.microSmall, original.components.microSmall);
    assert.equal(reconstructed.vixPercentile, original.vixPercentile);
    assert.equal(reconstructed.liveScore, finalAggressiveness(
        reconstructed.baseScore,
        reconstructed.components.narrowPenalty,
        reconstructed.components.meltUpPenalty,
        0,
    ));
    assert.equal(reconstructed.infoThrough, dates.at(-1));
    const withoutIwc = structuredClone(bars);
    withoutIwc.IWC = withoutIwc.IWC.filter((bar) => bar.date < dates.at(-8));
    const softScore = scoreSessionFromBars(withoutIwc, session);
    assert.equal(softScore.complete, true);
    assert.equal(softScore.soft.IWC, 'stale');
    assert.ok(softScore.confidence < original.confidence);
    assert.equal(softScore.liveScore, finalAggressiveness(
        softScore.baseScore,
        softScore.components.narrowPenalty,
        softScore.components.meltUpPenalty,
        0,
    ));
    const stale = structuredClone(bars);
    stale.OIL = stale.OIL.filter((bar) => bar.date < dates.at(-1));
    const incomplete = scoreSessionFromBars(stale, session);
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.message, 'Data incomplete');
    assert.ok(incomplete.missing.includes('OIL'));
    const zeroed = structuredClone(bars);
    const prior = zeroed.VIX.at(-2);
    zeroed.VIX.splice(-2, 1, { date: prior.date, close: 0 });
    const skipped = scoreSessionFromBars(zeroed, session);
    assert.equal(skipped.complete, true);
    assert.ok(!skipped.missing.includes('vix1d'));
});

test('recent aggressiveness is the trailing session series', () => {
    const { dates, bars } = regimeBars({ spy: 0.001, qqq: 0.001, iwm: 0.001, iwc: 0.001, xbi: 0.001, arkk: 0.001, smh: 0.001, oil: 0, yieldStep: 0 });
    let session = addCalendarDays(dates.at(-1), 1);
    while (!isTradingDay(session)) session = addCalendarDays(session, 1);
    const series = recentAggressiveness(bars, session, 14);
    assert.equal(series.length, 14);
    assert.equal(series.at(-1).date, session);
    assert.ok(series[0].date < series.at(-1).date);
    assert.ok(series.every((point) => point.score >= 0 && point.score <= 100));
    assert.equal(series.at(-1).score, scoreSessionFromBars(bars, session).displayScore);
    const leaked = structuredClone(bars);
    leaked.SPY.push({ date: session, close: leaked.SPY.at(-1).close * 1.2 });
    const again = recentAggressiveness(leaked, session, 14);
    assert.equal(again.at(-2).score, series.at(-2).score);
});

test('backtest buckets use R per trade and do not refit weights', () => {
    const days = [0, 10, 30, 55, 70, 95].map((score, index) => ({
        sessionDate: `2026-0${index + 1}-15`,
        displayScore: score,
        complete: true,
        components: { microSmall: score, speculative: score, broad: score, stress: score },
        mechanical: { entries: 4, totalR: score / 10, wins: 2, avgWinner: 1, avgLoser: -0.5 },
    }));
    const buckets = bucketStats(days);
    assert.deepEqual(buckets.map((bucket) => bucket.id), ['0-20', '20-40', '40-60', '60-80', '80-100']);
    assert.equal(buckets[0].trades, 8);
    assert.equal(buckets[4].trades, 4);
    const tails = tailComparison(days);
    assert.ok(tails.top.rPerTrade > tails.bottom.rPerTrade);
    const walk = expandingWalkForward(days, { minTrainMonths: 2 });
    assert.equal(walk.weightsChanged, false);
    assert.ok(walk.folds.every((fold) => fold.scoreVersion === 1 && fold.weightsChanged === false));
    assert.equal(leaveOneMonthOut(days).weightsChanged, false);
    assert.ok(featureStability(days).every((item) => item.weightUpdate == null));
});

test('stored base score is not rewritten and missing provider stays incomplete', async () => {
    const existing = {
        date: '2026-09-24',
        score_version: 1,
        base_score: 22,
        live_score: 22,
        live_adjustment: 0,
        micro_small_score: 10,
        speculative_score: 20,
        broad_score: 30,
        stress_score: 40,
        narrow_penalty: 8,
        meltup_penalty: 0,
        info_through: '2026-09-23',
        live_frozen: false,
        live_updated_at: '2026-09-24T13:00:00.000Z',
    };
    const computed = {
        complete: true,
        sessionDate: '2026-09-24',
        infoThrough: '2026-09-23',
        baseScore: 80,
        components: { narrowPenalty: 0, meltUpPenalty: 0, microSmall: 1, speculative: 1, broad: 1, stress: 1 },
        features: {},
    };
    const plan = planGaugeWrite({
        existing,
        computed,
        now: new Date('2026-09-24T14:00:00Z'),
        nextLive: 2,
    });
    assert.equal(plan.action, 'patch');
    assert.equal(plan.patch.base_score, undefined);
    assert.equal(planGaugeWrite({
        existing: { ...existing, live_frozen: true },
        computed,
        now: new Date('2026-09-24T18:00:00Z'),
        nextLive: 4,
    }).action, 'keep');
    const missing = await buildGauge({ env: {}, now: new Date('2026-09-24T14:00:00Z') });
    assert.equal(missing.message, 'Data incomplete');
    assert.equal(missing.incomplete, true);
});

test('polygon daily bars are cached and yield scale is applied once', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return new Response(JSON.stringify({
            results: [{ t: Date.parse('2026-09-23T20:00:00Z'), o: 42, h: 42, l: 42, c: 42 }],
        }), { status: 200 });
    };
    const { PolygonMarketDataProvider } = await import('../lib/market_data_provider.js');
    const provider = new PolygonMarketDataProvider({ env: { POLYGON_API_KEY: 'test' }, fetchImpl });
    const first = await provider.getDailyBars('I:TNX', '2026-01-01', '2026-09-23');
    const second = await provider.getDailyBars('I:TNX', '2026-01-01', '2026-09-23');
    assert.equal(calls, 1);
    assert.equal(first[0].close, 42);
    assert.equal(second[0].close, 42);
    const scaled = applySeriesScale({ key: 'US10Y', scale: 0.1 }, first);
    assert.equal(scaled[0].close, 4.2);
    assert.equal(seriesScale({ scaleEnv: 'MARKET_US10Y_SCALE', scale: 0.1 }, { MARKET_US10Y_SCALE: '0.1' }), 0.1);
    assert.equal(polygonBarDate(Date.parse('2026-09-23T00:00:00Z')), '2026-09-23');
    assert.equal(normalizePolygonAggs({ results: [] }).length, 0);
});

test('daily bars use the polygon edge function when Vercel has no polygon key', async () => {
    let requestUrl = '';
    let requestBody = '';
    const fetchImpl = async (input, init) => {
        requestUrl = String(input);
        requestBody = init?.body || '';
        return new Response(JSON.stringify({
            results: [{ t: Date.parse('2026-09-23T00:00:00Z'), o: 1, h: 1, l: 1, c: 10 }],
        }), { status: 200 });
    };
    const { PolygonMarketDataProvider } = await import('../lib/market_data_provider.js');
    const provider = new PolygonMarketDataProvider({
        env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' },
        authToken: 'user-jwt',
        fetchImpl,
    });
    const bars = await provider.getDailyBars('SPY', '2026-01-01', '2026-09-23');
    assert.match(requestUrl, /\/functions\/v1\/polygon-aggs$/);
    assert.match(requestBody, /"mode":"daily"/);
    assert.match(requestBody, /"symbol":"SPY"/);
    assert.equal(bars[0].close, 10);
    const quotes = await provider.getLiveQuotes(['SPY']);
    assert.equal(quotes.incomplete, true);
    assert.deepEqual(quotes.quotes, {});
});

test('public quotes use Yahoo and keep the 10-year yield in Polygon raw units', async () => {
    const seen = [];
    const fetchImpl = async (input) => {
        const url = String(input);
        seen.push(url);
        const symbol = decodeURIComponent(url.split('/chart/')[1]?.split('?')[0] || '');
        const close = symbol === '^TNX' ? 5.1 : symbol === '^VIX' ? 16 : 100;
        return new Response(JSON.stringify({
            chart: {
                result: [{
                    timestamp: [Date.parse('2026-09-23T13:30:00Z') / 1000],
                    indicators: { quote: [{ open: [close], high: [close], low: [close], close: [close] }] },
                }],
            },
        }), { status: 200 });
    };
    const { YahooMarketDataProvider, createMarketDataProvider } = await import('../lib/market_data_provider.js');
    const provider = createMarketDataProvider({}, fetchImpl, { allowPublic: true });
    assert.ok(provider instanceof YahooMarketDataProvider);
    const yieldBars = await provider.getDailyBars('I:TNX', '2026-09-01', '2026-09-23');
    const vixBars = await provider.getDailyBars('I:VIX', '2026-09-01', '2026-09-23');
    const oilBars = await provider.getDailyBars('I:CL', '2026-09-01', '2026-09-23');
    assert.equal(yieldBars[0].close, 51);
    assert.equal(vixBars[0].close, 16);
    assert.equal(oilBars[0].date, '2026-09-23');
    assert.ok(seen.some((url) => url.includes('%5EVIX') || url.includes('^VIX')));
    assert.ok(seen.some((url) => url.includes('CL%3DF') || url.includes('CL=F')));
});

test('dashboard flip markup and mobile rule exist', async () => {
    const html = await readFile(new URL('../partials/views/dashboard-view.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../css/16_polish.css', import.meta.url), 'utf8');
    const migration = await readFile(new URL('../supabase/migrations/20260924190000_daily_market_regime.sql', import.meta.url), 'utf8');
    const gauge = await readFile(new URL('../js/market_aggressiveness.js', import.meta.url), 'utf8');
    assert.match(gauge, /pj:market-gauge-face:v1/);
    assert.match(gauge, /localStorage\.setItem\(FACE_KEY/);
    assert.match(gauge, /Оцінка на сьогодні: наскільки ринок зручний для механічних шортів/);
    assert.match(gauge, /Дрібні акції/);
    assert.match(gauge, /Разом/);
    assert.match(gauge, /aggressiveness-row/);
    assert.match(html, /data-action="market-gauge-flip"/);
    assert.match(html, /Агресивність/);
    assert.match(html, /market-aggressiveness-score/);
    assert.match(css, /max-width: 760px/);
    assert.match(css, /market-gauge-shell.is-flipped/);
    assert.match(migration, /score_version/);
    assert.match(migration, /protect_daily_market_regime/);
    assert.match(migration, /daily_market_regime_date_idx/);
});
