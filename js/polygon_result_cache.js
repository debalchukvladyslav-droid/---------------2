const STORAGE_KEY = 'traderjournal:polygon-results:v1';
const TIME_PRICE_STORAGE_KEY = 'traderjournal:polygon-time-prices:v1';
const MAX_ROWS = 5000;
let memoryStore = null;
let timePriceMemoryStore = null;

function resultKey(value = {}) {
    const symbol = String(value.symbol || '').trim().toUpperCase();
    const date = String(value.date || '');
    const entryMinute = Number(value.entryMinute);
    if (!/^[A-Z]{1,10}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(entryMinute)) return '';
    return `${symbol}|${date}|${entryMinute}`;
}

function readStore() {
    if (memoryStore) return memoryStore;
    try {
        const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
        memoryStore = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        memoryStore = {};
    }
    return memoryStore;
}

export function readPolygonResult(value = {}) {
    const key = resultKey(value);
    if (!key) return null;
    const row = readStore()[key];
    return row && Number(row.low) > 0 ? row : null;
}

export function writePolygonResults(rows = []) {
    if (!Array.isArray(rows) || !rows.length) return;
    try {
        const store = readStore();
        const now = Date.now();
        rows.forEach((row) => {
            const key = resultKey(row);
            if (!key || !(Number(row.low) > 0)) return;
            store[key] = {
                symbol: String(row.symbol).trim().toUpperCase(),
                date: String(row.date),
                entryMinute: Number(row.entryMinute),
                low: Number(row.low),
                lowTime: String(row.lowTime || ''),
                savedAt: now,
            };
        });
        const compact = Object.fromEntries(Object.entries(store)
            .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
            .slice(0, MAX_ROWS));
        memoryStore = compact;
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(compact));
    } catch (_) {
        // Supabase remains the authoritative cache when local storage is unavailable.
    }
}

export function polygonResultCacheKey(value = {}) {
    return resultKey(value);
}

function timePriceKey(value = {}) {
    const symbol = String(value.symbol || '').trim().toUpperCase();
    const date = String(value.date || '');
    const targetMinute = Number(value.targetMinute);
    if (!/^[A-Z]{1,10}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(targetMinute)) return '';
    const stopEntryMinute = Number.isInteger(Number(value.stopEntryMinute)) ? Number(value.stopEntryMinute) : '';
    const stopPrice = Number(value.stopPrice) > 0 ? Number(value.stopPrice).toFixed(4) : '';
    return `${symbol}|${date}|${targetMinute}|${stopEntryMinute}|${stopPrice}`;
}

function readTimePriceStore() {
    if (timePriceMemoryStore) return timePriceMemoryStore;
    try {
        const parsed = JSON.parse(globalThis.localStorage?.getItem(TIME_PRICE_STORAGE_KEY) || '{}');
        timePriceMemoryStore = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { timePriceMemoryStore = {}; }
    return timePriceMemoryStore;
}

export function readPolygonTimePrice(value = {}) {
    const row = readTimePriceStore()[timePriceKey(value)];
    return row && Number(row.priceAtTime) > 0 ? row : null;
}

export function writePolygonTimePrices(rows = []) {
    if (!Array.isArray(rows) || !rows.length) return;
    try {
        const store = readTimePriceStore();
        const now = Date.now();
        rows.forEach((row) => {
            const key = timePriceKey(row);
            if (!key || !(Number(row.priceAtTime) > 0)) return;
            store[key] = { symbol: String(row.symbol).toUpperCase(), date: String(row.date), targetMinute: Number(row.targetMinute), stopEntryMinute: Number.isInteger(Number(row.stopEntryMinute)) ? Number(row.stopEntryMinute) : null, priceMinute: Number(row.priceMinute), priceAtTime: Number(row.priceAtTime), priceTime: String(row.priceTime || ''), notOpened: row.notOpened === true, stopHit: row.stopHit === true, stopPrice: Number(row.stopPrice) || null, stopMinute: Number.isInteger(Number(row.stopMinute)) ? Number(row.stopMinute) : null, stopTime: String(row.stopTime || ''), savedAt: now };
        });
        timePriceMemoryStore = Object.fromEntries(Object.entries(store).sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0)).slice(0, MAX_ROWS));
        globalThis.localStorage?.setItem(TIME_PRICE_STORAGE_KEY, JSON.stringify(timePriceMemoryStore));
    } catch (_) {}
}
