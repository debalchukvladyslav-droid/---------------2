/**
 * Aggressiveness v2 for mechanical pump-and-dump shorts.
 *
 * Score for session D is fixed from the market close of the previous US
 * trading day. It does not read session D prices, premarket, or session D
 * mechanical results. Mechanical history before D only calibrates quintiles
 * and historical analogs. Confidence is reported separately and is not a
 * multiplier. Version 1 rows stay in the database; this formula inserts
 * score_version 2.
 */

export const SCORE_VERSION = 2;
export const BLOCK_WEIGHTS = Object.freeze({
    smallMicro: 0.30,
    breadth: 0.25,
    speculative: 0.15,
    broadMarket: 0.15,
    macro: 0.15,
});
export const RULE_BLEND = 0.65;
export const ANALOG_BLEND = 0.35;
export const SHRINK_PRIOR_DAYS = 12;
export const MIN_TRAIN_DAYS = 8;
export const SCORE_RELIABILITY_DAYS = 40;
export const MIN_QUINTILE_SPAN = 0.015;
export const ANALOG_MIN = 15;
export const ANALOG_MAX = 25;

export const REQUIRED_SERIES = Object.freeze([
    'SPY', 'QQQ', 'IWM', 'IWC', 'XBI', 'ARKK', 'SMH', 'VIX', 'US10Y', 'OIL',
]);
const CRITICAL_SERIES = new Set(['SPY', 'QQQ', 'IWM', 'VIX']);

export const BREADTH_FIELDS = Object.freeze([
    'nyseAdvancers', 'nyseDecliners',
    'nasdaqAdvancers', 'nasdaqDecliners',
    'nyseUpVolume', 'nyseDownVolume',
    'nasdaqUpVolume', 'nasdaqDownVolume',
    'nyseNewHighs', 'nyseNewLows',
    'nasdaqNewHighs', 'nasdaqNewLows',
]);

export const FEATURES = Object.freeze([
    { key: 'iwmRs1', block: 'smallMicro', label: 'IWM/SPY 1D' },
    { key: 'iwmRs3', block: 'smallMicro', label: 'IWM/SPY 3D' },
    { key: 'iwmRs5', block: 'smallMicro', label: 'IWM/SPY 5D' },
    { key: 'iwmRs10', block: 'smallMicro', label: 'IWM/SPY 10D' },
    { key: 'iwcRs1', block: 'smallMicro', label: 'IWC/SPY 1D' },
    { key: 'iwcRs3', block: 'smallMicro', label: 'IWC/SPY 3D' },
    { key: 'iwcRs5', block: 'smallMicro', label: 'IWC/SPY 5D' },
    { key: 'iwcRs10', block: 'smallMicro', label: 'IWC/SPY 10D' },
    { key: 'nyseDeclinerRatio', block: 'breadth', label: 'NYSE decliners/advancers' },
    { key: 'nasdaqDeclinerRatio', block: 'breadth', label: 'NASDAQ decliners/advancers' },
    { key: 'nyseDownVolumeShare', block: 'breadth', label: 'NYSE down volume share' },
    { key: 'nasdaqDownVolumeShare', block: 'breadth', label: 'NASDAQ down volume share' },
    { key: 'nyseNewLowShare', block: 'breadth', label: 'NYSE new-low share' },
    { key: 'nasdaqNewLowShare', block: 'breadth', label: 'NASDAQ new-low share' },
    { key: 'nyseDeclinerRatio3', block: 'breadth', label: 'NYSE decliner ratio 3D' },
    { key: 'nasdaqDeclinerRatio3', block: 'breadth', label: 'NASDAQ decliner ratio 3D' },
    { key: 'nyseDownVolumeShare3', block: 'breadth', label: 'NYSE down volume 3D' },
    { key: 'nasdaqDownVolumeShare3', block: 'breadth', label: 'NASDAQ down volume 3D' },
    { key: 'nyseNewLowShare3', block: 'breadth', label: 'NYSE new-low share 3D' },
    { key: 'nasdaqNewLowShare3', block: 'breadth', label: 'NASDAQ new-low share 3D' },
    { key: 'xbiRs3', block: 'speculative', label: 'XBI/SPY 3D' },
    { key: 'xbiRs5', block: 'speculative', label: 'XBI/SPY 5D' },
    { key: 'xbiRs10', block: 'speculative', label: 'XBI/SPY 10D' },
    { key: 'arkkRs3', block: 'speculative', label: 'ARKK/SPY 3D' },
    { key: 'arkkRs5', block: 'speculative', label: 'ARKK/SPY 5D' },
    { key: 'arkkRs10', block: 'speculative', label: 'ARKK/SPY 10D' },
    { key: 'spy1d', block: 'broadMarket', label: 'SPY 1D' },
    { key: 'spy3d', block: 'broadMarket', label: 'SPY 3D' },
    { key: 'spy5d', block: 'broadMarket', label: 'SPY 5D' },
    { key: 'spy10d', block: 'broadMarket', label: 'SPY 10D' },
    { key: 'spy20d', block: 'broadMarket', label: 'SPY 20D' },
    { key: 'spyDistance20dHigh', block: 'broadMarket', label: 'SPY distance from 20D high' },
    { key: 'spyRv5', block: 'broadMarket', label: 'SPY realized vol 5D' },
    { key: 'spyRv10', block: 'broadMarket', label: 'SPY realized vol 10D' },
    { key: 'spyAtrPct', block: 'broadMarket', label: 'SPY ATR %' },
    { key: 'qqqRs5', block: 'broadMarket', label: 'QQQ/SPY 5D' },
    { key: 'qqqRs10', block: 'broadMarket', label: 'QQQ/SPY 10D' },
    { key: 'smhRs5', block: 'broadMarket', label: 'SMH/SPY 5D' },
    { key: 'smhRs10', block: 'broadMarket', label: 'SMH/SPY 10D' },
    { key: 'vix', block: 'macro', label: 'VIX' },
    { key: 'vix1d', block: 'macro', label: 'VIX 1D' },
    { key: 'vix3d', block: 'macro', label: 'VIX 3D' },
    { key: 'vix5d', block: 'macro', label: 'VIX 5D' },
    { key: 'us10y', block: 'macro', label: 'US10Y' },
    { key: 'us10y1dBp', block: 'macro', label: 'US10Y 1D bp' },
    { key: 'us10y5dBp', block: 'macro', label: 'US10Y 5D bp' },
    { key: 'us10y10dBp', block: 'macro', label: 'US10Y 10D bp' },
    { key: 'oil1d', block: 'macro', label: 'Oil 1D' },
    { key: 'oil3d', block: 'macro', label: 'Oil 3D' },
    { key: 'oil5d', block: 'macro', label: 'Oil 5D' },
    { key: 'oil10d', block: 'macro', label: 'Oil 10D' },
]);

export const ANALOG_KEYS = Object.freeze([
    'iwmRs5', 'iwmRs10', 'iwcRs5', 'iwcRs10',
    'xbiRs5', 'arkkRs5', 'qqqRs5', 'smhRs5',
    'spy5d', 'spy10d', 'spyRv5',
    'nyseDeclinerRatio', 'nasdaqDeclinerRatio', 'nyseDownVolumeShare', 'nyseNewLowShare',
    'vix', 'vix5d', 'us10y5dBp', 'oil5d',
]);

const US_MARKET_HOLIDAYS = new Set([
    '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
    '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

/** 13:00 ET early closes. The next session is published after 13:15 ET. */
const EARLY_CLOSES = new Set([
    '2024-07-03', '2024-11-29', '2024-12-24',
    '2025-07-03', '2025-11-28', '2025-12-24',
    '2026-11-27', '2026-12-24',
    '2027-11-26', '2027-12-23',
]);

const finite = (value) => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, finite(value) ?? min));
}

export function resolveWeights() {
    return {
        version: SCORE_VERSION,
        blocks: BLOCK_WEIGHTS,
        blend: { rule: RULE_BLEND, analog: ANALOG_BLEND },
        refit: false,
        cadence: 'versioned-formula-only',
    };
}

export function addCalendarDays(isoDate, days) {
    const [year, month, day] = String(isoDate).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

export function isUsMarketHoliday(isoDate) {
    return US_MARKET_HOLIDAYS.has(isoDate);
}

export function isEarlyClose(isoDate) {
    return EARLY_CLOSES.has(isoDate);
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

export function sessionFinalizeMinutes(isoDate) {
    return isEarlyClose(isoDate) ? 13 * 60 + 15 : 16 * 60 + 15;
}

/** Session whose pre-close score belongs on the gauge. After the finalize window, the next session. */
export function displaySessionDate(instant = new Date()) {
    const ny = newYorkParts(instant);
    if (isTradingDay(ny.date) && ny.minutes < sessionFinalizeMinutes(ny.date)) return ny.date;
    if (isTradingDay(ny.date)) return nextTradingDay(ny.date);
    return nextTradingDay(ny.date);
}

export function sessionDataReady(instant = new Date()) {
    const ny = newYorkParts(instant);
    if (!isTradingDay(ny.date)) return true;
    return ny.minutes >= sessionFinalizeMinutes(ny.date);
}

/** One refresh when the close is finalized. The score does not poll during the session. */
export function nextScoreRefreshDelay(instant = new Date()) {
    const ny = newYorkParts(instant);
    if (!isTradingDay(ny.date)) return null;
    const finalize = sessionFinalizeMinutes(ny.date);
    if (ny.minutes >= finalize) return null;
    return Math.max(5000, (finalize - ny.minutes) * 60 * 1000 - ny.second * 1000);
}

export function formatEtClock(instant) {
    if (instant == null || instant === '') return '';
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

export function formatSessionDate(isoDate) {
    const text = String(isoDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    return `${text.slice(8, 10)}.${text.slice(5, 7)}.${text.slice(0, 4)}`;
}

export function aggressivenessStatus(score) {
    const rounded = Math.round(clamp(score, 0, 100));
    if (rounded <= 19) return { score: rounded, label: 'Майже не чіпати', tone: 'minimal' };
    if (rounded <= 39) return { score: rounded, label: 'Обережно', tone: 'cautious' };
    if (rounded <= 59) return { score: rounded, label: 'Звичайний день', tone: 'neutral' };
    if (rounded <= 79) return { score: rounded, label: 'Можна агресивніше', tone: 'aggressive' };
    return { score: rounded, label: 'Найзручніший режим', tone: 'maximal' };
}

export function needlePoint(score, radius = 92, cx = 120, cy = 110) {
    const value = clamp(score, 0, 100);
    const angle = Math.PI * (1 - value / 100);
    return {
        cx: cx + radius * Math.cos(angle),
        cy: cy - radius * Math.sin(angle),
    };
}

export function mechanicalByDateFromSignals(signals = []) {
    const groups = new Map();
    for (const signal of signals || []) {
        const date = signal?.tradingDate;
        const result = finite(signal?.mechanicalResultR);
        if (!date || result == null) continue;
        if (!groups.has(date)) groups.set(date, []);
        groups.get(date).push(result);
    }
    const byDate = {};
    for (const [date, results] of groups) {
        const entries = results.length;
        const totalR = results.reduce((sum, value) => sum + value, 0);
        const winners = results.filter((value) => value > 0);
        const losers = results.filter((value) => value < 0);
        byDate[date] = {
            entries,
            totalR,
            rPerTrade: entries > 0 ? totalR / entries : null,
            wins: winners.length,
            winRate: entries > 0 ? winners.length / entries : null,
            avgWinner: winners.length ? winners.reduce((sum, value) => sum + value, 0) / winners.length : null,
            avgLoser: losers.length ? losers.reduce((sum, value) => sum + value, 0) / losers.length : null,
        };
    }
    return byDate;
}

export function shrinkMean(mean, days, globalMean, prior = SHRINK_PRIOR_DAYS) {
    if (!Number.isFinite(globalMean)) return Number.isFinite(mean) ? mean : null;
    if (!Number.isFinite(mean) || !(days > 0)) return globalMean;
    return (days * mean + prior * globalMean) / (days + prior);
}

function tradeWeighted(samples) {
    let entries = 0;
    let totalR = 0;
    for (const sample of samples) {
        const count = Number(sample.entries) || 0;
        const total = finite(sample.totalR);
        if (!(count > 0) || total == null) continue;
        entries += count;
        totalR += total;
    }
    return entries > 0 ? totalR / entries : null;
}

function quantile(sorted, probability) {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * probability;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function quintileOf(value, breaks) {
    let quintile = 0;
    for (const edge of breaks) if (value > edge) quintile += 1;
    return Math.min(4, quintile);
}

function blendQuintile(values, index) {
    const weights = [0, 0, 0, 0, 0];
    weights[index] = 0.6;
    if (index > 0) weights[index - 1] = 0.2;
    if (index < 4) weights[index + 1] = 0.2;
    const sum = weights.reduce((total, weight) => total + weight, 0);
    return weights.reduce((total, weight, slot) => total + weight * values[slot], 0) / sum;
}

/**
 * Map one feature through quintile expectancy. Direction comes from the
 * samples. A bucket with only a few days is shrunk toward 50.
 */
export function scoreByQuintileExpectancy(samples, current) {
    const usable = (samples || []).filter((sample) => Number.isFinite(sample.value) && sample.entries > 0);
    if (!Number.isFinite(current) || usable.length < MIN_TRAIN_DAYS) {
        return { score: 50, quintile: null, expectancy: null, sample: 0, shrunk: true };
    }
    const globalMean = tradeWeighted(usable);
    const sorted = usable.map((sample) => sample.value).sort((left, right) => left - right);
    const breaks = [0.2, 0.4, 0.6, 0.8].map((probability) => quantile(sorted, probability));
    const buckets = [[], [], [], [], []];
    for (const sample of usable) buckets[quintileOf(sample.value, breaks)].push(sample);
    const expectancies = buckets.map((bucket) => shrinkMean(tradeWeighted(bucket), bucket.length, globalMean));
    const quintile = quintileOf(current, breaks);
    const blended = blendQuintile(expectancies, quintile);
    const finiteExpectancies = expectancies.filter((value) => Number.isFinite(value));
    const span = finiteExpectancies.length ? Math.max(...finiteExpectancies) - Math.min(...finiteExpectancies) : 0;
    const raw = span < MIN_QUINTILE_SPAN
        ? 50
        : clamp(((blended - Math.min(...finiteExpectancies)) / span) * 100, 0, 100);
    const bucketReliability = Math.min(1, buckets[quintile].length / SHRINK_PRIOR_DAYS);
    const historyReliability = Math.min(1, usable.length / SCORE_RELIABILITY_DAYS);
    const score = 50 + (raw - 50) * bucketReliability * historyReliability;
    return {
        score: clamp(score, 0, 100),
        quintile: quintile + 1,
        expectancy: blended,
        sample: buckets[quintile].length,
        shrunk: bucketReliability < 1 || historyReliability < 1,
    };
}

function barsOf(bars) {
    const byDate = new Map();
    for (const bar of bars || []) {
        const close = finite(bar?.close);
        if (!bar?.date || !(close > 0)) continue;
        byDate.set(bar.date, {
            date: bar.date,
            open: finite(bar.open),
            high: finite(bar.high),
            low: finite(bar.low),
            close,
        });
    }
    return [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : 1));
}

function aligned(leftBars, rightBars) {
    const right = new Map(rightBars.map((bar) => [bar.date, bar.close]));
    const dates = [];
    const left = [];
    const rightCloses = [];
    for (const bar of leftBars) {
        if (!right.has(bar.date)) continue;
        dates.push(bar.date);
        left.push(bar.close);
        rightCloses.push(right.get(bar.date));
    }
    return { dates, left, right: rightCloses };
}

function indexOnOrBefore(dates, cutoff) {
    let index = -1;
    for (let cursor = dates.length - 1; cursor >= 0; cursor -= 1) {
        if (dates[cursor] <= cutoff) {
            index = cursor;
            break;
        }
    }
    return index;
}

function windowReturn(closes, index, days) {
    if (index < days) return null;
    const base = closes[index - days];
    if (!(base > 0)) return null;
    return closes[index] / base - 1;
}

function relativeAt(pair, cutoff, days) {
    const index = indexOnOrBefore(pair.dates, cutoff);
    if (index < days) return null;
    const leftBase = pair.left[index - days];
    const rightBase = pair.right[index - days];
    if (!(leftBase > 0) || !(rightBase > 0)) return null;
    return (pair.left[index] / leftBase - 1) - (pair.right[index] / rightBase - 1);
}

function realizedVol(closes, index, days) {
    if (index < days) return null;
    const returns = [];
    for (let cursor = index - days + 1; cursor <= index; cursor += 1) {
        const previous = closes[cursor - 1];
        if (!(previous > 0)) return null;
        returns.push(closes[cursor] / previous - 1);
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
}

function distanceFromHigh(rows, index, days) {
    if (index < days - 1) return null;
    let high = -Infinity;
    for (let cursor = index - days + 1; cursor <= index; cursor += 1) {
        high = Math.max(high, rows[cursor].high ?? rows[cursor].close);
    }
    if (!(high > 0)) return null;
    return rows[index].close / high - 1;
}

function atrPercent(rows, index, period = 14) {
    if (index < period) return null;
    let total = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
        const high = rows[cursor].high ?? rows[cursor].close;
        const low = rows[cursor].low ?? rows[cursor].close;
        const previous = rows[cursor - 1].close;
        total += Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
    }
    const close = rows[index].close;
    return close > 0 ? (total / period) / close : null;
}

function levelChange(closes, index, days, scale = 1) {
    if (index < days) return null;
    return (closes[index] - closes[index - days]) * scale;
}

function ratio(numerator, denominator) {
    if (!Number.isFinite(numerator) || !(denominator > 0)) return null;
    return numerator / denominator;
}

function share(part, other) {
    if (!Number.isFinite(part) || !Number.isFinite(other) || !(part + other > 0)) return null;
    return part / (part + other);
}

function breadthOn(breadthByDate, date) {
    const row = breadthByDate?.[date];
    if (!row || typeof row !== 'object') return null;
    const numeric = {};
    let any = false;
    for (const field of BREADTH_FIELDS) {
        const value = finite(row[field]);
        numeric[field] = value;
        if (value != null) any = true;
    }
    return any ? numeric : null;
}

function meanOf(values) {
    if (values.some((value) => value == null)) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildFeatureRows(barsByKey = {}, breadthByDate = {}) {
    const spy = barsOf(barsByKey.SPY).filter((bar) => isTradingDay(bar.date));
    if (!spy.length) return [];
    const series = {};
    for (const key of REQUIRED_SERIES) {
        series[key] = barsOf(barsByKey[key]).filter((bar) => isTradingDay(bar.date));
    }
    const pairs = {};
    for (const key of ['QQQ', 'IWM', 'IWC', 'XBI', 'ARKK', 'SMH']) {
        pairs[key] = aligned(series[key], spy);
    }
    const own = {};
    for (const key of ['SPY', 'VIX', 'US10Y', 'OIL']) {
        own[key] = {
            dates: series[key].map((bar) => bar.date),
            closes: series[key].map((bar) => bar.close),
            rows: series[key],
        };
    }
    const breadthDates = Object.keys(breadthByDate || {}).filter((date) => isTradingDay(date)).sort();
    const breadthSeries = new Map();
    for (const date of breadthDates) {
        const row = breadthOn(breadthByDate, date);
        if (!row) continue;
        breadthSeries.set(date, {
            nyseDeclinerRatio: ratio(row.nyseDecliners, row.nyseAdvancers),
            nasdaqDeclinerRatio: ratio(row.nasdaqDecliners, row.nasdaqAdvancers),
            nyseDownVolumeShare: share(row.nyseDownVolume, row.nyseUpVolume),
            nasdaqDownVolumeShare: share(row.nasdaqDownVolume, row.nasdaqUpVolume),
            nyseNewLowShare: share(row.nyseNewLows, row.nyseNewHighs),
            nasdaqNewLowShare: share(row.nasdaqNewLows, row.nasdaqNewHighs),
        });
    }
    const rows = [];
    for (let index = 0; index < spy.length; index += 1) {
        const closeDate = spy[index].date;
        const sessionDate = nextTradingDay(closeDate);
        if (previousTradingDay(sessionDate) !== closeDate) continue;
        const spyIndex = indexOnOrBefore(own.SPY.dates, closeDate);
        const vixIndex = indexOnOrBefore(own.VIX.dates, closeDate);
        const yieldIndex = indexOnOrBefore(own.US10Y.dates, closeDate);
        const oilIndex = indexOnOrBefore(own.OIL.dates, closeDate);
        const missing = [];
        if (spyIndex < 0 || own.SPY.dates[spyIndex] !== closeDate) missing.push('SPY');
        for (const key of ['QQQ', 'IWM', 'VIX']) {
            if (!series[key].some((bar) => bar.date === closeDate)) missing.push(key);
        }
        const breadth = breadthSeries.get(closeDate) || null;
        const breadthHistory = breadthDates.filter((date) => date <= closeDate && breadthSeries.has(date));
        const trailingBreadth = (field, days) => {
            const slice = breadthHistory.slice(-days);
            if (slice.length < days) return null;
            return meanOf(slice.map((date) => breadthSeries.get(date)[field]));
        };
        const features = {
            iwmRs1: relativeAt(pairs.IWM, closeDate, 1),
            iwmRs3: relativeAt(pairs.IWM, closeDate, 3),
            iwmRs5: relativeAt(pairs.IWM, closeDate, 5),
            iwmRs10: relativeAt(pairs.IWM, closeDate, 10),
            iwcRs1: relativeAt(pairs.IWC, closeDate, 1),
            iwcRs3: relativeAt(pairs.IWC, closeDate, 3),
            iwcRs5: relativeAt(pairs.IWC, closeDate, 5),
            iwcRs10: relativeAt(pairs.IWC, closeDate, 10),
            xbiRs3: relativeAt(pairs.XBI, closeDate, 3),
            xbiRs5: relativeAt(pairs.XBI, closeDate, 5),
            xbiRs10: relativeAt(pairs.XBI, closeDate, 10),
            arkkRs3: relativeAt(pairs.ARKK, closeDate, 3),
            arkkRs5: relativeAt(pairs.ARKK, closeDate, 5),
            arkkRs10: relativeAt(pairs.ARKK, closeDate, 10),
            qqqRs5: relativeAt(pairs.QQQ, closeDate, 5),
            qqqRs10: relativeAt(pairs.QQQ, closeDate, 10),
            smhRs5: relativeAt(pairs.SMH, closeDate, 5),
            smhRs10: relativeAt(pairs.SMH, closeDate, 10),
            spy1d: windowReturn(own.SPY.closes, spyIndex, 1),
            spy3d: windowReturn(own.SPY.closes, spyIndex, 3),
            spy5d: windowReturn(own.SPY.closes, spyIndex, 5),
            spy10d: windowReturn(own.SPY.closes, spyIndex, 10),
            spy20d: windowReturn(own.SPY.closes, spyIndex, 20),
            spyDistance20dHigh: distanceFromHigh(own.SPY.rows, spyIndex, 20),
            spyRv5: realizedVol(own.SPY.closes, spyIndex, 5),
            spyRv10: realizedVol(own.SPY.closes, spyIndex, 10),
            spyAtrPct: atrPercent(own.SPY.rows, spyIndex, 14),
            vix: vixIndex >= 0 ? own.VIX.closes[vixIndex] : null,
            vix1d: windowReturn(own.VIX.closes, vixIndex, 1),
            vix3d: windowReturn(own.VIX.closes, vixIndex, 3),
            vix5d: windowReturn(own.VIX.closes, vixIndex, 5),
            us10y: yieldIndex >= 0 ? own.US10Y.closes[yieldIndex] : null,
            us10y1dBp: levelChange(own.US10Y.closes, yieldIndex, 1, 100),
            us10y5dBp: levelChange(own.US10Y.closes, yieldIndex, 5, 100),
            us10y10dBp: levelChange(own.US10Y.closes, yieldIndex, 10, 100),
            oil: oilIndex >= 0 ? own.OIL.closes[oilIndex] : null,
            oil1d: windowReturn(own.OIL.closes, oilIndex, 1),
            oil3d: windowReturn(own.OIL.closes, oilIndex, 3),
            oil5d: windowReturn(own.OIL.closes, oilIndex, 5),
            oil10d: windowReturn(own.OIL.closes, oilIndex, 10),
            nyseDeclinerRatio: breadth?.nyseDeclinerRatio ?? null,
            nasdaqDeclinerRatio: breadth?.nasdaqDeclinerRatio ?? null,
            nyseDownVolumeShare: breadth?.nyseDownVolumeShare ?? null,
            nasdaqDownVolumeShare: breadth?.nasdaqDownVolumeShare ?? null,
            nyseNewLowShare: breadth?.nyseNewLowShare ?? null,
            nasdaqNewLowShare: breadth?.nasdaqNewLowShare ?? null,
            nyseDeclinerRatio3: trailingBreadth('nyseDeclinerRatio', 3),
            nasdaqDeclinerRatio3: trailingBreadth('nasdaqDeclinerRatio', 3),
            nyseDownVolumeShare3: trailingBreadth('nyseDownVolumeShare', 3),
            nasdaqDownVolumeShare3: trailingBreadth('nasdaqDownVolumeShare', 3),
            nyseNewLowShare3: trailingBreadth('nyseNewLowShare', 3),
            nasdaqNewLowShare3: trailingBreadth('nasdaqNewLowShare', 3),
        };
        const historyShort = [];
        if (features.spy5d == null) historyShort.push('spy5d');
        if (features.iwmRs5 == null) historyShort.push('iwmRs5');
        if (features.vix == null) historyShort.push('vix');
        rows.push({
            sessionDate,
            infoThrough: closeDate,
            features,
            missing: [...missing, ...historyShort],
            ready: missing.length === 0 && historyShort.length === 0,
            breadthAvailable: Boolean(breadth),
        });
    }
    return rows;
}

function average(values) {
    const finiteValues = values.filter((value) => Number.isFinite(value));
    if (!finiteValues.length) return null;
    return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function zStats(rows, keys) {
    const stats = {};
    for (const key of keys) {
        const values = rows.map((row) => finite(row.features[key])).filter((value) => value != null);
        if (values.length < 8) continue;
        const mean = average(values);
        const variance = average(values.map((value) => (value - mean) ** 2));
        const std = Math.sqrt(variance);
        if (!(std > 1e-8)) continue;
        stats[key] = { mean, std };
    }
    return stats;
}

function analogScoreFor(target, training) {
    const stats = zStats(training, ANALOG_KEYS);
    const keys = Object.keys(stats).filter((key) => finite(target.features[key]) != null);
    if (keys.length < 4 || training.length < 8) {
        return { score: null, expectedR: null, positiveRate: null, sampleSize: 0, analogs: [] };
    }
    const vector = (row) => keys.map((key) => {
        const value = finite(row.features[key]);
        if (value == null) return null;
        return (value - stats[key].mean) / stats[key].std;
    });
    const origin = vector(target);
    if (origin.some((value) => value == null)) {
        return { score: null, expectedR: null, positiveRate: null, sampleSize: 0, analogs: [] };
    }
    const ranked = training.map((row) => {
        const point = vector(row);
        if (point.some((value) => value == null)) return null;
        const distance = Math.sqrt(point.reduce((sum, value, index) => sum + (value - origin[index]) ** 2, 0));
        return { row, distance };
    }).filter(Boolean).sort((left, right) => left.distance - right.distance);
    const count = Math.min(ANALOG_MAX, Math.max(ANALOG_MIN, Math.round(training.length * 0.1)), ranked.length);
    const neighbors = ranked.slice(0, count);
    const scale = median(neighbors.map((item) => item.distance)) || 1;
    const weighted = neighbors.map((item) => ({ ...item, weight: Math.exp(-item.distance / scale) }));
    let weightEntries = 0;
    let weightR = 0;
    let weightDays = 0;
    let positive = 0;
    for (const item of weighted) {
        const mechanical = item.row.mechanical;
        weightEntries += item.weight * mechanical.entries;
        weightR += item.weight * mechanical.totalR;
        weightDays += item.weight;
        if (mechanical.totalR > 0) positive += item.weight;
    }
    const expectedR = weightEntries > 0 ? weightR / weightEntries : null;
    const daily = training.map((row) => row.mechanical.rPerTrade).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    const rank = expectedR == null || !daily.length ? null : daily.filter((value) => value <= expectedR).length / daily.length;
    const reliability = Math.min(1, neighbors.length / ANALOG_MIN);
    const score = rank == null ? null : clamp(50 + (rank * 100 - 50) * reliability, 0, 100);
    return {
        score: neighbors.length < 8 ? null : score,
        expectedR,
        positiveRate: weightDays > 0 ? positive / weightDays : null,
        sampleSize: neighbors.length,
        analogs: weighted.map((item) => ({
            date: item.row.sessionDate,
            distance: item.distance,
            weight: item.weight,
        })),
    };
}

function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trainingRows(featureRows, sessionDate, mechanicalByDate, trainFilter) {
    const rows = [];
    for (const row of featureRows) {
        if (!(row.sessionDate < sessionDate)) continue;
        if (trainFilter && !trainFilter(row.sessionDate)) continue;
        const mechanical = mechanicalByDate?.[row.sessionDate];
        if (!mechanical || !(mechanical.entries > 0) || !Number.isFinite(mechanical.totalR)) continue;
        if (!row.ready) continue;
        rows.push({ ...row, mechanical });
    }
    return rows;
}

function scoreFeatureRow(featureRows, row, mechanicalByDate, options = {}) {
    const infoThrough = row?.infoThrough || previousTradingDay(row?.sessionDate);
    if (!row?.ready) {
        return incomplete(row?.sessionDate, infoThrough, row?.missing || ['SPY'], 'stale');
    }
    const training = trainingRows(featureRows, row.sessionDate, mechanicalByDate, options.trainFilter);
    if (training.length < MIN_TRAIN_DAYS) {
        return incomplete(row.sessionDate, infoThrough, ['mechanical-history'], 'mechanical-history');
    }
    const assignments = {};
    const blockValues = { smallMicro: [], breadth: [], speculative: [], broadMarket: [], macro: [] };
    for (const feature of FEATURES) {
        const current = finite(row.features[feature.key]);
        const samples = training
            .map((sample) => ({ value: finite(sample.features[feature.key]), entries: sample.mechanical.entries, totalR: sample.mechanical.totalR }))
            .filter((sample) => sample.value != null);
        const mapped = scoreByQuintileExpectancy(samples, current);
        assignments[feature.key] = {
            value: current,
            quintile: mapped.quintile,
            expectancy: mapped.expectancy,
            score: current == null ? null : mapped.score,
            sample: mapped.sample,
        };
        if (current != null && mapped.quintile != null) blockValues[feature.block].push(mapped.score);
    }
    const blocks = {};
    const omitted = [];
    for (const [name, values] of Object.entries(blockValues)) {
        blocks[name] = average(values);
        if (blocks[name] == null) omitted.push(name);
    }
    const active = Object.entries(BLOCK_WEIGHTS).filter(([name]) => blocks[name] != null);
    const weightSum = active.reduce((sum, [, weight]) => sum + weight, 0);
    const ruleScore = weightSum > 0
        ? active.reduce((sum, [name, weight]) => sum + weight * blocks[name], 0) / weightSum
        : null;
    if (ruleScore == null) return incomplete(row.sessionDate, infoThrough, omitted, 'features');
    const analog = analogScoreFor(row, training);
    const analogScore = analog.score;
    const finalRaw = analogScore == null ? ruleScore : RULE_BLEND * ruleScore + ANALOG_BLEND * analogScore;
    const status = aggressivenessStatus(finalRaw);
    const priceFeatures = FEATURES.filter((feature) => feature.block !== 'breadth');
    const pricePresent = priceFeatures.filter((feature) => finite(row.features[feature.key]) != null).length;
    let confidence = 100;
    confidence -= (1 - pricePresent / priceFeatures.length) * 30;
    if (!row.breadthAvailable) confidence -= 22;
    if (training.length < SCORE_RELIABILITY_DAYS) confidence -= Math.min(28, Math.round((SCORE_RELIABILITY_DAYS - training.length) * 0.7));
    if (!(analog.sampleSize >= ANALOG_MIN) || analogScore == null) confidence -= 12;
    confidence = clamp(Math.round(confidence), 0, 100);
    const drivers = FEATURES
        .map((feature) => ({ ...feature, ...assignments[feature.key] }))
        .filter((feature) => Number.isFinite(feature.score) && feature.quintile != null)
        .sort((left, right) => Math.abs(right.score - 50) - Math.abs(left.score - 50))
        .slice(0, 4)
        .map((feature) => ({
            key: feature.key,
            label: feature.label,
            quintile: feature.quintile,
            expectancy: feature.expectancy,
            score: feature.score,
        }));
    return {
        complete: true,
        stale: false,
        missing: [],
        coverageGaps: row.breadthAvailable ? [] : [...BREADTH_FIELDS],
        breadthUnavailable: !row.breadthAvailable,
        reason: null,
        message: null,
        sessionDate: row.sessionDate,
        infoThrough,
        scoreVersion: SCORE_VERSION,
        baseScore: ruleScore,
        ruleScore,
        analogScore,
        liveAdjustment: 0,
        liveScore: status.score,
        displayScore: status.score,
        label: status.label,
        tone: status.tone,
        components: {
            smallMicro: blocks.smallMicro,
            breadth: blocks.breadth,
            speculative: blocks.speculative,
            broadMarket: blocks.broadMarket,
            macro: blocks.macro,
            microSmall: blocks.smallMicro,
            broad: blocks.broadMarket,
            stress: blocks.macro,
            analog: analogScore,
            ruleScore,
            narrowPenalty: 0,
            meltUpPenalty: 0,
            liveAdjustment: 0,
        },
        confidence,
        features: row.features,
        assignments,
        analogs: analog.analogs,
        analogExpectedR: analog.expectedR,
        analogPositiveRate: analog.positiveRate,
        analogSampleSize: analog.sampleSize,
        trainDays: training.length,
        weights: resolveWeights(),
        weightsRenormalized: omitted.length > 0,
        omittedBlocks: omitted,
        drivers,
        mechanicalIgnored: true,
    };
}

export function scoreCalendar(barsByKey, mechanicalByDate = {}, dates = [], options = {}) {
    const featureRows = options.featureRows || buildFeatureRows(barsByKey, options.breadthByDate || {});
    const bySession = new Map(featureRows.map((row) => [row.sessionDate, row]));
    return dates.map((sessionDate) => {
        const row = bySession.get(sessionDate);
        if (!row) return incomplete(sessionDate, previousTradingDay(sessionDate), ['SPY'], 'stale');
        return scoreFeatureRow(featureRows, row, mechanicalByDate, options);
    });
}

export function scoreSessionFromBars(barsByKey = {}, sessionDate, options = {}) {
    const featureRows = options.featureRows || buildFeatureRows(barsByKey, options.breadthByDate || {});
    const row = featureRows.find((item) => item.sessionDate === sessionDate);
    if (!row) return incomplete(sessionDate, previousTradingDay(sessionDate), ['SPY'], 'stale');
    return scoreFeatureRow(featureRows, row, options.mechanicalByDate || {}, options);
}

export function recentAggressiveness(barsByKey, sessionDate, count = 30, options = {}) {
    const dates = [];
    let cursor = sessionDate;
    for (let guard = 0; dates.length < count && guard < count + 16; guard += 1) {
        if (isTradingDay(cursor)) dates.push(cursor);
        const prior = previousTradingDay(cursor);
        if (!prior || prior >= cursor) break;
        cursor = prior;
    }
    return scoreCalendar(barsByKey, options.mechanicalByDate || {}, dates.reverse(), options).map((day) => ({
        date: day.sessionDate,
        score: day.complete ? day.displayScore : null,
        label: day.label || null,
        infoThrough: day.infoThrough,
        ruleScore: day.complete ? day.ruleScore : null,
        analogScore: day.complete ? day.analogScore : null,
        mechanicalRPerTrade: options.mechanicalByDate?.[day.sessionDate]?.rPerTrade ?? null,
    }));
}

function incomplete(sessionDate, infoThrough, missing, reason = 'stale') {
    return {
        complete: false,
        stale: reason === 'stale',
        missing,
        coverageGaps: reason === 'stale' ? [] : [...BREADTH_FIELDS],
        breadthUnavailable: true,
        reason,
        message: 'Data incomplete',
        sessionDate,
        infoThrough,
        scoreVersion: SCORE_VERSION,
        liveAdjustment: 0,
        displayScore: null,
        confidence: null,
        weights: resolveWeights(),
        analogs: [],
    };
}

export const SCORE_FORMULA = [
    'Information cutoff for session D is the previous US trading close. Features, quintiles, and analogs cannot see session D.',
    'Each feature is scored from quintiles of its history before D. Quintile expectancy is trade-weighted mechanical R/trade, shrunk toward the global mean with a 12-day prior. Buckets smaller than 12 days and histories shorter than 40 days are pulled toward 50. Direction is not assumed.',
    'SmallMicro 30%, Breadth 25%, Speculative 15%, BroadMarket 15%, MacroVolatility 15%. These V2 starting weights are not fitted. A missing block is omitted and the remaining weights are renormalized; confidence records the gap.',
    'RuleScore = weighted block average.',
    'HistoricalAnalogScore = similarity-weighted mechanical R/trade of the 15-25 nearest earlier states, mapped to the empirical percentile of past daily R/trade. Neighbors must be earlier than D.',
    'Aggressiveness = clamp(0.65 * RuleScore + 0.35 * AnalogScore, 0, 100). If the analog sample is too small, the published number is RuleScore and confidence falls. UI rounds to an integer.',
    'Confidence is coverage, history length, mechanical sample, analog sample, and breadth availability. It does not multiply the score.',
    'score_version = 2. Version 1 rows are not rewritten.',
].join('\n');
