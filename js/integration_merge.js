import { findSheetMatchIndex, isValidIsoDateString } from './sheet_sync_core.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = value => value === undefined || value === null || value === '';

// A source may change a value only while the value still equals its last
// imported value. Existing data without provenance belongs to the site.
export function mergeSourceFields(current = {}, incoming = {}, previous = {}) {
    const value = clone(current);
    for (const [key, next] of Object.entries(incoming)) {
        if (next === undefined) continue;
        if (empty(current[key]) || (Object.hasOwn(previous, key) && same(current[key], previous[key]))) value[key] = clone(next);
    }
    return value;
}

export function mergeSiteAuthoritativeSheetRows(journal = {}, outByDay = {}, spreadsheetId = '', options = {}) {
    const touchedDates = [];
    let importedSheetRows = 0;
    let matchedSheetRows = 0;
    const sourceKey = `google:${spreadsheetId}:${options.sheetTitle || ''}`;
    const storedRows = {};
    for (const [date, incoming] of Object.entries(outByDay)) {
        if (!isValidIsoDateString(date) || !Array.isArray(incoming)) continue;
        importedSheetRows += incoming.length;
        storedRows[date] = clone(incoming);
        const day = journal[date];
        if (!day || !Array.isArray(day.trades)) continue;
        const before = JSON.stringify(day);
        const used = new Set();
        for (const trade of incoming) {
            const index = findSheetMatchIndex(day.trades, trade, used);
            if (index < 0) continue;
            used.add(index);
            const existing = day.trades[index];
            const prior = existing._sourceFields?.[sourceKey] || {};
            const fields = { entry: trade.entry, exit: trade.exit, qty: trade.qty, stop: trade.stop };
            const merged = mergeSourceFields(existing, fields, prior.fields);
            merged.sheet = mergeSourceFields(existing.sheet || {}, trade.sheet || {}, prior.sheet);
            merged.sheet.matchedBy = 'date+ticker+pnl';
            merged._sourceFields = { ...(existing._sourceFields || {}), [sourceKey]: { fields: clone(fields), sheet: clone(trade.sheet || {}) } };
            day.trades[index] = merged;
            matchedSheetRows++;
        }
        if (JSON.stringify(day) !== before) {
            touchedDates.push(date);
            options.markTouched?.(date, day);
        }
    }
    if (options.sheetRowsStore && spreadsheetId) {
        // Source rows are an import archive. Missing rows never erase journal data.
        options.sheetRowsStore[spreadsheetId] = { ...(options.sheetRowsStore[spreadsheetId] || {}), ...storedRows };
    }
    return { touchedDates, deletedDates: [], importedSheetRows, matchedSheetRows, skippedSheetRows: importedSheetRows - matchedSheetRows, syncedPnlDates: [] };
}

const BROKER_FIELDS = ['symbol', 'type', 'opened', 'closed', 'held', 'entry', 'exit', 'qty', 'gross', 'comm', 'net'];
function brokerIdentity(trade) {
    if (trade.brokerTradeId || trade.executionId) return `id:${trade.brokerTradeId || trade.executionId}`;
    return [String(trade.symbol || '').trim().toUpperCase(), String(trade.opened || '').trim(), String(trade.closed || '').trim()].join('|');
}

export function mergeBrokerTrades(existing = [], incoming = [], { source = 'fondexx', date = '' } = {}) {
    const result = clone(existing);
    const buckets = new Map();
    result.forEach((trade, index) => {
        const key = brokerIdentity(trade);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(index);
    });
    const occurrences = new Map();
    for (const trade of incoming) {
        const key = brokerIdentity(trade);
        const occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        const index = buckets.get(key)?.[occurrence];
        const fields = Object.fromEntries(BROKER_FIELDS.filter(field => trade[field] !== undefined).map(field => [field, trade[field]]));
        const previous = index === undefined ? {} : result[index];
        const merged = mergeSourceFields(previous, fields, previous._sourceFields?.[source] || {});
        merged.id ||= `import:${source}:${date}:${encodeURIComponent(key)}:${occurrence}`;
        merged._sourceFields = { ...(previous._sourceFields || {}), [source]: clone(fields) };
        // Preserve sheet context returned by the existing matching adapter.
        if (!merged.sheet && trade.sheet) merged.sheet = clone(trade.sheet);
        if (index === undefined) result.push(merged);
        else result[index] = merged;
    }
    return result;
}

export function canonicalJournalRow(row) {
    const { id, user_id, trade_date, created_at, updated_at, sync_version, ...value } = row;
    return value;
}

export function journalRowToIntegrationDay(row) {
    return { ...(clone(row.daily_metrics) || {}), ...Object.fromEntries(['pnl', 'gross_pnl', 'commissions', 'locates', 'kf', 'notes', 'mentor_comment', 'ai_advice'].map(key => [key, row[key]])) };
}

export function integrationDayToJournalRow(original, day) {
    // Keep original metadata and columns byte-for-byte except source-owned trades.
    return { ...clone(original), daily_metrics: { ...clone(original.daily_metrics || {}), trades: clone(day.trades || []) } };
}
