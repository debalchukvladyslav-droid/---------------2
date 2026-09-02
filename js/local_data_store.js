const DB_NAME = 'strum-local-data';
const DB_VERSION = 1;
const STORES = {
    days: 'journal-days',
    values: 'values',
    queue: 'sync-queue',
};

let dbPromise = null;

function openDb() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORES.days)) {
                const store = db.createObjectStore(STORES.days, { keyPath: 'key' });
                store.createIndex('user_month', ['userId', 'month']);
                store.createIndex('user_dirty', ['userId', 'dirty']);
            }
            if (!db.objectStoreNames.contains(STORES.values)) db.createObjectStore(STORES.values, { keyPath: 'key' });
            if (!db.objectStoreNames.contains(STORES.queue)) {
                const store = db.createObjectStore(STORES.queue, { keyPath: 'key' });
                store.createIndex('user_kind', ['userId', 'kind']);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch((error) => {
        console.warn('[local-data] IndexedDB unavailable:', error?.message || error);
        dbPromise = null;
        return null;
    });
    return dbPromise;
}

async function transaction(storeName, mode, run) {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result = null;
        try { result = run(store); } catch (error) { console.warn('[local-data]', error); }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
    });
}

function requestValue(request) {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
    });
}

export async function cacheJournalRows(userId, rows = [], { dirty = false } = {}) {
    if (!userId || !rows.length) return;
    await transaction(STORES.days, 'readwrite', (store) => {
        rows.forEach((row) => {
            const date = String(row?.trade_date || '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
            store.put({
                key: `${userId}:${date}`,
                userId,
                month: date.slice(0, 7),
                tradeDate: date,
                row,
                dirty: dirty ? 1 : 0,
                cachedAt: Date.now(),
            });
        });
    });
}

export async function readCachedMonth(userId, month) {
    if (!userId || !/^\d{4}-\d{2}$/.test(String(month || ''))) return [];
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction(STORES.days, 'readonly');
    const index = tx.objectStore(STORES.days).index('user_month');
    const records = await requestValue(index.getAll(IDBKeyRange.only([userId, month])));
    return (records || []).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

export async function readCachedDay(userId, date) {
    if (!userId || !date) return null;
    const db = await openDb();
    if (!db) return null;
    return requestValue(db.transaction(STORES.days, 'readonly').objectStore(STORES.days).get(`${userId}:${date}`));
}

export async function readDirtyJournalRows(userId) {
    if (!userId) return [];
    const db = await openDb();
    if (!db) return [];
    const records = await requestValue(
        db.transaction(STORES.days, 'readonly').objectStore(STORES.days)
            .index('user_dirty').getAll(IDBKeyRange.only([userId, 1])),
    );
    return records || [];
}

export async function markJournalRowsSynced(userId, dates = []) {
    if (!userId || !dates.length) return;
    const db = await openDb();
    if (!db) return;
    await Promise.all(dates.map(async (date) => {
        const record = await readCachedDay(userId, date);
        if (!record) return;
        record.dirty = 0;
        record.syncedAt = Date.now();
        await transaction(STORES.days, 'readwrite', (store) => store.put(record));
    }));
}

export async function cacheValue(userId, name, value) {
    if (!userId || !name) return;
    await transaction(STORES.values, 'readwrite', (store) => store.put({
        key: `${userId}:${name}`, userId, name, value, cachedAt: Date.now(),
    }));
}

export async function readCachedValue(userId, name) {
    if (!userId || !name) return null;
    const db = await openDb();
    if (!db) return null;
    return requestValue(db.transaction(STORES.values, 'readonly').objectStore(STORES.values).get(`${userId}:${name}`));
}

export function publishSyncState(state, detail = {}) {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.syncState = state;
    document.dispatchEvent(new CustomEvent('strum:sync-state', { detail: { state, ...detail } }));
    if (!document.body) return;
    let badge = document.getElementById('global-sync-state');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'global-sync-state';
        badge.className = 'global-sync-state';
        badge.setAttribute('role', 'status');
        badge.setAttribute('aria-live', 'polite');
        document.body.appendChild(badge);
    }
    const labels = {
        local: detail.pending ? `Збережено локально · ${detail.pending}` : 'Збережено локально',
        syncing: 'Синхронізація…',
        synced: 'Синхронізовано',
        offline: detail.pending ? `Без мережі · очікує ${detail.pending}` : 'Без мережі · зміни збережено',
    };
    badge.textContent = labels[state] || state;
    badge.dataset.state = state;
    badge.hidden = false;
    clearTimeout(publishSyncState.hideTimer);
    if (state === 'synced') {
        publishSyncState.hideTimer = setTimeout(() => { badge.hidden = true; }, 1600);
    }
}
