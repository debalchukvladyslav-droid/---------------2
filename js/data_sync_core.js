export const cloneData = value => value === undefined ? undefined : structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsafeKey = key => ['__proto__', 'prototype', 'constructor'].includes(key);

export function sameData(a, b) {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
        && a.length === b.length && a.every((value, index) => sameData(value, b[index]));
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a).filter(key => a[key] !== undefined);
    return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
        && keys.every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}

// RFC 7396: arrays are atomic, null removes an object property.
export function mergePatch(base = {}, next = {}) {
    if (!object(next)) return cloneData(next);
    const before = object(base) ? base : {};
    const patch = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
        if (unsafeKey(key)) continue;
        if (!Object.hasOwn(next, key) || next[key] === undefined) {
            if (Object.hasOwn(before, key)) patch[key] = null;
        } else if (!sameData(before[key], next[key])) {
            patch[key] = object(next[key]) ? mergePatch(before[key], next[key]) : cloneData(next[key]);
        }
    }
    return patch;
}

export const HEAVY_SETTINGS_KEYS = [
    'tickers', 'screenMeta', 'sheetRows', 'cumulativeSheetRows', 'unassignedImages',
    'aiChatHistory', 'aiSavedChats', 'weeklyComments', 'monthlyDayloss',
];

export function collectionEmpty(value) {
    if (value == null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

export function withoutUnloadedWipes(base, patch) {
    if (!object(patch)) return patch;
    const next = { ...patch };
    for (const key of HEAVY_SETTINGS_KEYS) {
        if (!Object.hasOwn(next, key)) continue;
        const merged = applyMergePatch(base?.[key], next[key]);
        if (!collectionEmpty(base?.[key]) && collectionEmpty(merged)) delete next[key];
    }
    return next;
}

export function applyMergePatch(base, patch) {
    if (!object(patch)) return cloneData(patch);
    const result = object(base) ? cloneData(base) : {};
    for (const [key, value] of Object.entries(patch)) {
        if (unsafeKey(key)) continue;
        if (value === null) delete result[key];
        else result[key] = applyMergePatch(result[key], value);
    }
    return result;
}

export function canonicalJournalRow(row = {}) {
    const result = cloneData(row);
    for (const key of ['id', 'user_id', 'trade_date', 'created_at', 'updated_at', 'sync_version', '__detailsLoaded']) delete result[key];
    return result;
}

export function ensureTradeIds(trades, createId = () => globalThis.crypto.randomUUID()) {
    if (!Array.isArray(trades)) return [];
    return trades.map(trade => {
        if (!trade || typeof trade !== 'object') return { id: createId() };
        if (trade.id) return trade;
        return { ...trade, id: createId() };
    });
}

export function journalRowKeepingTrades(incoming = {}, existing = {}) {
    const next = cloneData(incoming) || {};
    const incomingTrades = next?.daily_metrics?.trades;
    const existingTrades = existing?.daily_metrics?.trades;
    if ((!Array.isArray(incomingTrades) || incomingTrades.length === 0) && Array.isArray(existingTrades) && existingTrades.length > 0) {
        next.daily_metrics = { ...(next.daily_metrics || {}), trades: cloneData(existingTrades) };
    }
    return next;
}

export function journalWithoutTrades(row = {}) {
    const next = cloneData(row) || {};
    if (next.daily_metrics && typeof next.daily_metrics === 'object') delete next.daily_metrics.trades;
    return next;
}

export function journalTradesNeedProjection(beforeTrades = []) {
    return (beforeTrades || []).some(trade => trade && typeof trade === 'object' && !trade.id);
}

function tradeWire(trade = {}) {
    const next = cloneData(trade) || {};
    delete next.version;
    return next;
}

export function tradeChangeOperations(date, beforeTrades = [], nextTrades = []) {
    const before = new Map();
    for (const trade of beforeTrades || []) if (trade?.id) before.set(String(trade.id), trade);
    const next = new Map();
    for (const trade of nextTrades || []) if (trade?.id) next.set(String(trade.id), trade);
    const operations = [];
    for (const [id, trade] of next) {
        const previous = before.get(id);
        const patch = mergePatch(previous ? tradeWire(previous) : {}, tradeWire(trade));
        if (previous && !Object.keys(patch).length) continue;
        operations.push({
            domain: 'trade',
            entityId: `${date}:${id}`,
            baseVersion: Number(previous?.version) || 0,
            base: previous ? tradeWire(previous) : {},
            patch,
        });
    }
    for (const [id, trade] of before) {
        if (next.has(id)) continue;
        operations.push({
            domain: 'trade',
            entityId: `${date}:${id}`,
            baseVersion: Number(trade.version) || 0,
            base: tradeWire(trade),
            patch: { deleted: true },
        });
    }
    return operations;
}

export function tradeFromServerRow(row = {}) {
    if (!row || typeof row !== 'object') return null;
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : row;
    const trade = { ...payload, id: row.id || payload.id, version: row.version || payload.version || 1, trade_date: row.trade_date || payload.trade_date };
    if (!trade.symbol && !trade.ticker && row.ticker) trade.symbol = row.ticker;
    return trade;
}

export function mergeTradeRows(rows = [], trades = []) {
    if (!Array.isArray(trades) || !trades.length) return rows;
    const byDate = new Map();
    for (const row of trades) {
        if (!row || row.deleted_at) continue;
        const date = String(row.trade_date || row.payload?.trade_date || '');
        const trade = tradeFromServerRow(row);
        if (!date || !trade?.id) continue;
        const list = byDate.get(date) || [];
        list.push(trade);
        byDate.set(date, list);
    }
    if (!byDate.size) return rows;
    return (rows || []).map(row => {
        const list = byDate.get(String(row?.trade_date || ''));
        if (!list) return row;
        return { ...row, daily_metrics: { ...(row?.daily_metrics || {}), trades: list } };
    });
}

export function journalDaysWithTradeRows(days = [], trades = []) {
    const merged = mergeTradeRows(days, trades);
    const known = new Set(merged.map((row) => String(row?.trade_date || '')));
    const orphans = new Map();
    for (const row of trades || []) {
        if (!row || row.deleted_at) continue;
        const date = String(row.trade_date || row.payload?.trade_date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || known.has(date)) continue;
        const list = orphans.get(date) || [];
        list.push(row);
        orphans.set(date, list);
    }
    for (const [date, list] of orphans) {
        merged.push(...mergeTradeRows([{ trade_date: date, daily_metrics: {} }], list));
    }
    return merged;
}
export const syncError = (message, code = 'SYNC_FAILED', detail = {}) => Object.assign(new Error(message), { code, ...detail });
export const retryDelay = (attempt = 0, random = Math.random) => Math.round(Math.min(60000, 1000 * (2 ** Math.min(attempt, 6))) * (0.75 + random() * 0.5));
export function isRetryableSyncError(error) {
    const status = Number(error?.status || 0);
    return !['PGRST202', '42883', '42501', 'SYNC_SCHEMA_REQUIRED', 'SYNC_CONFLICT', 'STALE_EPOCH', '22023', '23514'].includes(String(error?.code || ''))
        && status !== 401 && status !== 403 && !(status >= 400 && status < 429 && status !== 408);
}
