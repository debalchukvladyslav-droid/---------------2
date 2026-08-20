import { supabase, SUPABASE_URL } from './supabase.js';

const READY = new Set();
let timer = null;
let running = false;
let pendingJournal = {};
const INTERVAL_MS = 65000;
// Keep compatibility with the previously deployed Edge Function (max 5 rows).
// The shared server queue also uses five Polygon calls per minute globally.
const REQUEST_LIMIT = 5;

function collectSessionLowRequests(journal = {}) {
    const unique = new Map();
    Object.entries(journal || {}).forEach(([date, day]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        (Array.isArray(day?.trades) ? day.trades : []).forEach((trade) => {
            const symbol = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
            if (!/^[A-Z]{1,10}$/.test(symbol)) return;
            unique.set(`${symbol}|${date}`, { symbol, date, entryMinute: 570 });
        });
    });
    return [...unique.values()];
}

async function requestPolygonBatch(items) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Немає активної сесії');
    const response = await fetch(`${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/market-best-exits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Market data ${response.status}`);
    return payload;
}

async function runQueue(reason = 'background') {
    if (running) return;
    const all = collectSessionLowRequests(pendingJournal);
    const missing = all.filter((item) => !READY.has(`${item.symbol}|${item.date}`));
    if (!missing.length) {
        console.info(`[Polygon ${reason}] усі ${all.length} тікер-днів уже мають Low 09:30–12:00`);
        return;
    }
    running = true;
    try {
        const payload = await requestPolygonBatch(missing.slice(0, REQUEST_LIMIT));
        const rows = Array.isArray(payload.results) ? payload.results.filter((row) => Number(row?.low) > 0) : [];
        rows.forEach((row) => READY.add(`${row.symbol}|${row.date}`));
        console.groupCollapsed(`[Polygon ${reason}] Low 09:30–12:00: готово ${READY.size}/${all.length}, у черзі ${payload.queued || 0}`);
        if (rows.length) console.table(rows.map((row) => ({ дата: row.date, тікер: row.symbol, low: Number(row.low), час_low: row.lowTime, кеш: row.cached === true })));
        console.info({ requested: Math.min(missing.length, REQUEST_LIMIT), processedNow: payload.processed || 0, returned: rows.length, remaining: all.length - READY.size });
        console.groupEnd();
    } catch (error) {
        console.warn(`[Polygon ${reason}] фонова черга призупинена:`, error?.message || error);
    } finally {
        running = false;
        if (collectSessionLowRequests(pendingJournal).some((item) => !READY.has(`${item.symbol}|${item.date}`))) {
            clearTimeout(timer);
            timer = setTimeout(() => void runQueue('continue'), INTERVAL_MS);
        }
    }
}

export function startPolygonLowBackfill(journal = {}, reason = 'load') {
    pendingJournal = journal && typeof journal === 'object' ? journal : {};
    clearTimeout(timer);
    timer = setTimeout(() => void runQueue(reason), 1500);
}
