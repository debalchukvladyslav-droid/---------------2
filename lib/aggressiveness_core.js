/**
 * Market Aggressiveness for mechanical pump-and-dump shorts.
 * Score version 1. A session score uses only closes through the previous
 * US trading day. Manual journal results are not an input.
 */

export const SCORE_VERSION = 1;
export const LIVE_ADJUSTMENT_LIMIT = 8;
export const LIVE_EMA_ALPHA = 0.35;
export const NARROW_PENALTY_CAP = 18;
export const PERCENTILE_WINDOW = 126;
export const PERCENTILE_MIN = 60;

export const BASE_WEIGHTS = Object.freeze({
    microSmall: 0.35,
    speculative: 0.25,
    broad: 0.15,
    stress: 0.25,
});

export const REQUIRED_SERIES = Object.freeze([
    'SPY', 'QQQ', 'IWM', 'IWC', 'XBI', 'ARKK', 'SMH', 'VIX', 'US10Y', 'OIL',
]);

/** NYSE full closures. Early closes remain trading days. */
const US_MARKET_HOLIDAYS = new Set([
    '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
    '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

const finite = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, finite(value) ?? min));
}

export function resolveWeights() {
    return {
        version: SCORE_VERSION,
        weights: BASE_WEIGHTS,
        refit: false,
        cadence: 'monthly-review-only',
    };
}

export function addCalendarDays(isoDate, days) {
    const [year, month, day] = String(isoDate).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

export function isUsMarketHoliday(isoDate) {
    return US_MARKET_HOLIDAYS.has(isoDate);
}

export function isTradingDay(isoDate) {
    const [year, month, day] = String(isoDate).split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !US_MARKET_HOLIDAYS.has(isoDate);
}

export function previousTradingDay(isoDate) {
    let cursor = addCalendarDays(isoDate, -1);
    for (let guard = 0; guard < 12 && !isTradingDay(cursor); guard += 1) cursor = addCalendarDays(cursor, -1);
    return cursor;
}

export function nextTradingDay(isoDate) {
    let cursor = addCalendarDays(isoDate, 1);
    for (let guard = 0; guard < 12 && !isTradingDay(cursor); guard += 1) cursor = addCalendarDays(cursor, 1);
    return cursor;
}

export function newYorkParts(instant = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(instant).map((part) => [part.type, part.value]));
    let hour = Number(parts.hour);
    if (hour === 24) hour = 0;
    const minute = Number(parts.minute);
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        hour,
        minute,
        second: Number(parts.second) || 0,
        minutes: hour * 60 + minute,
    };
}

/** Trading session whose pre-open score should be on the gauge. */
export function displaySessionDate(instant = new Date()) {
    const ny = newYorkParts(instant);
    if (isTradingDay(ny.date) && ny.minutes >= 4 * 60 && ny.minutes < 16 * 60) return ny.date;
    if (isTradingDay(ny.date) && ny.minutes < 4 * 60) return previousTradingDay(ny.date);
    return previousTradingDay(addCalendarDays(ny.date, 1));
}

export function sessionPhase(instant = new Date()) {
    const ny = newYorkParts(instant);
    if (!isTradingDay(ny.date)) return 'frozen';
    if (ny.minutes < 4 * 60) return 'frozen';
    if (ny.minutes < 9 * 60 + 30) return 'premarket';
    if (ny.minutes < 11 * 60 + 40) return 'open';
    return 'frozen';
}

export function nextLivePollDelay(instant = new Date(), intervalMin = 5) {
    if (sessionPhase(instant) !== 'open') return null;
    const ny = newYorkParts(instant);
    const into = ny.minutes % intervalMin;
    const remainMin = into === 0 && ny.second < 5 ? intervalMin : (intervalMin - into) % intervalMin || intervalMin;
    return Math.max(5000, remainMin * 60 * 1000 - ny.second * 1000);
}

export function formatEtClock(instant) {
    const date = instant instanceof Date ? instant : new Date(instant);
    if (Number.isNaN(date.getTime())) return '';
    const clock = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(date);
    return `${clock} ET`;
}

export function aggressivenessStatus(score) {
    const rounded = Math.round(clamp(score, 0, 100));
    if (rounded <= 19) return { score: rounded, label: 'Мінімальна', tone: 'minimal' };
    if (rounded <= 39) return { score: rounded, label: 'Обережно', tone: 'cautious' };
    if (rounded <= 59) return { score: rounded, label: 'Нейтральна', tone: 'neutral' };
    if (rounded <= 79) return { score: rounded, label: 'Агресивна', tone: 'aggressive' };
    return { score: rounded, label: 'Максимальна', tone: 'maximal' };
}

export function needlePoint(score, radius = 92, cx = 120, cy = 110) {
    const value = clamp(score, 0, 100);
    const angle = Math.PI * (1 - value / 100);
    return {
        cx: cx + radius * Math.cos(angle),
        cy: cy - radius * Math.sin(angle),
    };
}

export function linearRelativeFallback(relativeReturn) {
    return clamp(50 + (Number(relativeReturn) / 0.03) * 50, 0, 100);
}

export function trailingPercentile(values, window = PERCENTILE_WINDOW, min = PERCENTILE_MIN) {
    const sample = (values || []).filter((value) => Number.isFinite(value)).slice(-window);
    if (sample.length < min) return null;
    const current = sample[sample.length - 1];
    const atOrBelow = sample.reduce((count, value) => count + (value <= current ? 1 : 0), 0);
    return (atOrBelow / sample.length) * 100;
}

export function relativePercentile(values) {
    const history = (values || []).filter((value) => Number.isFinite(value));
    if (!history.length) return { value: null, method: 'missing' };
    const percentile = trailingPercentile(history);
    if (percentile != null) return { value: percentile, method: 'percentile' };
    return { value: linearRelativeFallback(history[history.length - 1]), method: 'linear-fallback' };
}

export function microSmallBreadth(pct) {
    return 0.25 * pct.iwm5 + 0.20 * pct.iwm10 + 0.30 * pct.iwc5 + 0.25 * pct.iwc10;
}

export function speculativeAppetite(pct) {
    return 0.35 * pct.xbi5 + 0.25 * pct.xbi10 + 0.25 * pct.arkk5 + 0.15 * pct.arkk10;
}

export function broadMarketRegime({ spy5d, spy10d, spy20d, spyRv5 }) {
    let score = 50;
    if (spy5d >= 0.005 && spy5d <= 0.035) score += 15;
    if (spy10d >= 0 && spy10d <= 0.05) score += 10;
    if (spyRv5 >= 0.006 && spyRv5 <= 0.012) score += 10;
    if (spy5d < -0.03) score -= 20;
    if (spy5d > 0.05 && spy20d > 0.08) score -= 15;
    if (spyRv5 > 0.018) score -= 20;
    return clamp(score, 0, 100);
}

export function stressSafety(input) {
    let score = 100;
    if (input.vix1d >= 0.08) score -= 10;
    if (input.vix5d >= 0.20) score -= 20;
    if (input.vix > 35) score -= 35;
    else if (input.vix > 25) score -= 20;
    if (input.us10y5dBp >= 25) score -= 20;
    else if (input.us10y5dBp >= 15) score -= 10;
    if (input.oil5d >= 0.10) score -= 20;
    else if (input.oil5d >= 0.05) score -= 10;
    if (input.spy1d < -0.01 && input.iwm1d < -0.015) score -= 15;
    return clamp(score, 0, 100);
}

export function narrowLeadershipPenalty(rs) {
    let penalty = 0;
    if (rs.qqq5 > 0.02 && rs.iwm5 < -0.01) penalty += 8;
    if (rs.smh5 > 0.03 && rs.iwc5 < -0.01) penalty += 8;
    if (rs.xbi5 < -0.015) penalty += 6;
    return Math.min(NARROW_PENALTY_CAP, penalty);
}

export function meltUpPenalty({ spy20d, vixPercentile, iwmRs10 }) {
    if (spy20d > 0.08 && vixPercentile != null && vixPercentile < 20 && iwmRs10 < 0) return 10;
    return 0;
}

export function baseScore(parts) {
    return BASE_WEIGHTS.microSmall * parts.microSmall
        + BASE_WEIGHTS.speculative * parts.speculative
        + BASE_WEIGHTS.broad * parts.broad
        + BASE_WEIGHTS.stress * parts.stress;
}

export function finalAggressiveness(base, narrowPenalty, meltPenalty, liveAdjustment = 0) {
    return clamp(base - narrowPenalty - meltPenalty + liveAdjustment, 0, 100);
}

export function rawLiveAdjustment(quotes = {}, context = {}) {
    const spy = finite(quotes.SPY);
    const qqq = finite(quotes.QQQ);
    const iwm = finite(quotes.IWM);
    let adjustment = 0;
    if (spy != null && qqq != null && iwm != null) {
        if (spy > 0.004 && qqq > 0.005 && iwm > 0.004) adjustment += 4;
        else if ([spy > 0.003, qqq > 0.003, iwm > 0.003].filter(Boolean).length >= 2) adjustment += 2;
        else if (spy < -0.004 && qqq < -0.005 && iwm < -0.004) adjustment -= 4;
        else if ([spy < -0.003, qqq < -0.003, iwm < -0.003].filter(Boolean).length >= 2) adjustment -= 2;
    }
    if (finite(quotes.OIL) > 0.01 && finite(quotes.US10Y_BP) >= 3) adjustment -= 2;
    const futures = finite(quotes.VIX_FUTURES);
    if (context.priorShock && futures != null) {
        if (futures <= -0.05) adjustment += 2;
        else if (futures <= -0.03) adjustment += 1;
    }
    return clamp(adjustment, -LIVE_ADJUSTMENT_LIMIT, LIVE_ADJUSTMENT_LIMIT);
}

export function smoothLiveAdjustment(previous, raw, alpha = LIVE_EMA_ALPHA) {
    const next = finite(raw);
    if (next == null) return finite(previous);
    const prior = finite(previous);
    const blended = prior == null ? next * alpha : prior + alpha * (next - prior);
    return clamp(blended, -LIVE_ADJUSTMENT_LIMIT, LIVE_ADJUSTMENT_LIMIT);
}

/**
 * Recent mechanical expectancy is a diagnostic. It is intentionally absent
 * from baseScore / finalAggressiveness.
 */
export function systemHealth(days = []) {
    const expectancy = (count) => {
        const slice = days.slice(-count);
        const entries = slice.reduce((sum, day) => sum + (Number(day.entries) || 0), 0);
        const totalR = slice.reduce((sum, day) => sum + (Number(day.totalR) || 0), 0);
        return entries > 0 ? totalR / entries : null;
    };
    return {
        expectancy20: expectancy(20),
        expectancy50: expectancy(50),
        expectancy100: expectancy(100),
        usedInAggressiveness: false,
    };
}

function dedupeBars(bars) {
    const byDate = new Map();
    for (const bar of bars || []) {
        const close = finite(bar?.close);
        if (!bar?.date || close == null) continue;
        byDate.set(bar.date, close);
    }
    return [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}

function windowReturn(closes, days) {
    if (closes.length < days + 1) return null;
    const previous = closes[closes.length - 1 - days];
    if (!(previous > 0)) return null;
    return closes[closes.length - 1] / previous - 1;
}

function realizedVolatility(closes, days = 5) {
    if (closes.length < days + 1) return null;
    const returns = [];
    for (let index = closes.length - days; index < closes.length; index += 1) {
        const previous = closes[index - 1];
        if (!(previous > 0)) return null;
        returns.push(closes[index] / previous - 1);
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
}

function alignedRelative(leftBars, rightBars, days) {
    const right = new Map(dedupeBars(rightBars));
    const leftCloses = [];
    const rightCloses = [];
    for (const [date, close] of dedupeBars(leftBars)) {
        if (!right.has(date)) continue;
        leftCloses.push(close);
        rightCloses.push(right.get(date));
    }
    const history = [];
    for (let index = days; index < leftCloses.length; index += 1) {
        const leftBase = leftCloses[index - days];
        const rightBase = rightCloses[index - days];
        if (!(leftBase > 0) || !(rightBase > 0)) continue;
        history.push((leftCloses[index] / leftBase - 1) - (rightCloses[index] / rightBase - 1));
    }
    return history;
}

function closesThrough(bars, cutoff) {
    return dedupeBars((bars || []).filter((bar) => bar.date <= cutoff)).map((entry) => entry[1]);
}

function lastLevel(bars, cutoff) {
    const rows = dedupeBars((bars || []).filter((bar) => bar.date <= cutoff));
    return rows.length ? rows[rows.length - 1][1] : null;
}

function yieldChangeBp(bars, cutoff, days) {
    const levels = closesThrough(bars, cutoff);
    if (levels.length < days + 1) return null;
    return (levels[levels.length - 1] - levels[levels.length - 1 - days]) * 100;
}

export function scoreSessionFromBars(barsByKey = {}, sessionDate, options = {}) {
    const infoThrough = previousTradingDay(sessionDate);
    const missing = [];
    for (const key of REQUIRED_SERIES) {
        const rows = dedupeBars((barsByKey[key] || []).filter((bar) => bar.date <= infoThrough));
        if (!rows.length || rows[rows.length - 1][0] < infoThrough) missing.push(key);
    }
    if (missing.length) {
        return incomplete(sessionDate, infoThrough, missing, options);
    }

    const through = (key) => filterBars(barsByKey[key], infoThrough);
    const spyBars = through('SPY');
    const spy = closesThrough(spyBars, infoThrough);
    const iwm = closesThrough(through('IWM'), infoThrough);
    const relative = (key, days) => alignedRelative(through(key), spyBars, days);
    const features = {
        spy1d: windowReturn(spy, 1),
        spy5d: windowReturn(spy, 5),
        spy10d: windowReturn(spy, 10),
        spy20d: windowReturn(spy, 20),
        spyRv5: realizedVolatility(spy, 5),
        iwm1d: windowReturn(iwm, 1),
        qqqRs5: lastOf(relative('QQQ', 5)),
        qqqRs10: lastOf(relative('QQQ', 10)),
        iwmRs5: lastOf(relative('IWM', 5)),
        iwmRs10: lastOf(relative('IWM', 10)),
        iwcRs5: lastOf(relative('IWC', 5)),
        iwcRs10: lastOf(relative('IWC', 10)),
        xbiRs5: lastOf(relative('XBI', 5)),
        xbiRs10: lastOf(relative('XBI', 10)),
        arkkRs5: lastOf(relative('ARKK', 5)),
        arkkRs10: lastOf(relative('ARKK', 10)),
        smhRs5: lastOf(relative('SMH', 5)),
        smhRs10: lastOf(relative('SMH', 10)),
        vix: lastLevel(barsByKey.VIX, infoThrough),
        vix1d: windowReturn(closesThrough(barsByKey.VIX, infoThrough), 1),
        vix5d: windowReturn(closesThrough(barsByKey.VIX, infoThrough), 5),
        us10y: lastLevel(barsByKey.US10Y, infoThrough),
        us10y5dBp: yieldChangeBp(barsByKey.US10Y, infoThrough, 5),
        oil: lastLevel(barsByKey.OIL, infoThrough),
        oil1d: windowReturn(closesThrough(barsByKey.OIL, infoThrough), 1),
        oil5d: windowReturn(closesThrough(barsByKey.OIL, infoThrough), 5),
    };

    const historyShort = Object.entries(features).filter(([, value]) => value == null).map(([key]) => key);
    if (historyShort.length) return incomplete(sessionDate, infoThrough, historyShort, options, 'history');

    const pct = {
        iwm5: relativePercentile(relative('IWM', 5)),
        iwm10: relativePercentile(relative('IWM', 10)),
        iwc5: relativePercentile(relative('IWC', 5)),
        iwc10: relativePercentile(relative('IWC', 10)),
        xbi5: relativePercentile(relative('XBI', 5)),
        xbi10: relativePercentile(relative('XBI', 10)),
        arkk5: relativePercentile(relative('ARKK', 5)),
        arkk10: relativePercentile(relative('ARKK', 10)),
    };
    const vixPercentile = trailingPercentile(closesThrough(through('VIX'), infoThrough));
    const micro = microSmallBreadth({
        iwm5: pct.iwm5.value, iwm10: pct.iwm10.value, iwc5: pct.iwc5.value, iwc10: pct.iwc10.value,
    });
    const speculative = speculativeAppetite({
        xbi5: pct.xbi5.value, xbi10: pct.xbi10.value, arkk5: pct.arkk5.value, arkk10: pct.arkk10.value,
    });
    const broad = broadMarketRegime({
        spy5d: features.spy5d, spy10d: features.spy10d, spy20d: features.spy20d, spyRv5: features.spyRv5,
    });
    const stress = stressSafety({
        vix: features.vix,
        vix1d: features.vix1d,
        vix5d: features.vix5d,
        us10y5dBp: features.us10y5dBp,
        oil5d: features.oil5d,
        spy1d: features.spy1d,
        iwm1d: features.iwm1d,
    });
    const narrow = narrowLeadershipPenalty({
        qqq5: features.qqqRs5, iwm5: features.iwmRs5, smh5: features.smhRs5, iwc5: features.iwcRs5, xbi5: features.xbiRs5,
    });
    const melt = meltUpPenalty({ spy20d: features.spy20d, vixPercentile, iwmRs10: features.iwmRs10 });
    const base = baseScore({ microSmall: micro, speculative, broad, stress });
    const live = finite(options.liveAdjustment) ?? 0;
    const finalScore = finalAggressiveness(base, narrow, melt, live);
    const status = aggressivenessStatus(finalScore);
    return {
        complete: true,
        stale: false,
        missing: [],
        sessionDate,
        infoThrough,
        scoreVersion: SCORE_VERSION,
        baseScore: base,
        liveAdjustment: live,
        liveScore: finalScore,
        displayScore: status.score,
        label: status.label,
        tone: status.tone,
        components: {
            microSmall: micro,
            speculative,
            broad,
            stress,
            narrowPenalty: narrow,
            meltUpPenalty: melt,
            liveAdjustment: live,
            percentileMethod: {
                iwm5: pct.iwm5.method,
                iwc5: pct.iwc5.method,
                xbi5: pct.xbi5.method,
                arkk5: pct.arkk5.method,
            },
        },
        features,
        vixPercentile,
        weights: resolveWeights(),
        systemHealthIgnored: true,
    };
}

function filterBars(bars, cutoff) {
    return (bars || []).filter((bar) => bar.date <= cutoff);
}

function lastOf(history) {
    return history.length ? history[history.length - 1] : null;
}

function incomplete(sessionDate, infoThrough, missing, options, reason = 'stale') {
    return {
        complete: false,
        stale: reason === 'stale',
        missing,
        reason,
        message: 'Data incomplete',
        sessionDate,
        infoThrough,
        scoreVersion: SCORE_VERSION,
        liveAdjustment: finite(options.liveAdjustment),
        weights: resolveWeights(),
    };
}

export const SCORE_FORMULA = [
    'MicroSmallBreadth = 0.25*pct(IWM 5D RS) + 0.20*pct(IWM 10D RS) + 0.30*pct(IWC 5D RS) + 0.25*pct(IWC 10D RS)',
    'SpeculativeAppetite = 0.35*pct(XBI 5D RS) + 0.25*pct(XBI 10D RS) + 0.25*pct(ARKK 5D RS) + 0.15*pct(ARKK 10D RS)',
    'BroadMarketRegime starts at 50, then SPY path/volatility bonuses and penalties, clamped 0-100',
    'StressSafety starts at 100, then VIX, US10Y, oil and joint SPY/IWM shock penalties, clamped 0-100',
    'BASE = 0.35*MicroSmall + 0.25*Speculative + 0.15*Broad + 0.25*Stress',
    'Aggressiveness = clamp(BASE - min(18, NarrowLeadership) - MeltUp + LiveAdjustment[-8..+8], 0, 100)',
    'Session D uses closes through the previous NYSE session only. Score version 1 weights are fixed.',
].join('\n');
