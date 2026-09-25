import { classifyTradeTypeGroup } from './data_utils.js';

const DEFINITIONS = [
    { key: 'atr', label: 'ATR', ranges: [[0, .3, '<0.3'], [.3, .5, '0.3–0.5'], [.5, .7, '0.5–0.7'], [.7, 1, '0.7–1'], [1, 2, '1–2'], [2, Infinity, '>2']] },
    { key: 'shs_float', label: 'Shs Float', missingLabel: '— (немає даних)', ranges: [[0, 1e6, '<1M'], [1e6, 2e6, '1–2M'], [2e6, 4e6, '2–4M'], [4e6, 10e6, '4–10M'], [10e6, 50e6, '10–50M'], [50e6, 100e6, '50–100M'], [100e6, Infinity, '>100M']] },
    { key: 'avg_vol', label: 'Avg Vol 14', ranges: [[0, .7e6, '<0.7M'], [.7e6, 1.5e6, '0.7–1.5M'], [1.5e6, 3e6, '1.5–3M'], [3e6, 5e6, '3–5M'], [5e6, 10e6, '5–10M'], [10e6, Infinity, '>10M']] },
    { key: 'vol', label: 'Vol попереднього дня', ranges: [[0, .5e6, '<0.5M'], [.5e6, 1e6, '0.5–1M'], [1e6, 3e6, '1–3M'], [3e6, 5e6, '3–5M'], [5e6, Infinity, '>5M']] },
    { key: 'vol_play', label: 'VolPlay', ranges: [[0, 1, '<1x'], [1, 3, '1–3x'], [3, 5, '3–5x'], [5, 10, '5–10x'], [10, Infinity, '>10x']] },
    { key: 'vol_pre_lt1', sourceKey: 'vol_pre', label: 'VolPre · центовки < $1', priceBand: 'lt1', ranges: [[0, 1e6, '<1M'], [1e6, 3e6, '1–3M'], [3e6, 6e6, '3–6M'], [6e6, 10e6, '6–10M'], [10e6, Infinity, '>10M']] },
    { key: 'vol_pre_1_5', sourceKey: 'vol_pre', label: 'VolPre · ціна $1–5', priceBand: '1_5', ranges: [[0, 1e6, '<1M'], [1e6, 3e6, '1–3M'], [3e6, 6e6, '3–6M'], [6e6, 10e6, '6–10M'], [10e6, Infinity, '>10M']] },
    { key: 'vol_pre_5_10', sourceKey: 'vol_pre', label: 'VolPre · ціна $5–10', priceBand: '5_10', ranges: [[0, 1e6, '<1M'], [1e6, 3e6, '1–3M'], [3e6, 6e6, '3–6M'], [6e6, 10e6, '6–10M'], [10e6, Infinity, '>10M']] },
    { key: 'vol_pre_gt10', sourceKey: 'vol_pre', label: 'VolPre · ціна > $10', priceBand: 'gt10', ranges: [[0, 1e6, '<1M'], [1e6, 3e6, '1–3M'], [3e6, 6e6, '3–6M'], [6e6, 10e6, '6–10M'], [10e6, Infinity, '>10M']] },
];

function finite(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function tradeResult(trade) {
    const net = finite(trade?.net);
    if (net !== null) return net;
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    return finite(trade?.gross ?? trade?.grossPnl ?? sheet.gross);
}

function openedMinute(value) {
    const match = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(String(value || ''));
    if (!match) return null;
    const minute = Number(match[1]) * 60 + Number(match[2]);
    return minute >= 0 && minute <= 1439 ? minute : null;
}

function entryPrice(trade) {
    return finite(trade?.entry ?? trade?.entryPrice ?? trade?.sheet?.entryPrice);
}

function priceMatches(price, band) {
    if (price === null) return false;
    if (band === 'lt1') return price < 1;
    if (band === '1_5') return price >= 1 && price < 5;
    if (band === '5_10') return price >= 5 && price <= 10;
    if (band === 'gt10') return price > 10;
    return true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function shiftIsoMonths(iso, months) {
    if (!ISO_DATE.test(iso)) return '';
    const [year, month, day] = iso.split('-').map(Number);
    const cursor = new Date(Date.UTC(year, month - 1 + Number(months), 1));
    const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function clampResearchPeriod(from, to, edited = 'to') {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return { from, to, limited: false, invalid: true };
    let start = from;
    let end = to;
    if (start > end) {
        if (edited === 'from') end = start;
        else start = end;
    }
    const maxEnd = shiftIsoMonths(start, 6);
    if (end > maxEnd) {
        if (edited === 'from') return { from: shiftIsoMonths(end, -6), to: end, limited: true, invalid: false };
        return { from: start, to: maxEnd, limited: true, invalid: false };
    }
    return { from: start, to: end, limited: false, invalid: false };
}

function nextIsoDay(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function sixMonthWindows(from, to) {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return [];
    const windows = [];
    let start = from;
    while (start <= to && windows.length < 40) {
        const end = shiftIsoMonths(start, 6);
        const toDate = end && end < to ? end : to;
        windows.push({ from: start, to: toDate });
        if (toDate >= to) break;
        const next = nextIsoDay(toDate);
        if (!next || next <= start) break;
        start = next;
    }
    return windows;
}

export function journalDatesInRange(journal = {}, from = '', to = '') {
    return new Set(Object.keys(journal || {}).filter((date) => (
        /^\d{4}-\d{2}-\d{2}$/.test(date) && (!from || date >= from) && (!to || date <= to)
    )));
}

export function criteriaBucketEmphasis(bucket = {}) {
    const trades = Number(bucket.trades) || 0;
    if (trades < 3) {
        return { tone: 'watch', label: 'Мало даних', text: 'потрібно щонайменше 3 угоди, акцент не змінювати' };
    }
    const factor = bucket.profitFactor;
    if (bucket.pnl > 0 && (factor === Infinity || factor >= 1.3)) {
        return { tone: 'increase', label: 'Збільшити', text: 'збільшити акцент на цьому діапазоні' };
    }
    if (bucket.pnl < 0) {
        return { tone: 'decrease', label: 'Зменшити', text: 'зменшити акцент на цьому діапазоні' };
    }
    return { tone: 'keep', label: 'Без змін', text: 'результат нейтральний, акцент не змінювати' };
}

export function criteriaFocusSummary(group = {}) {
    const labels = (tone) => (group.buckets || []).filter((bucket) => bucket.emphasis?.tone === tone).map((bucket) => bucket.label);
    const increase = labels('increase');
    const decrease = labels('decrease');
    if (!increase.length && !decrease.length) return 'Стійкого сигналу для зміни акценту ще немає.';
    return [
        increase.length ? `Збільшити: ${increase.join(', ')}` : '',
        decrease.length ? `Зменшити: ${decrease.join(', ')}` : '',
    ].filter(Boolean).join('. ') + '.';
}

function presentNumber(value) {
    if (value === null || value === undefined || value === '') return false;
    return Number.isFinite(Number(value));
}

export function criteriaMetricsReady(metrics, entryMinutes = []) {
    if (!metrics || typeof metrics !== 'object') return false;
    const minutes = Array.isArray(entryMinutes) ? entryMinutes : [...entryMinutes || []];
    const marketReady = ['atr', 'avg_vol', 'vol', 'vol_play'].every((key) => presentNumber(metrics[key]))
        || Boolean(metrics.source_errors?.yahoo);
    if (!marketReady) return false;
    return minutes.every((minute) => presentNumber(metrics.vol_pre_by_minute?.[String(minute)]));
}

export function groupCriteriaPairs(pairs = []) {
    const groups = new Map();
    for (const pair of pairs) {
        const list = groups.get(pair.ticker) || [];
        list.push(pair);
        groups.set(pair.ticker, list);
    }
    return [...groups.entries()].map(([ticker, items]) => ({
        ticker,
        pairs: items.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    }));
}

export function criteriaPairsFromJournal(journal = {}, range = {}) {
    const allowed = journalDatesInRange(journal, range.from || '', range.to || '');
    const pairs = new Map();
    for (const [date, day] of Object.entries(journal || {})) {
        if (!allowed.has(date)) continue;
        for (const trade of Array.isArray(day?.trades) ? day.trades : []) {
            const ticker = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
            if (!ticker) continue;
            const existing = trade?.marketCriteria || day?.tradePolygons?.[ticker];
            const key = `${date}|${ticker}`;
            const entryMinute = openedMinute(trade?.opened || trade?.entryTime || trade?.time);
            if (!pairs.has(key)) pairs.set(key, { date, ticker, existing, trades: 0, entryMinutes: new Set() });
            const pair = pairs.get(key);
            pair.trades += 1;
            if (existing) pair.existing = existing;
            if (Number.isInteger(entryMinute) && entryMinute >= 240 && entryMinute <= 720) pair.entryMinutes.add(entryMinute);
        }
    }
    return [...pairs.values()].map((pair) => {
        const entryMinutes = [...pair.entryMinutes];
        return {
            ...pair,
            entryMinutes,
            loaded: criteriaMetricsReady(pair.existing, entryMinutes),
        };
    });
}

export function criteriaCoverage(journal = {}, range = {}) {
    const pairs = criteriaPairsFromJournal(journal, range);
    const ready = pairs.filter((pair) => pair.loaded).length;
    return {
        trades: pairs.reduce((sum, pair) => sum + (pair.trades || 0), 0),
        pairs: pairs.length,
        ready,
        pending: pairs.filter((pair) => !pair.loaded),
    };
}

export function buildMarketCriteriaGroups(journal = {}, allowedDates = null, tradeType = '') {
    const emptyBucket = (label) => ({ label, trades: 0, pnl: 0, wins: 0, grossProfit: 0, grossLoss: 0 });
    const groups = DEFINITIONS.map((definition) => ({
        ...definition,
        buckets: [
            ...definition.ranges.map(([, , label]) => emptyBucket(label)),
            ...(definition.missingLabel ? [emptyBucket(definition.missingLabel)] : []),
        ],
    }));
    for (const [date, day] of Object.entries(journal || {})) {
        if (allowedDates && !allowedDates.has(date)) continue;
        for (const trade of Array.isArray(day?.trades) ? day.trades : []) {
            const type = classifyTradeTypeGroup(trade);
            if (tradeType && type !== tradeType) continue;
            const pnl = tradeResult(trade);
            const metrics = trade?.marketCriteria || day?.tradePolygons?.[String(trade?.symbol || trade?.ticker || '').toUpperCase()];
            if (pnl === null || !metrics) continue;
            groups.forEach((group) => {
                if (group.priceBand && !priceMatches(entryPrice(trade), group.priceBand)) return;
                const minute = openedMinute(trade?.opened ?? trade?.entryTime ?? trade?.time);
                const rawValue = group.sourceKey === 'vol_pre' ? metrics.vol_pre_by_minute?.[String(minute)] : metrics[group.key];
                const value = finite(rawValue);
                if (value === null && !group.missingLabel) return;
                const index = value === null && group.missingLabel
                    ? group.buckets.length - 1
                    : group.ranges.findIndex(([from, to]) => value >= from && value < to);
                if (index < 0) return;
                const bucket = group.buckets[index];
                bucket.trades += 1;
                bucket.pnl += pnl;
                if (pnl > 0) { bucket.wins += 1; bucket.grossProfit += pnl; }
                if (pnl < 0) bucket.grossLoss += Math.abs(pnl);
            });
        }
    }
    return groups.map((group) => ({
        key: group.key,
        label: group.label,
        buckets: group.buckets.filter((bucket) => bucket.trades).map((bucket) => ({
            ...bucket,
            pnl: Number(bucket.pnl.toFixed(2)),
            winRate: Number((bucket.wins / bucket.trades * 100).toFixed(1)),
            profitFactor: bucket.grossLoss ? Number((bucket.grossProfit / bucket.grossLoss).toFixed(2)) : (bucket.grossProfit ? Infinity : 0),
        })).sort((a, b) => b.pnl - a.pnl).map((bucket) => ({
            ...bucket,
            emphasis: criteriaBucketEmphasis(bucket),
        })),
    })).filter((group) => group.buckets.length);
}
