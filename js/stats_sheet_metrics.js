import { classifyTradeTypeGroup } from './data_utils.js';
import { isPureGoogleSheetTrade } from './trade_filters.js';
import { pickSheetRowsSource } from './datagrid_rows.js';

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

const ENTRY_PRICE_BUCKETS = [
    { key: 'cents', label: 'Центовка', accepts: (price) => price > 0 && price < 1 },
    { key: '1-3', label: '$1–3', accepts: (price) => price >= 1 && price < 3 },
    { key: '3-5', label: '$3–5', accepts: (price) => price >= 3 && price < 5 },
    { key: '5-10', label: '$5–10', accepts: (price) => price >= 5 && price < 10 },
    { key: '10-20', label: '$10–20', accepts: (price) => price >= 10 && price <= 20 },
    { key: '20+', label: '>$20', accepts: (price) => price > 20 },
];

function parseSheetNumber(value) {
    if (value == null || value === '') return null;
    const cleaned = String(value).trim().replace(/\s/g, '').replace(',', '.').replace(/[^0-9.+-]/g, '');
    if (!cleaned || ['+', '-', '.', '+.', '-.'].includes(cleaned)) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
}

/** Агрегує сирі збережені рядки Google Sheets, навіть якщо вони не зіставлені з Trades. */
export function buildSheetEntryPriceBuckets(sheetRows = {}, options = {}) {
    const source = pickSheetRowsSource(sheetRows, options.preferredSpreadsheetId || '');
    const rowsByDay = source?.byDay || {};
    const dateMatches = typeof options.dateMatches === 'function' ? options.dateMatches : () => true;
    const buckets = ENTRY_PRICE_BUCKETS.map((bucket) => ({ ...bucket, pnl: 0, kf: 0, trades: 0, pnlRows: 0, kfRows: 0 }));

    Object.entries(rowsByDay).forEach(([dateStr, rows]) => {
        if (!dateMatches(dateStr) || !Array.isArray(rows)) return;
        rows.forEach((row) => {
            const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
            const entryPrice = parseSheetNumber(sheet.entryPrice ?? row?.entry);
            if (entryPrice == null) return;
            const bucket = buckets.find((candidate) => candidate.accepts(entryPrice));
            if (!bucket) return;
            const pnl = parseSheetNumber(sheet.sheetNet ?? row?.net);
            const kf = parseSheetProfitRisk(sheet.profitRisk);
            bucket.trades += 1;
            if (pnl != null) { bucket.pnl += pnl; bucket.pnlRows += 1; }
            if (kf != null) { bucket.kf += kf; bucket.kfRows += 1; }
        });
    });

    return buckets.map(({ accepts, ...bucket }) => ({
        ...bucket,
        pnl: Number(bucket.pnl.toFixed(2)),
        kf: Number(bucket.kf.toFixed(2)),
    }));
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
        .sort((a, b) => b.kf - a.kf || b.trades - a.trades || a.criterion.localeCompare(b.criterion, 'uk'));
}
