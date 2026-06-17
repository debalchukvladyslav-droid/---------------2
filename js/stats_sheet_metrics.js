import { classifyTradeTypeGroup } from './data_utils.js';
import { isPureGoogleSheetTrade } from './trade_filters.js';

export function parseSheetProfitRisk(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const cleaned = raw
        .replace(/\s/g, '')
        .replace(',', '.')
        .replace(/[RrКкФф]+$/g, '')
        .replace(/[^0-9.+-]/g, '');
    if (!cleaned || cleaned === '+' || cleaned === '-' || cleaned === '.' || cleaned === '+.' || cleaned === '-.') return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
}

export function parseTradeOpenHour(opened) {
    const match = /\b(\d{1,2}):\d{2}(?::\d{2})?\b/.exec(String(opened || ''));
    if (!match) return null;
    const hour = Number(match[1]);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function iterMatchedSheetTrades(entries = [], tradeTypeFilter = null, visitor = () => {}) {
    entries.forEach((entry) => {
        const trades = Array.isArray(entry?.data?.trades) ? entry.data.trades : [];
        trades.forEach((trade) => {
            if (isPureGoogleSheetTrade(trade)) return;
            if (tradeTypeFilter && classifyTradeTypeGroup(trade) !== tradeTypeFilter) return;
            const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
            const kf = parseSheetProfitRisk(sheet.profitRisk);
            if (kf == null) return;
            visitor(trade, sheet, kf, entry);
        });
    });
}

export function buildHourlyKfBuckets(entries = [], tradeTypeFilter = null) {
    const buckets = new Map([4, 5, 6, 7, 8, 9].map(hour => [hour, { hour, kf: 0, trades: 0 }]));

    iterMatchedSheetTrades(entries, tradeTypeFilter, (trade, _sheet, kf) => {
        const hour = parseTradeOpenHour(trade?.opened);
        if (!buckets.has(hour)) return;
        const bucket = buckets.get(hour);
        bucket.kf += kf;
        bucket.trades += 1;
    });

    return [4, 5, 6, 7, 8, 9]
        .filter(hour => hour >= 6 || buckets.get(hour).trades > 0)
        .map(hour => ({
            ...buckets.get(hour),
            label: String(hour).padStart(2, '0'),
            pnl: parseFloat(buckets.get(hour).kf.toFixed(2)),
        }));
}

function criterionValues(sheet = {}) {
    const values = [];
    if (Array.isArray(sheet.exceptions)) values.push(...sheet.exceptions);
    else if (sheet.exceptions != null) values.push(sheet.exceptions);
    if (sheet.exception != null) values.push(sheet.exception);
    return [...new Set(values
        .flatMap((value) => String(value || '').split(/[;,]/))
        .map((value) => value.trim())
        .filter(Boolean))];
}

export function buildExceptionKfRows(entries = [], tradeTypeFilter = null) {
    const buckets = new Map();

    iterMatchedSheetTrades(entries, tradeTypeFilter, (_trade, sheet, kf) => {
        criterionValues(sheet).forEach((criterion) => {
            if (!buckets.has(criterion)) buckets.set(criterion, { criterion, kf: 0, trades: 0 });
            const bucket = buckets.get(criterion);
            bucket.kf += kf;
            bucket.trades += 1;
        });
    });

    return [...buckets.values()]
        .map((row) => ({
            ...row,
            kf: parseFloat(row.kf.toFixed(2)),
            avgKf: row.trades ? parseFloat((row.kf / row.trades).toFixed(2)) : 0,
        }))
        .sort((a, b) => a.kf - b.kf || b.trades - a.trades || a.criterion.localeCompare(b.criterion, 'uk'));
}
