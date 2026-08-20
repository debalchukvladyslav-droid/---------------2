const STORAGE_KEY = 'traderjournal:polygon-results:v1';
const MAX_ROWS = 5000;
let memoryStore = null;

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
