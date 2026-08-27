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

export function combineStatsSheetRows(mainRows = {}, cumulativeRows = {}) {
    const combined = {};
    const addStore = (store, kind) => {
        if (!store || typeof store !== 'object') return;
        Object.entries(store).forEach(([sourceId, byDay]) => {
            if (!byDay || typeof byDay !== 'object') return;
            combined[`${kind}:${sourceId}`] = byDay;
        });
    };
    addStore(mainRows, 'main');
    addStore(cumulativeRows, 'cumulative');
    return combined;
}

function sheetRowSources(sheetRows = {}, preferredSpreadsheetId = '') {
    const store = sheetRows && typeof sheetRows === 'object' ? sheetRows : {};
    const ids = Object.keys(store).filter((id) => store[id] && typeof store[id] === 'object');
    if (preferredSpreadsheetId && ids.includes(preferredSpreadsheetId)) {
        ids.splice(ids.indexOf(preferredSpreadsheetId), 1);
        ids.unshift(preferredSpreadsheetId);
    }
    return ids.map((spreadsheetId) => ({ spreadsheetId, byDay: store[spreadsheetId] }));
}

function visitSheetRows(sheetRows, options, visitor) {
    const seen = new Set();
    sheetRowSources(sheetRows, options.preferredSpreadsheetId || '').forEach(({ spreadsheetId, byDay }) => {
        Object.entries(byDay).forEach(([dateStr, rows]) => {
            if (!Array.isArray(rows)) return;
            rows.forEach((row, index) => {
                const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
                const rowNumber = sheet.sheetRow ?? index;
                const key = `${spreadsheetId}:${dateStr}:${rowNumber}`;
                if (seen.has(key)) return;
                seen.add(key);
                visitor(row, sheet, dateStr, spreadsheetId);
            });
        });
    });
    return seen.size;
}

export function buildCalendarWeekdayPnl(entries = [], tradeTypeFilter = null) {
    const totals = [0, 0, 0, 0, 0];
    entries.forEach((entry) => {
        const day = entry?.dateObj instanceof Date ? entry.dateObj.getDay() : new Date(`${entry?.dateStr}T12:00:00`).getDay();
        const pnl = Number(entry?.pnl);
        if (day >= 1 && day <= 5 && Number.isFinite(pnl)) totals[day - 1] += pnl;
    });
    return totals.map(value => Number(value.toFixed(2)));
}

/** Агрегує сирі збережені рядки Google Sheets, навіть якщо вони не зіставлені з Trades. */
export function buildSheetEntryPriceBuckets(sheetRows = {}, options = {}) {
    const dateMatches = typeof options.dateMatches === 'function' ? options.dateMatches : () => true;
    const buckets = ENTRY_PRICE_BUCKETS.map((bucket) => ({ ...bucket, pnl: 0, kf: 0, trades: 0, pnlRows: 0, kfRows: 0 }));

    const rawRowCount = visitSheetRows(sheetRows, options, (row, sheet, dateStr) => {
            if (!dateMatches(dateStr)) return;
            if (options.tradeTypeFilter && classifyTradeTypeGroup(row) !== options.tradeTypeFilter) return;
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

    if (!rawRowCount && Array.isArray(options.entries)) {
        const seen = new Set();
        iterMatchedSheetTrades(options.entries, options.tradeTypeFilter || null, (trade, sheet, kf, entry) => {
            const entryPrice = parseSheetNumber(sheet.entryPrice ?? trade?.entry);
            const bucket = buckets.find((candidate) => candidate.accepts(entryPrice));
            if (!bucket) return;
            const rowKey = sheet.sheetRow != null
                ? `${entry?.dateStr || ''}:${sheet.spreadsheetId || ''}:${sheet.sheetRow}`
                : `${entry?.dateStr || ''}:${trade?.symbol || ''}:${trade?.opened || ''}:${kf}`;
            if (seen.has(rowKey)) return;
            seen.add(rowKey);
            const pnl = parseSheetNumber(sheet.sheetNet);
            bucket.trades += 1;
            if (pnl != null) { bucket.pnl += pnl; bucket.pnlRows += 1; }
            bucket.kf += kf;
            bucket.kfRows += 1;
        });
    }

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

export function buildHourlyKfBuckets(entries = [], tradeTypeFilter = null, options = {}) {
    const hours = Array.from({ length: 6 }, (_, index) => index + 4);
    const buckets = new Map(hours.map(hour => [hour, { hour, pnl: 0, kf: 0, trades: 0, pnlRows: 0, kfRows: 0 }]));
    const entriesByDate = new Map(entries.map((entry) => [entry?.dateStr, entry]));
    const usedTradeIndexesByDate = new Map();
    let usedRawSheetRows = false;

    visitSheetRows(options.sheetRows || {}, options, (row, sheet, dateStr) => {
            if (!entriesByDate.has(dateStr)) return;
            const entry = entriesByDate.get(dateStr);
            const trades = Array.isArray(entry?.data?.trades) ? entry.data.trades : [];
                const rowSymbol = String(row?.symbol || row?.ticker || sheet?.symbol || sheet?.ticker || '').trim().toUpperCase();
                const usedIndexes = usedTradeIndexesByDate.get(dateStr) || new Set();
                let matchIndex = Number(sheet.matchedTradeIndex);
                const indexedTrade = Number.isInteger(matchIndex) && matchIndex >= 0 && matchIndex < trades.length ? trades[matchIndex] : null;
                const indexedSymbol = String(indexedTrade?.symbol || indexedTrade?.ticker || '').trim().toUpperCase();
                if (!indexedTrade || usedIndexes.has(matchIndex) || (rowSymbol && indexedSymbol !== rowSymbol)) {
                    const candidates = trades
                        .map((trade, index) => ({ trade, index }))
                        .filter(({ trade, index }) => {
                            if (usedIndexes.has(index) || isPureGoogleSheetTrade(trade)) return false;
                            const tradeSymbol = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
                            return rowSymbol && tradeSymbol === rowSymbol;
                        });
                    const sheetPnl = parseSheetNumber(sheet.sheetNet ?? row?.net);
                    candidates.sort((a, b) => {
                        if (sheetPnl == null) return a.index - b.index;
                        const aPnl = parseSheetNumber(a.trade?.net ?? a.trade?.gross_pnl ?? a.trade?.gross);
                        const bPnl = parseSheetNumber(b.trade?.net ?? b.trade?.gross_pnl ?? b.trade?.gross);
                        const aDistance = aPnl == null ? Number.POSITIVE_INFINITY : Math.abs(aPnl - sheetPnl);
                        const bDistance = bPnl == null ? Number.POSITIVE_INFINITY : Math.abs(bPnl - sheetPnl);
                        return aDistance - bDistance || a.index - b.index;
                    });
                    matchIndex = candidates[0]?.index;
                }
                if (!Number.isInteger(matchIndex)) return;
                const matchedTrade = trades[matchIndex];
                if (!matchedTrade || isPureGoogleSheetTrade(matchedTrade)) return;
                if (tradeTypeFilter && classifyTradeTypeGroup(matchedTrade) !== tradeTypeFilter) return;
                const kf = parseSheetProfitRisk(sheet.profitRisk);
                const hour = parseTradeOpenHour(matchedTrade.opened);
                if (!buckets.has(hour)) return;
                const pnl = parseSheetNumber(sheet.sheetNet ?? row?.net);
                if (kf == null && pnl == null) return;
                const bucket = buckets.get(hour);
                if (kf != null) { bucket.kf += kf; bucket.kfRows += 1; }
                if (pnl != null) { bucket.pnl += pnl; bucket.pnlRows += 1; }
                bucket.trades += 1;
                usedIndexes.add(matchIndex);
                usedTradeIndexesByDate.set(dateStr, usedIndexes);
                usedRawSheetRows = true;
    });

    if (!usedRawSheetRows) {
        const seen = new Set();
        iterMatchedSheetTrades(entries, tradeTypeFilter, (trade, sheet, kf, entry) => {
            const hour = parseTradeOpenHour(trade?.opened);
            if (!buckets.has(hour)) return;
            const rowKey = sheet.sheetRow != null
                ? `${entry?.dateStr || ''}:${sheet.spreadsheetId || ''}:${sheet.sheetRow}`
                : `${entry?.dateStr || ''}:${trade?.symbol || ''}:${trade?.opened || ''}:${kf}`;
            if (seen.has(rowKey)) return;
            seen.add(rowKey);
            const bucket = buckets.get(hour);
            const pnl = parseSheetNumber(sheet.sheetNet);
            bucket.kf += kf;
            bucket.kfRows += 1;
            if (pnl != null) { bucket.pnl += pnl; bucket.pnlRows += 1; }
            bucket.trades += 1;
        });
    }

    return hours
        .filter(hour => hour >= 6 || buckets.get(hour).trades > 0)
        .map(hour => ({
            ...buckets.get(hour),
            label: String(hour).padStart(2, '0'),
            pnl: parseFloat(buckets.get(hour).pnl.toFixed(2)),
            kf: parseFloat(buckets.get(hour).kf.toFixed(2)),
        }));
}

function criterionValues(sheet = {}) {
    const rawValues = [];
    if (Array.isArray(sheet.exceptions)) rawValues.push(...sheet.exceptions);
    else if (sheet.exceptions != null) rawValues.push(sheet.exceptions);
    if (sheet.exception != null) rawValues.push(sheet.exception);
    const values = [...new Set(rawValues
        .flatMap((value) => String(value || '').split(/[;,]/))
        .map((value) => value.trim())
        .filter(Boolean))];
    const combinable = values.filter((value) => value !== '-');
    if (combinable.length > 1) values.push(combinable.join('; '));
    return [...new Set(values)];
}

export function buildExceptionKfRows(entries = [], tradeTypeFilter = null, options = {}) {
    const buckets = new Map();
    const dateMatches = typeof options.dateMatches === 'function' ? options.dateMatches : () => true;

    visitSheetRows(options.sheetRows || {}, options, (row, sheet, dateStr) => {
                if (!dateMatches(dateStr)) return;
                if (tradeTypeFilter && classifyTradeTypeGroup(row) !== tradeTypeFilter) return;
                const kf = parseSheetProfitRisk(sheet.profitRisk);
                const criteria = criterionValues(sheet);
                // Isolated BR-style structure: criterion and R come from this
                // same raw Sheet row. Journal, Trades and PnL are not involved.
                if (!criteria.length || kf == null) return;
                criteria.forEach((criterion) => {
                    if (!buckets.has(criterion)) buckets.set(criterion, { criterion, pnl: 0, kf: 0, trades: 0, pnlRows: 0, kfRows: 0 });
                    const bucket = buckets.get(criterion);
                    bucket.kf += kf;
                    bucket.kfRows += 1;
                    bucket.trades += 1;
                });
    });

    return [...buckets.values()]
        .map((row) => ({
            ...row,
            pnl: parseFloat(row.pnl.toFixed(2)),
            kf: parseFloat(row.kf.toFixed(2)),
            avgKf: row.kfRows ? parseFloat((row.kf / row.kfRows).toFixed(2)) : 0,
        }))
        .sort((a, b) => b.kf - a.kf || b.trades - a.trades || a.criterion.localeCompare(b.criterion, 'uk'));
}
