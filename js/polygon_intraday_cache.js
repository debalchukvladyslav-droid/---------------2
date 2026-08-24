const DB_NAME = 'traderjournal-polygon-cache';
const STORE_NAME = 'intraday-days';
const DB_VERSION = 1;
const CACHE_VERSION = 1;
const memory = new Map();
const inFlight = new Map();
const MIN_NETWORK_INTERVAL_MS = 12_500;
let networkQueue = Promise.resolve();
let lastNetworkAt = 0;

function normalizedKey(symbol, date) {
    const ticker = String(symbol || '').trim().toUpperCase();
    const day = String(date || '').trim();
    if (!/^[A-Z]{1,10}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    return `${ticker}|${day}`;
}

function openDb() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function readIndexed(key) {
    const db = await openDb().catch(() => null);
    if (!db) return null;
    return new Promise((resolve) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
    });
}

async function writeIndexed(record) {
    const db = await openDb().catch(() => null);
    if (!db) return;
    await new Promise((resolve) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
    });
}

export async function readPolygonDay(symbol, date) {
    const key = normalizedKey(symbol, date);
    if (!key) return null;
    if (memory.has(key)) return memory.get(key);
    const stored = await readIndexed(key);
    if (!stored || stored.version !== CACHE_VERSION || !Array.isArray(stored.bars) || !stored.bars.length) return null;
    memory.set(key, stored.bars);
    return stored.bars;
}

export async function getOrLoadPolygonDay(symbol, date, loader) {
    const key = normalizedKey(symbol, date);
    if (!key) throw new Error('Invalid Polygon cache key');
    const cached = await readPolygonDay(symbol, date);
    if (cached) return { bars: cached, cached: true };
    if (inFlight.has(key)) return inFlight.get(key);
    const request = (async () => {
        const networkLoad = networkQueue.catch(() => {}).then(async () => {
            const waitMs = Math.max(0, MIN_NETWORK_INTERVAL_MS - (Date.now() - lastNetworkAt));
            if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
            lastNetworkAt = Date.now();
            return loader();
        });
        networkQueue = networkLoad.then(() => undefined, () => undefined);
        const bars = await networkLoad;
        if (!Array.isArray(bars) || !bars.length) throw new Error('Polygon не повернув хвилинні свічки');
        const clean = bars.filter((bar) => Number(bar?.t) > 0 && Number(bar?.o) > 0 && Number(bar?.h) > 0 && Number(bar?.l) > 0 && Number(bar?.c) > 0);
        if (!clean.length) throw new Error('Polygon повернув некоректні свічки');
        memory.set(key, clean);
        await writeIndexed({ key, symbol: String(symbol).toUpperCase(), date, version: CACHE_VERSION, bars: clean, savedAt: Date.now() });
        return { bars: clean, cached: false };
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
}

function minuteNY(timestamp) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(Number(timestamp)));
    return Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
}

export function analyzePolygonDay(bars, item, targetMinute = null) {
    const byMinute = new Map((bars || []).map((bar) => [minuteNY(bar.t), bar]));
    const eligible = [...byMinute.entries()].filter(([minute, bar]) => minute >= Math.max(570, Number(item.entryMinute) || 570) && minute < 720 && Number(bar?.l) > 0);
    if (!eligible.length) return null;
    const lowEntry = eligible.reduce((best, current) => Number(current[1].l) < Number(best[1].l) ? current : best);
    const result = { symbol: item.symbol, date: item.date, entryMinute: item.entryMinute, low: Number(lowEntry[1].l), lowTime: new Date(Number(lowEntry[1].t)).toISOString(), cached: true };
    if (!Number.isInteger(targetMinute)) return result;
    result.targetMinute = targetMinute;
    result.stopPrice = Number(item.stopPrice) || null;
    result.stopEntryMinute = Number(item.stopEntryMinute);
    if (targetMinute < result.stopEntryMinute) return { ...result, notOpened: true, stopHit: false };
    const stop = result.stopPrice > 0 ? [...byMinute.entries()].find(([minute, bar]) => minute >= result.stopEntryMinute && minute <= targetMinute && Number(bar?.h) >= result.stopPrice) : null;
    if (stop) return { ...result, stopHit: true, stopMinute: stop[0], stopTime: new Date(Number(stop[1].t)).toISOString(), priceMinute: targetMinute, priceAtTime: result.stopPrice, priceTime: new Date(Number(stop[1].t)).toISOString() };
    const target = byMinute.get(targetMinute);
    return target && Number(target.c) > 0 ? { ...result, stopHit: false, priceMinute: targetMinute, priceAtTime: Number(target.c), priceTime: new Date(Number(target.t)).toISOString() } : result;
}
