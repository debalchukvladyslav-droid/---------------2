/**
 * Next-session aggressiveness for mechanical pump-and-dump shorts.
 * A prediction for target date T uses only market closes and mechanical
 * results through the previous trading day. Weights are fixed in v1.
 */

import {
    aggressivenessStatus,
    clamp,
    nextTradingDay,
    scoreSessionFromBars,
} from './aggressiveness_core.js';

export const NEXT_SCORE_VERSION = 'aggressiveness_v1';
export const NEXT_WEIGHTS = Object.freeze({ market: 0.5, lagged: 0.25, transition: 0.25 });
export const PREMARKET_LIMIT = 10;
const FAST_WINDOW = 12;
const MID_WINDOW = 35;
const SLOW_WINDOW = 90;
const MIN_EDGE_DAYS = 10;
const PERCENTILE_MIN = 60;

const finite = (value) => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

export function parseMechanicalR(value) {
    if (value == null || value === '') return null;
    const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

export function isNotTakenSignal(trade) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const text = [
        trade?.type, trade?.tradeType, trade?.setupType, trade?.note, trade?.notes,
        sheet.tradeType, sheet.exception, sheet.exceptions, sheet.pv,
    ].flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
    if (!text.trim()) return false;
    return /\bdo\s*not\s*take\b|\bnot\s*taken\b|\bno\s*trade\b|\bskip(?:ped)?\b/i.test(text)
        || /не\s*брав|не\s*взяв|пропустив|пропущен|без\s*входу/i.test(text);
}

export function mechanicalSourceId(trade, traderId, tradingDate) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const row = sheet.sheetRow ?? sheet.rowNumber ?? sheet.row ?? '';
    const book = sheet.spreadsheetId || sheet.sourceFileId || sheet.source || '';
    const ticker = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
    if (book && row !== '') return `${traderId || 'office'}|${book}|${row}`;
    return `${traderId || 'office'}|${tradingDate}|${ticker}|${trade?.opened || ''}|${parseMechanicalR(sheet.profitRisk ?? trade?.profitRisk ?? trade?.kf)}`;
}

/**
 * Sheet "профіт в ризиках" is the mechanical result.
 * A skipped trade keeps that R. Personal dollar PnL is never the model input.
 */
export function normalizeMechanicalSignal(trade, context = {}) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const mechanical = parseMechanicalR(sheet.profitRisk ?? trade?.profitRisk ?? trade?.kf);
    const ticker = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
    const tradingDate = context.tradingDate || trade?.tradingDate || '';
    if (mechanical == null || !ticker || !tradingDate) return null;
    const notTaken = isNotTakenSignal(trade);
    return {
        traderId: context.traderId || trade?.traderId || null,
        ticker,
        tradingDate,
        signalTimeEt: trade?.opened || null,
        resolvedTimeEt: trade?.closed || null,
        setupType: String(sheet.tradeType || trade?.type || ''),
        mechanicalResultR: mechanical,
        traderResultR: notTaken ? 0 : finite(trade?.traderResultR),
        isMechanical: true,
        isNotTaken: notTaken,
        isWin: mechanical > 0,
        sourceImportId: mechanicalSourceId(trade, context.traderId, tradingDate),
        metadata: {
            net: finite(trade?.net),
            notTaken,
        },
    };
}

export function normalizeJournalRows(rows = []) {
    const bySource = new Map();
    for (const row of rows) {
        const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : row;
        const trades = Array.isArray(metrics?.trades) ? metrics.trades : (Array.isArray(row?.trades) ? row.trades : []);
        const tradingDate = row?.trade_date || row?.tradingDate || metrics?.trade_date;
        trades.forEach((trade) => {
            const signal = normalizeMechanicalSignal(trade, { traderId: row?.user_id || row?.traderId, tradingDate });
            if (!signal) return;
            bySource.set(signal.sourceImportId, signal);
        });
    }
    return [...bySource.values()];
}

export function median(values) {
    const sorted = (values || []).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
    const sample = (values || []).filter((value) => Number.isFinite(value));
    if (!sample.length) return null;
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
}

export function tickerDayOutcomes(signals = []) {
    const groups = new Map();
    for (const signal of signals) {
        if (!signal?.tradingDate || !signal?.ticker || !Number.isFinite(signal.mechanicalResultR)) continue;
        const key = `${signal.tradingDate}|${signal.ticker}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(signal);
    }
    return [...groups.entries()].map(([key, rows]) => {
        const [tradingDate, ticker] = key.split('|');
        const results = rows.map((row) => row.mechanicalResultR);
        const traders = new Set(rows.map((row) => row.traderId || row.sourceImportId));
        const med = median(results);
        return {
            tradingDate,
            ticker,
            uniqueTraders: traders.size,
            signalCount: rows.length,
            medianR: med,
            meanR: mean(results),
            bestR: Math.max(...results),
            worstR: Math.min(...results),
            worked: med > 0,
            hit1r: med >= 1,
            hit2r: med >= 2,
            hit3r: med >= 3,
        };
    }).sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : left.tradingDate > right.tradingDate ? 1 : left.ticker < right.ticker ? -1 : 1));
}

export function dayEdgeMetrics(outcomes = []) {
    const rows = outcomes.filter((row) => Number.isFinite(row.medianR));
    const count = rows.length;
    const winners = rows.filter((row) => row.medianR > 0);
    const signals = rows.reduce((sum, row) => sum + (row.signalCount || 1), 0);
    return {
        uniqueTickers: count,
        signalCount: signals,
        dumpBreadth: count ? rows.filter((row) => row.worked).length / count : null,
        medianTickerR: median(rows.map((row) => row.medianR)),
        meanTickerR: mean(rows.map((row) => row.medianR)),
        winnerMedianR: median(winners.map((row) => row.medianR)),
        winnerMeanR: mean(winners.map((row) => row.medianR)),
        bigWinnerRate1r: count ? rows.filter((row) => row.hit1r).length / count : null,
        bigWinnerRate2r: count ? rows.filter((row) => row.hit2r).length / count : null,
        bigWinnerRate3r: count ? rows.filter((row) => row.hit3r).length / count : null,
        repeatPressure: signals > 0 ? 1 - count / signals : null,
    };
}

function fallbackScore(value, low, mid, high) {
    const current = finite(value);
    if (current == null) return null;
    if (current <= low) return 0;
    if (current >= high) return 100;
    if (current <= mid) return ((current - low) / (mid - low)) * 50;
    return 50 + ((current - mid) / (high - mid)) * 50;
}

function percentileOrFallback(history, current, low, mid, high) {
    const sample = [...(history || []), current].filter((value) => Number.isFinite(value)).slice(-126);
    if (sample.length >= PERCENTILE_MIN) {
        const atOrBelow = sample.reduce((count, value) => count + (value <= current ? 1 : 0), 0);
        return { value: (atOrBelow / sample.length) * 100, method: 'percentile' };
    }
    const fallback = fallbackScore(current, low, mid, high);
    return { value: fallback, method: fallback == null ? 'missing' : 'fallback' };
}

export function scoreDailyEdge(metrics, history = {}) {
    const breadth = percentileOrFallback(history.breadth, metrics.dumpBreadth, 0.3, 0.5, 0.7);
    const medianR = percentileOrFallback(history.median, metrics.medianTickerR, -0.5, 0, 0.5);
    const rate2 = percentileOrFallback(history.rate2, metrics.bigWinnerRate2r, 0.1, 0.25, 0.4);
    const extensionRaw = finite(metrics.winnerMedianR);
    const extension = percentileOrFallback(history.extension, extensionRaw, 0, 1, 2);
    const parts = [breadth, medianR, rate2, extension].filter((part) => part.value != null);
    if (!parts.length || metrics.uniqueTickers < 1) return { score: null, parts: { breadth, medianR, rate2, extension } };
    const score = 0.4 * (breadth.value ?? 0) + 0.25 * (medianR.value ?? 0) + 0.2 * (rate2.value ?? 0) + 0.15 * (extension.value ?? 0);
    return { score: clamp(score, 0, 100), parts: { breadth, medianR, rate2, extension } };
}

export function buildEdgeSeries(outcomes = []) {
    const byDate = new Map();
    for (const outcome of outcomes) {
        if (!byDate.has(outcome.tradingDate)) byDate.set(outcome.tradingDate, []);
        byDate.get(outcome.tradingDate).push(outcome);
    }
    const history = { breadth: [], median: [], rate2: [], extension: [] };
    const rows = [];
    for (const date of [...byDate.keys()].sort()) {
        const metrics = dayEdgeMetrics(byDate.get(date));
        const scored = scoreDailyEdge(metrics, history);
        rows.push({ date, ...metrics, actualEdgeScore: scored.score, normalization: scored.parts.breadth.method });
        if (metrics.dumpBreadth != null) history.breadth.push(metrics.dumpBreadth);
        if (metrics.medianTickerR != null) history.median.push(metrics.medianTickerR);
        if (metrics.bigWinnerRate2r != null) history.rate2.push(metrics.bigWinnerRate2r);
        if (metrics.winnerMedianR != null) history.extension.push(metrics.winnerMedianR);
    }
    return rows;
}

function windowMetrics(outcomes) {
    return dayEdgeMetrics(outcomes);
}

function windowEdge(outcomes) {
    if (!outcomes.length) return null;
    return scoreDailyEdge(windowMetrics(outcomes), {}).score;
}

export function transitionBlock(outcomes = []) {
    const ordered = [...outcomes].sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : 1));
    if (ordered.length < FAST_WINDOW) return null;
    const fastOutcomes = ordered.slice(-FAST_WINDOW);
    const midOutcomes = ordered.slice(-Math.min(MID_WINDOW, ordered.length));
    const slowOutcomes = ordered.slice(-Math.min(SLOW_WINDOW, ordered.length));
    const fast = windowEdge(fastOutcomes);
    const mid = windowEdge(midOutcomes);
    const slow = windowEdge(slowOutcomes);
    if (fast == null || slow == null) return null;
    const fastMetrics = windowMetrics(fastOutcomes);
    const acceleration = fast - slow;
    return {
        score: clamp(50 + acceleration * 0.8, 0, 100),
        fast,
        mid,
        slow,
        acceleration,
        fastBreadth: fastMetrics.dumpBreadth,
        fastRate2: fastMetrics.bigWinnerRate2r,
        fastWinnerMedian: fastMetrics.winnerMedianR,
        uniqueTickers: fastMetrics.uniqueTickers,
    };
}

function rolling(rows, index, days, key) {
    const slice = rows.slice(Math.max(0, index - days + 1), index + 1).map((row) => row[key]).filter((value) => Number.isFinite(value));
    return mean(slice);
}

export function laggedMechanicalScore(edgeRows = []) {
    if (edgeRows.length < MIN_EDGE_DAYS) return null;
    const index = edgeRows.length - 1;
    const current = edgeRows[index];
    const breadth3 = rolling(edgeRows, index, 3, 'dumpBreadth');
    const breadth5 = rolling(edgeRows, index, 5, 'dumpBreadth');
    const median5 = rolling(edgeRows, index, 5, 'medianTickerR');
    const rate5 = rolling(edgeRows, index, 5, 'bigWinnerRate2r');
    const history = {
        breadth: edgeRows.slice(0, -1).map((row) => row.dumpBreadth),
        breadth3: [],
        median5: [],
        rate5: [],
    };
    for (let cursor = 0; cursor < index; cursor += 1) {
        history.breadth3.push(rolling(edgeRows, cursor, 3, 'dumpBreadth'));
        history.median5.push(rolling(edgeRows, cursor, 5, 'medianTickerR'));
        history.rate5.push(rolling(edgeRows, cursor, 5, 'bigWinnerRate2r'));
    }
    const parts = [
        percentileOrFallback(history.breadth, current.dumpBreadth, 0.3, 0.5, 0.7),
        percentileOrFallback(history.breadth3, breadth3, 0.3, 0.5, 0.7),
        percentileOrFallback(history.median5, median5, -0.5, 0, 0.5),
        percentileOrFallback(history.rate5, rate5, 0.1, 0.25, 0.4),
    ];
    const score = parts.reduce((sum, part) => sum + (part.value ?? 0), 0) / parts.length;
    return {
        score: clamp(score, 0, 100),
        dumpBreadth1: current.dumpBreadth,
        dumpBreadth3: breadth3,
        dumpBreadth5: breadth5,
        median5,
        rate2: current.bigWinnerRate2r,
        rate2_5: rate5,
        winnerMedian: current.winnerMedianR,
        uniqueTickers: current.uniqueTickers,
        repeatPressure: current.repeatPressure,
    };
}

export function combineNextSession(market, lagged, transition) {
    const marketScore = finite(market);
    if (marketScore == null) return { score: null, mode: 'incomplete' };
    const laggedScore = finite(lagged);
    const transitionScore = finite(transition);
    if (laggedScore == null || transitionScore == null) return { score: clamp(marketScore, 0, 100), mode: 'market-only' };
    return {
        score: clamp(NEXT_WEIGHTS.market * marketScore + NEXT_WEIGHTS.lagged * laggedScore + NEXT_WEIGHTS.transition * transitionScore, 0, 100),
        mode: 'full',
    };
}

export function regimeState({ market, lagged, transition, acceleration }) {
    const marketScore = finite(market) ?? 0;
    const laggedScore = finite(lagged);
    const transitionScore = finite(transition) ?? 0;
    const accel = finite(acceleration) ?? 0;
    if (marketScore >= 65 && laggedScore != null && laggedScore >= 65 && transitionScore >= 60) return 'STRONG';
    if (accel <= -15 && transitionScore <= 45 && (laggedScore == null || laggedScore >= 50)) return 'DETERIORATING';
    if (transitionScore >= 70 && marketScore >= 55 && accel >= 15) return 'RECOVERY';
    if (transitionScore >= 60 && marketScore >= 40 && (laggedScore == null || laggedScore < 55)) return 'TURNING';
    if (laggedScore != null && laggedScore >= 55 && marketScore >= 45) return 'ON';
    if (marketScore < 45 && (laggedScore == null || laggedScore < 45) && transitionScore < 55) return 'OFF';
    return marketScore >= 50 ? 'ON' : 'OFF';
}

export function predictionConfidence({ mode, edgeDays, recentTickers, marketComplete, disagreement }) {
    let confidence = 100;
    if (!marketComplete) confidence -= 40;
    if (mode !== 'full') confidence -= 45;
    if ((edgeDays || 0) < PERCENTILE_MIN) confidence -= 15;
    if ((recentTickers || 0) < FAST_WINDOW) confidence -= 20;
    if (disagreement) confidence -= 10;
    return clamp(Math.round(confidence), 0, 100);
}

export function explainPrediction({ state, market, lagged, acceleration }) {
    const lines = [];
    if (finite(lagged) == null) lines.push('Офісних механічних точок ще мало, тому блок результатів майже не впливає на число.');
    else if (lagged < 45) lines.push('Механічні результати ще нижче своєї звичайної норми.');
    else if (lagged >= 60) lines.push('Офісні механічні шорти останніми днями відпрацьовують.');
    if (finite(acceleration) != null && acceleration >= 15) lines.push('Коротке вікно вже краще за довге: ширина дампів і продовження переможців покращуються.');
    if (finite(acceleration) != null && acceleration <= -15) lines.push('Коротке вікно різко гірше за довге: зручний період починає псуватися.');
    if (finite(market) != null && market >= 60) lines.push('Ринкові умови для дрібних і спекулятивних імен не ворожі.');
    else if (finite(market) != null && market < 40) lines.push('Ринок зараз ворожий для цього типу шортів.');
    lines.push(`Модель ставить наступну сесію в стан ${state}.`);
    return lines.join(' ');
}

export function premarketAdjustment(quotes = {}) {
    const move = (value) => {
        const change = finite(typeof value === 'object' ? (value?.fromPrevClose ?? value?.change) : value);
        if (change == null) return 0;
        return clamp(change / 0.01, -1, 1) * 4;
    };
    const adjustment = move(quotes.SPY) + move(quotes.QQQ) * 0.75 + move(quotes.IWM);
    return clamp(Math.round(adjustment * 10) / 10, -PREMARKET_LIMIT, PREMARKET_LIMIT);
}

export function predictNextSession({ barsByKey = {}, signals = [], featureDate, premarket = 0 }) {
    const targetDate = nextTradingDay(featureDate);
    const visible = (signals || []).filter((signal) => signal.tradingDate <= featureDate);
    const outcomes = tickerDayOutcomes(visible);
    const edges = buildEdgeSeries(outcomes);
    const market = scoreSessionFromBars(barsByKey, targetDate, { liveAdjustment: 0 });
    if (!market.complete) {
        return {
            complete: false,
            message: 'Data incomplete',
            featureDate,
            targetDate,
            missing: market.missing || [],
            scoreVersion: NEXT_SCORE_VERSION,
        };
    }
    const lagged = laggedMechanicalScore(edges);
    const transition = transitionBlock(outcomes);
    const combined = combineNextSession(market.displayScore, lagged?.score, transition?.score);
    const state = regimeState({
        market: market.displayScore,
        lagged: lagged?.score,
        transition: transition?.score,
        acceleration: transition?.acceleration,
    });
    const adjustment = clamp(finite(premarket) ?? 0, -PREMARKET_LIMIT, PREMARKET_LIMIT);
    const finalScore = clamp(combined.score + adjustment, 0, 100);
    const status = aggressivenessStatus(finalScore);
    const confidence = predictionConfidence({
        mode: combined.mode,
        edgeDays: edges.length,
        recentTickers: outcomes.length,
        marketComplete: true,
        disagreement: lagged != null && market.displayScore >= 70 && lagged.score < 35,
    });
    return {
        complete: true,
        scoreVersion: NEXT_SCORE_VERSION,
        weights: NEXT_WEIGHTS,
        featureDate,
        targetDate,
        marketLeading: market.displayScore,
        laggedMechanical: lagged?.score ?? null,
        transition: transition?.score ?? null,
        basePrediction: Math.round(combined.score),
        premarketAdjustment: adjustment,
        finalScore: status.score,
        label: status.label,
        tone: status.tone,
        regimeState: state,
        confidence,
        mode: combined.mode,
        explanation: explainPrediction({
            state,
            market: market.displayScore,
            lagged: lagged?.score,
            acceleration: transition?.acceleration,
        }),
        lagged,
        transitionDetail: transition,
        marketComponents: market.components,
        features: {
            ...(market.features || {}),
            laggedDumpBreadth1: lagged?.dumpBreadth1 ?? null,
            laggedDumpBreadth3: lagged?.dumpBreadth3 ?? null,
            laggedDumpBreadth5: lagged?.dumpBreadth5 ?? null,
            fastEdge: transition?.fast ?? null,
            slowEdge: transition?.slow ?? null,
            edgeAcceleration: transition?.acceleration ?? null,
        },
    };
}

export function entryLevelMetrics(signals = []) {
    const results = signals.map((signal) => signal.mechanicalResultR).filter((value) => Number.isFinite(value));
    return {
        entryWinRate: results.length ? results.filter((value) => value > 0).length / results.length : null,
        entryMeanR: mean(results),
        entryMedianR: median(results),
    };
}

function bucketId(score) {
    if (score < 20) return '0-20';
    if (score < 40) return '20-40';
    if (score < 60) return '40-60';
    if (score < 80) return '60-80';
    return '80-100';
}

export function nextDayBacktest({ barsByKey = {}, signals = [] } = {}) {
    const outcomes = tickerDayOutcomes(signals);
    const edges = buildEdgeSeries(outcomes);
    const edgeByDate = new Map(edges.map((row) => [row.date, row]));
    const featureDates = [...new Set(outcomes.map((row) => row.tradingDate))].sort();
    const marketDates = featureDates.length ? featureDates : [];
    const days = [];
    const seenTargets = new Set();
    for (const featureDate of marketDates) {
        const targetDate = nextTradingDay(featureDate);
        if (seenTargets.has(targetDate) || !edgeByDate.has(targetDate)) continue;
        const prediction = predictNextSession({ barsByKey, signals, featureDate, premarket: 0 });
        if (!prediction.complete) continue;
        seenTargets.add(targetDate);
        days.push({
            featureDate,
            targetDate,
            prediction: prediction.basePrediction,
            actualEdge: edgeByDate.get(targetDate).actualEdgeScore,
            actual: edgeByDate.get(targetDate),
            regimeState: prediction.regimeState,
            features: prediction.features,
        });
    }
    const buckets = ['0-20', '20-40', '40-60', '60-80', '80-100'].map((id) => summarizeBucket(id, days.filter((day) => bucketId(day.prediction) === id)));
    const ranked = [...days].sort((left, right) => left.prediction - right.prediction);
    const slice = Math.max(1, Math.floor(ranked.length * 0.2));
    return {
        scoreVersion: NEXT_SCORE_VERSION,
        weightsChanged: false,
        alignment: 'prediction uses feature date D; actual is the mechanical edge of target date D+1',
        days: days.length,
        buckets,
        tails: {
            bottom20: summarizeBucket('bottom-20', ranked.slice(0, slice)),
            top20: summarizeBucket('top-20', ranked.slice(-slice)),
        },
        walkForward: walkForwardMonths(days),
        lags: featureLagTable(days),
    };
}

function summarizeBucket(id, rows) {
    const actuals = rows.map((row) => row.actual).filter(Boolean);
    const breadth = mean(actuals.map((row) => row.dumpBreadth));
    return {
        id,
        days: rows.length,
        uniqueTickers: actuals.reduce((sum, row) => sum + (row.uniqueTickers || 0), 0),
        dumpBreadth: breadth,
        medianTickerR: median(actuals.map((row) => row.medianTickerR)),
        meanTickerR: mean(actuals.map((row) => row.meanTickerR)),
        rate1: mean(actuals.map((row) => row.bigWinnerRate1r)),
        rate2: mean(actuals.map((row) => row.bigWinnerRate2r)),
        rate3: mean(actuals.map((row) => row.bigWinnerRate3r)),
        positiveDayPct: rows.length ? rows.filter((row) => (row.actual?.medianTickerR || 0) > 0).length / rows.length : null,
    };
}

function walkForwardMonths(days) {
    const byMonth = new Map();
    for (const day of days) {
        const month = day.targetDate.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(day);
    }
    return [...byMonth.entries()].map(([month, rows]) => ({
        month,
        days: rows.length,
        meanPrediction: mean(rows.map((row) => row.prediction)),
        meanActual: mean(rows.map((row) => row.actualEdge)),
        outOfSample: true,
        weightsChanged: false,
    }));
}

function spearman(left, right) {
    const pairs = left.map((value, index) => [value, right[index]]).filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
    if (pairs.length < 8) return { n: pairs.length, rho: null };
    const rank = (values) => {
        const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
        const ranks = Array(values.length);
        for (let index = 0; index < order.length;) {
            let end = index;
            while (end + 1 < order.length && order[end + 1].value === order[index].value) end += 1;
            const average = (index + end) / 2 + 1;
            for (let cursor = index; cursor <= end; cursor += 1) ranks[order[cursor].index] = average;
            index = end + 1;
        }
        return ranks;
    };
    const xs = rank(pairs.map((pair) => pair[0]));
    const ys = rank(pairs.map((pair) => pair[1]));
    const meanX = mean(xs);
    const meanY = mean(ys);
    let num = 0;
    let denX = 0;
    let denY = 0;
    xs.forEach((value, index) => {
        const dx = value - meanX;
        const dy = ys[index] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    });
    const den = Math.sqrt(denX * denY);
    return { n: pairs.length, rho: den ? num / den : null };
}

function featureLagTable(days) {
    const names = ['spy5d', 'iwmRs5', 'iwcRs5', 'xbiRs5', 'arkkRs5', 'qqqRs5', 'smhRs5', 'vix1d', 'oil5d'];
    const byTarget = new Map(days.map((day) => [day.targetDate, day]));
    const ahead = (date, steps) => {
        let cursor = date;
        for (let step = 0; step < steps; step += 1) cursor = nextTradingDay(cursor);
        return cursor;
    };
    return names.map((name) => {
        const aligned = { 1: [], 2: [], 3: [], 5: [] };
        const actuals = { 1: [], 2: [], 3: [], 5: [] };
        days.forEach((day) => {
            const value = day.features?.[name];
            [1, 2, 3, 5].forEach((lag) => {
                const future = byTarget.get(lag === 1 ? day.targetDate : ahead(day.targetDate, lag - 1));
                if (!future || future.targetDate <= day.featureDate) return;
                aligned[lag].push(value);
                actuals[lag].push(future.actualEdge);
            });
        });
        const next = spearman(aligned[1], actuals[1]);
        const pairs = aligned[1].map((value, index) => [value, actuals[1][index]]).filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
        const ranked = [...pairs].sort((left, right) => left[0] - right[0]);
        const slice = Math.max(1, Math.floor(ranked.length * 0.2));
        const quintile = (chunk) => chunk.length ? chunk.reduce((sum, pair) => sum + pair[1], 0) / chunk.length : null;
        return {
            feature: name,
            sample: next.n,
            spearmanD1: next.rho,
            spearmanD2: spearman(aligned[2], actuals[2]).rho,
            spearmanD3: spearman(aligned[3], actuals[3]).rho,
            spearmanD5: spearman(aligned[5], actuals[5]).rho,
            bottomQuintileD1: quintile(ranked.slice(0, slice)),
            topQuintileD1: quintile(ranked.slice(-slice)),
        };
    });
}

export function chartRows(predictions = [], edges = []) {
    const actualByDate = new Map(edges.map((row) => [row.date, row.actualEdgeScore]));
    return predictions.map((row) => ({
        targetDate: row.targetDate,
        featureDate: row.featureDate,
        prediction: row.basePrediction ?? row.finalScore,
        actual: actualByDate.get(row.targetDate) ?? null,
    }));
}
