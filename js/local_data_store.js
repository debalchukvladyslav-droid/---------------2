import { applyMergePatch, canonicalJournalRow, cloneData, mergePatch, syncError } from './data_sync_core.js';

const DB_NAME = 'strum-local-data';
const DB_VERSION = 2;
const protectedSetting = key => /^(account_|registration|approved|blocked|role$|mentor_enabled$)/.test(key);
const STORES = { days: 'journal-days', values: 'values', queue: 'sync-queue' };
let dbPromise = null;
function requestValue(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error || syncError('Помилка локального сховища.', 'LOCAL_STORAGE_FAILED'));
    });
}
function openDb() {
    if (!globalThis.indexedDB) return Promise.reject(syncError('Надійне локальне сховище недоступне.', 'LOCAL_STORAGE_UNAVAILABLE'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const days = db.objectStoreNames.contains(STORES.days) ? request.transaction.objectStore(STORES.days) : db.createObjectStore(STORES.days, { keyPath: 'key' });
            if (!days.indexNames.contains('user_month')) days.createIndex('user_month', ['userId', 'month']);
            if (!days.indexNames.contains('user_dirty')) days.createIndex('user_dirty', ['userId', 'dirty']);
            if (!db.objectStoreNames.contains(STORES.values)) db.createObjectStore(STORES.values, { keyPath: 'key' });
            const queue = db.objectStoreNames.contains(STORES.queue) ? request.transaction.objectStore(STORES.queue) : db.createObjectStore(STORES.queue, { keyPath: 'key' });
            if (!queue.indexNames.contains('user')) queue.createIndex('user', 'userId');
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(syncError('Закрийте старі вкладки для оновлення сховища.', 'LOCAL_STORAGE_BLOCKED'));
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
}
async function transact(names, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode);
        const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
        let result;
        let failure;
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(failure || tx.error || syncError('Локальні зміни не збережено.', 'LOCAL_STORAGE_FAILED'));
        Promise.resolve().then(() => run(stores, tx)).then(value => { result = value; }).catch(error => {
            failure = error;
            try { tx.abort(); } catch { reject(error); }
        });
    });
}
const entityStore = domain => domain === 'journal' ? STORES.days : STORES.values;
const entityKey = (userId, domain, entityId) => `${userId}:${domain === 'journal' ? entityId : 'settings'}`;
const entityValue = (record, domain) => domain === 'journal' ? canonicalJournalRow(record?.row || {}) : cloneData(record?.value || {});
function setValue(record, domain, value) {
    if (domain === 'journal') record.row = { ...cloneData(value), user_id: record.userId, trade_date: record.tradeDate };
    else record.value = cloneData(value);
}
function makeRecord(userId, domain, entityId) {
    return { key: entityKey(userId, domain, entityId), userId, localRevision: 0, version: 0,
        ...(domain === 'journal' ? { tradeDate: entityId, month: entityId.slice(0, 7) } : { name: 'settings' }) };
}
export async function readSyncMetadata(userId) { return (await readCachedValue(userId, 'sync-meta'))?.value || null; }
export async function saveSyncMetadata(userId, incoming) {
    return transact([STORES.values, STORES.queue], 'readwrite', async stores => {
        const key = `${userId}:sync-meta`;
        const previous = await requestValue(stores[STORES.values].get(key));
        const value = { ...previous?.value, ...incoming };
        if (previous?.value?.epoch != null && String(previous.value.epoch) !== String(value.epoch)) {
            for (const operation of await requestValue(stores[STORES.queue].index('user').getAll(userId)) || []) {
                if (String(operation.epoch) !== String(value.epoch)) { operation.status = 'stale_epoch'; stores[STORES.queue].put(operation); }
            }
        }
        stores[STORES.values].put({ key, userId, name: 'sync-meta', value, cachedAt: Date.now() });
        return value;
    });
}

// Desired snapshots and immutable operations commit in the SAME transaction.
export async function commitLocalChanges(userId, changes, options = {}) {
    if (!userId) throw syncError('Спочатку увійдіть у свій обліковий запис.', 'AUTH_REQUIRED');
    return transact(Object.values(STORES), 'readwrite', async stores => {
        const metaKey = `${userId}:sync-meta`;
        const metaRecord = await requestValue(stores[STORES.values].get(metaKey));
        const meta = metaRecord?.value;
        if (meta?.epoch == null) throw syncError('Потрібне початкове підключення до бази для надійного збереження.', 'SYNC_SCHEMA_REQUIRED');
        const operations = [];
        for (const change of changes) {
            const { domain, entityId } = change;
            if (!['journal', 'settings'].includes(domain)) throw syncError('Невідомий тип даних.', 'INVALID_DOMAIN');
            const store = stores[entityStore(domain)];
            const record = await requestValue(store.get(entityKey(userId, domain, entityId))) || makeRecord(userId, domain, entityId);
            const before = change.baseValue === undefined ? entityValue(record, domain) : cloneData(change.baseValue);
            const value = domain === 'journal' ? canonicalJournalRow(change.value) : cloneData(change.value);
            const patch = mergePatch(before, value);
            if (domain === 'settings') {
                for (const key of Object.keys(patch)) if (protectedSetting(key)) delete patch[key];
            }
            if (!Object.keys(patch).length) continue;
            record.localRevision = (record.localRevision || 0) + 1;
            Object.assign(record, { dirty: 1, epoch: meta.epoch, cachedAt: Date.now() });
            setValue(record, domain, change.baseValue === undefined && domain !== 'settings' ? value : applyMergePatch(entityValue(record, domain), patch));
            meta.nextSequence = (meta.nextSequence || 0) + 1;
            const operationId = options.operationId && changes.length === 1 ? options.operationId : crypto.randomUUID();
            const operation = { key: operationId, operationId, userId, domain, entityId,
                baseVersion: record.version || 0, epoch: meta.epoch, base: before, patch,
                localRevision: record.localRevision, sequence: meta.nextSequence,
                createdAt: Date.now(), status: 'pending', attempts: 0, nextAttemptAt: 0,
                ...(options.batchId ? { batchId: options.batchId } : {}), ...(options.source ? { source: options.source } : {}) };
            store.put(record);
            stores[STORES.queue].add(operation);
            operations.push(operation);
        }
        stores[STORES.values].put({ ...metaRecord, value: meta });
        return { savedLocally: true, operationIds: operations.map(operation => operation.operationId), pending: operations.length };
    });
}
export async function cacheJournalRows(userId, rows = [], { dirty = false } = {}) {
    if (!userId || !rows.length) return;
    if (dirty) return commitLocalChanges(userId, rows.map(row => ({ domain: 'journal', entityId: row.trade_date, value: row })));
    return transact([STORES.days], 'readwrite', async stores => {
        const store = stores[STORES.days];
        for (const row of rows) {
            const date = String(row?.trade_date || '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const existing = await requestValue(store.get(`${userId}:${date}`));
            if (existing?.dirty) continue;
            const version = row.sync_version ?? existing?.version ?? 0;
            if (existing && Number(version) < Number(existing.version || 0)) continue;
            store.put({ ...makeRecord(userId, 'journal', date), ...existing, row: cloneData(row),
                serverValue: canonicalJournalRow(row), version, dirty: 0, cachedAt: Date.now() });
        }
    });
}
export async function readCachedMonth(userId, month) {
    if (!userId || !/^\d{4}-\d{2}$/.test(String(month || ''))) return [];
    return transact([STORES.days], 'readonly', async stores => (await requestValue(stores[STORES.days].index('user_month').getAll(IDBKeyRange.only([userId, month]))) || []).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)));
}
export async function readCachedDay(userId, date) {
    if (!userId || !date) return null;
    return transact([STORES.days], 'readonly', stores => requestValue(stores[STORES.days].get(`${userId}:${date}`)));
}
export async function readDirtyJournalRows(userId) {
    if (!userId) return [];
    return transact([STORES.days], 'readonly', stores => requestValue(stores[STORES.days].index('user_dirty').getAll(IDBKeyRange.only([userId, 1]))));
}
export async function markJournalRowsSynced(userId, acknowledgements = []) {
    if (acknowledgements.some(item => typeof item !== 'object' || !item.operationId)) throw syncError('Підтвердження збереження потребує operationId.', 'INVALID_ACK');
    return acknowledgeOperations(userId, acknowledgements);
}
export async function cacheValue(userId, name, value, options = {}) {
    if (!userId || !name) return;
    return transact([STORES.values], 'readwrite', async stores => {
        const key = `${userId}:${name}`;
        const existing = await requestValue(stores[STORES.values].get(key));
        if (name === 'settings' && existing?.dirty) return;
        const record = { ...existing, key, userId, name, value: cloneData(value), cachedAt: Date.now() };
        if (name === 'settings') Object.assign(record, { serverValue: cloneData(value), version: options.version ?? existing?.version ?? 0, dirty: 0 });
        stores[STORES.values].put(record);
    });
}
export async function readCachedValue(userId, name) {
    if (!userId || !name) return null;
    return transact([STORES.values], 'readonly', stores => requestValue(stores[STORES.values].get(`${userId}:${name}`)));
}
export async function listDataOperations(userId) {
    return transact([STORES.queue], 'readonly', async stores => (await requestValue(stores[STORES.queue].index('user').getAll(userId)) || []).sort((a, b) => a.sequence - b.sequence));
}
// A rejected RPC rolls back the whole batch, including unrelated journal edits.
// Keep identities and user patches; remove only server-managed account fields.
export async function repairProtectedSettingsOperations(userId) {
    return transact([STORES.queue], 'readwrite', async stores => {
        for (const operation of await requestValue(stores[STORES.queue].index('user').getAll(userId)) || []) {
            let changed = false;
            if (operation.domain === 'settings') {
                for (const key of Object.keys(operation.patch || {})) {
                    if (protectedSetting(key)) { delete operation.patch[key]; changed = true; }
                }
            }
            if (operation.status === 'blocked' && operation.lastError?.code === '42501'
                && operation.lastError?.message === 'Protected account setting') {
                operation.status = 'pending'; operation.nextAttemptAt = 0; operation.lastError = null; changed = true;
            }
            if (changed) stores[STORES.queue].put(operation);
        }
    });
}
export async function recordOperationFailure(userId, operationIds, error, nextAttemptAt, blocked = false) {
    return transact([STORES.queue], 'readwrite', async stores => {
        for (const operationId of operationIds) {
            const record = await requestValue(stores[STORES.queue].get(operationId));
            if (!record || record.userId !== userId) continue;
            Object.assign(record, { attempts: (record.attempts || 0) + 1, nextAttemptAt,
                lastError: { code: error?.code || '', message: error?.message || 'Помилка синхронізації' } });
            if (blocked) record.status = 'blocked';
            stores[STORES.queue].put(record);
        }
    });
}
export async function acknowledgeOperations(userId, results = []) {
    return transact(Object.values(STORES), 'readwrite', async stores => {
        const changed = [];
        for (const result of results) {
            const operation = await requestValue(stores[STORES.queue].get(result.operationId));
            if (!operation || operation.userId !== userId) continue;
            const store = stores[entityStore(operation.domain)];
            const record = await requestValue(store.get(entityKey(userId, operation.domain, operation.entityId)));
            if (!['applied', 'duplicate'].includes(result.status)) {
                Object.assign(operation, { status: result.status === 'stale_epoch' ? 'stale_epoch' : 'conflict',
                    conflictId: result.conflictId || null, remote: cloneData(result.row || null),
                    remoteVersion: result.version ?? operation.baseVersion, remoteEpoch: result.epoch ?? operation.epoch });
                stores[STORES.queue].put(operation);
                continue;
            }
            stores[STORES.queue].delete(operation.operationId);
            if (!record) continue;
            const newer = record.serverValue !== undefined && (Number(record.epoch || 0) > Number(result.epoch || 0)
                || (String(record.epoch) === String(result.epoch) && Number(record.version || 0) > Number(result.version || 0)));
            const remote = newer ? record.serverValue : result.row
                ? (operation.domain === 'journal' ? canonicalJournalRow(result.row) : result.row) : applyMergePatch(operation.base, operation.patch);
            if (!newer) Object.assign(record, { serverValue: cloneData(remote), version: result.version, epoch: result.epoch });
            record.syncedAt = Date.now();
            const pending = (await requestValue(stores[STORES.queue].index('user').getAll(userId)) || [])
                .filter(item => item.domain === operation.domain && item.entityId === operation.entityId).sort((a, b) => a.sequence - b.sequence);
            let desired = cloneData(remote);
            for (const item of pending) desired = applyMergePatch(desired, item.patch);
            record.dirty = pending.length ? 1 : 0;
            setValue(record, operation.domain, desired);
            store.put(record);
            changed.push({ domain: operation.domain, entityId: operation.entityId, record: cloneData(record), operationId: operation.operationId });
        }
        return changed;
    });
}

export async function resolveDataOperation(userId, operationId, choice) {
    if (!['local', 'server'].includes(choice)) throw syncError('Невідомий варіант вирішення конфлікту.', 'INVALID_RESOLUTION');
    return transact(Object.values(STORES), 'readwrite', async stores => {
        const operation = await requestValue(stores[STORES.queue].get(operationId));
        if (!operation || operation.userId !== userId) throw syncError('Конфлікт уже вирішено або не знайдено.', 'CONFLICT_NOT_FOUND');
        if (!['conflict', 'stale_epoch', 'blocked'].includes(operation.status)) throw syncError('Ця операція не потребує ручного вирішення.', 'INVALID_RESOLUTION');
        const metaRecord = await requestValue(stores[STORES.values].get(`${userId}:sync-meta`));
        const meta = metaRecord?.value || {};
        const store = stores[entityStore(operation.domain)];
        const key = entityKey(userId, operation.domain, operation.entityId);
        const record = await requestValue(store.get(key)) || makeRecord(userId, operation.domain, operation.entityId);
        // A pull may have advanced beyond the response that originally conflicted.
        // Epoch quarantine has no response row at all: use the restored snapshot.
        const useCachedServer = record.serverValue !== undefined &&
            (String(record.epoch) === String(meta.epoch) &&
             (String(operation.epoch) !== String(meta.epoch) || Number(record.version || 0) >= Number(operation.remoteVersion || 0)));
        const remoteValue = useCachedServer ? record.serverValue : operation.remote || {};
        const remoteVersion = useCachedServer ? record.version || 0 : operation.remoteVersion || 0;
        const remote = operation.domain === 'journal' ? canonicalJournalRow(remoteValue) : cloneData(remoteValue);
        const others = (await requestValue(stores[STORES.queue].index('user').getAll(userId)) || [])
            .filter(item => item.operationId !== operationId && item.domain === operation.domain && item.entityId === operation.entityId
                )
            .sort((a, b) => a.sequence - b.sequence);
        stores[STORES.queue].delete(operationId);
        // Resolve only this edit. Preserve later edits and the server's unrelated fields.
        let replacementId = null;
        const patch = choice === 'local' ? mergePatch(remote, applyMergePatch(remote, operation.patch)) : {};
        if (Object.keys(patch).length) {
            replacementId = crypto.randomUUID();
            const replacement = { ...operation, key: replacementId, operationId: replacementId,
                base: remote, patch, baseVersion: remoteVersion, epoch: meta.epoch,
                createdAt: Date.now(), status: 'pending', attempts: 0, nextAttemptAt: 0,
                conflictId: null, remote: null };
            // Keep this edit before edits that were based on it.
            stores[STORES.queue].add(replacement);
            others.push(replacement);
            others.sort((a, b) => a.sequence - b.sequence);
        }
        let desired = cloneData(remote);
        for (const pending of others) desired = applyMergePatch(desired, pending.patch);
        setValue(record, operation.domain, desired);
        Object.assign(record, { serverValue: cloneData(remote), version: remoteVersion,
            epoch: meta.epoch, localRevision: others.at(-1)?.localRevision ?? record.localRevision,
            dirty: others.length ? 1 : 0, cachedAt: Date.now() });
        store.put(record);
        return { choice, conflictId: operation.conflictId || null, operationId: replacementId,
            change: { domain: operation.domain, entityId: operation.entityId, record: cloneData(record) } };
    });
}
export async function applyRemoteChanges(userId, response) {
    return transact(Object.values(STORES), 'readwrite', async stores => {
        const metaKey = `${userId}:sync-meta`;
        const metaRecord = await requestValue(stores[STORES.values].get(metaKey));
        const meta = metaRecord?.value || {};
        const changed = [];
        const epochChanged = meta.epoch != null && String(meta.epoch) !== String(response.epoch);
        if (epochChanged || response.resetRequired) {
            for (const operation of await requestValue(stores[STORES.queue].index('user').getAll(userId)) || []) {
                if (String(operation.epoch) !== String(response.epoch)) { operation.status = 'stale_epoch'; stores[STORES.queue].put(operation); }
            }
        }
        for (const change of response.changes || []) {
            if (!['journal', 'settings'].includes(change.domain)) continue;
            const store = stores[entityStore(change.domain)];
            const key = entityKey(userId, change.domain, change.entityId);
            const existing = await requestValue(store.get(key));
            if (existing && !epochChanged && Number(change.version) < Number(existing.version || 0)) continue;
            if (change.deleted) {
                if (!existing?.dirty) store.delete(key);
                changed.push({ ...change, localDirty: !!existing?.dirty });
                continue;
            }
            const record = existing || makeRecord(userId, change.domain, change.entityId);
            const value = change.domain === 'journal' ? canonicalJournalRow(change.record || {}) : change.record || {};
            Object.assign(record, { serverValue: cloneData(value), version: change.version, epoch: change.epoch, cachedAt: Date.now() });
            if (!record.dirty) { setValue(record, change.domain, value); record.dirty = 0; }
            store.put(record);
            changed.push({ ...change, record: cloneData(record), localDirty: !!record.dirty });
        }
        stores[STORES.values].put({ key: metaKey, userId, name: 'sync-meta', cachedAt: Date.now(), value: { ...meta, epoch: response.epoch, cursor: response.cursor } });
        return { changed, epochChanged };
    });
}
export async function replaceServerSnapshot(userId, rows, metadata) {
    return transact(Object.values(STORES), 'readwrite', async stores => {
        const previous = await requestValue(stores[STORES.values].get(`${userId}:sync-meta`));
        const epochChanged = previous?.value?.epoch != null && String(previous.value.epoch) !== String(metadata.epoch);
        const existingRows = (await requestValue(stores[STORES.days].getAll()) || []).filter(row => row.userId === userId);
        const incomingDates = new Set(rows.map(row => row.trade_date));
        for (const record of existingRows) {
            if (epochChanged && record.dirty) stores[STORES.values].put({ key: `${userId}:quarantine:${record.epoch}:${record.tradeDate}`, userId, name: 'quarantine', value: record });
            if (epochChanged || (!record.dirty && !incomingDates.has(record.tradeDate))) stores[STORES.days].delete(record.key);
        }
        for (const row of rows) {
            const existing = epochChanged ? null : existingRows.find(record => record.tradeDate === row.trade_date);
            if (existing?.dirty) continue;
            stores[STORES.days].put({ ...makeRecord(userId, 'journal', row.trade_date), row: cloneData(row), serverValue: canonicalJournalRow(row),
                version: row.sync_version || 0, epoch: metadata.epoch, dirty: 0, cachedAt: Date.now() });
        }
        const settingsKey = `${userId}:settings`;
        const settings = await requestValue(stores[STORES.values].get(settingsKey));
        if (epochChanged && settings?.dirty) stores[STORES.values].put({ key: `${userId}:quarantine:${settings.epoch}:settings`, userId, name: 'quarantine', value: settings });
        if (epochChanged || !settings?.dirty) stores[STORES.values].put({ ...makeRecord(userId, 'settings', userId), value: cloneData(metadata.settings || {}),
            serverValue: cloneData(metadata.settings || {}), version: metadata.settingsVersion || 0, epoch: metadata.epoch, dirty: 0, cachedAt: Date.now() });
        if (epochChanged) {
            for (const operation of await requestValue(stores[STORES.queue].index('user').getAll(userId)) || []) {
                if (String(operation.epoch) !== String(metadata.epoch)) { operation.status = 'stale_epoch'; stores[STORES.queue].put(operation); }
            }
        }
        // Keep the server baseline current even for dirty records and overlay
        // every durable edit before publishing the replacement snapshot.
        const pending = (await requestValue(stores[STORES.queue].index('user').getAll(userId)) || []).sort((a, b) => a.sequence - b.sequence);
        const incomingRows = new Map(rows.map(row => [row.trade_date, row]));
        const rebased = new Map();
        for (const operation of pending) {
            const key = entityKey(userId, operation.domain, operation.entityId);
            let record = rebased.get(key);
            if (!record) {
                const target = stores[entityStore(operation.domain)];
                record = await requestValue(target.get(key)) || makeRecord(userId, operation.domain, operation.entityId);
                const row = incomingRows.get(operation.entityId);
                const remote = operation.domain === 'journal' ? canonicalJournalRow(row || {}) : cloneData(metadata.settings || {});
                Object.assign(record, { serverValue: remote, version: operation.domain === 'journal' ? row?.sync_version || 0 : metadata.settingsVersion || 0,
                    epoch: metadata.epoch, dirty: 1, cachedAt: Date.now() });
                setValue(record, operation.domain, remote);
                rebased.set(key, record);
            }
            setValue(record, operation.domain, applyMergePatch(entityValue(record, operation.domain), operation.patch));
            record.localRevision = Math.max(record.localRevision || 0, operation.localRevision || 0);
        }
        for (const record of rebased.values()) stores[record.tradeDate ? STORES.days : STORES.values].put(record);
        stores[STORES.values].put({ key: `${userId}:sync-meta`, userId, name: 'sync-meta', value: { ...previous?.value, ...metadata } });
        return { epochChanged };
    });
}
export async function readAllCachedJournal(userId) {
    return transact([STORES.days], 'readonly', async stores => (await requestValue(stores[STORES.days].getAll()) || []).filter(row => row.userId === userId));
}
export async function withDataSyncLease(userId, owner, run) {
    const key = `${userId}:sync-lease`;
    const acquire = () => transact([STORES.values], 'readwrite', async stores => {
        const record = await requestValue(stores[STORES.values].get(key));
        if (record?.value?.expiresAt > Date.now() && record.value.owner !== owner) return false;
        stores[STORES.values].put({ key, userId, name: 'sync-lease', value: { owner, expiresAt: Date.now() + 45000 } });
        return true;
    });
    if (!await acquire()) return { locked: true };
    const heartbeat = setInterval(() => void acquire().catch(() => {}), 10000);
    try { return await run(); } finally {
        clearInterval(heartbeat);
        await transact([STORES.values], 'readwrite', async stores => {
            const record = await requestValue(stores[STORES.values].get(key));
            if (record?.value?.owner === owner) stores[STORES.values].delete(key);
        });
    }
}
export async function closeLocalDataStore() { if (dbPromise) (await dbPromise).close(); dbPromise = null; }
export function publishSyncState(state, detail = {}) {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.syncState = state;
    document.dispatchEvent(new CustomEvent('strum:sync-state', { detail: { state, ...detail } }));
}
