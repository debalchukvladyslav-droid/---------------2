import * as localStore from './local_data_store.js';
import { isRetryableSyncError, retryDelay, syncError } from './data_sync_core.js';

// Transport injection makes interruption, duplicate delivery and two-tab behavior testable.
export function createDataSyncEngine({ transport, store = localStore, onChange = () => {}, onSnapshot = () => {},
    onState = () => {}, online = () => globalThis.navigator?.onLine !== false, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout, random = Math.random, lock = null, conflictPolicy = 'manual',
    idleDelay = 60000 } = {}) {
    let userId = null;
    let generation = 0;
    let activeTask = null;
    let timer = null;
    let failures = 0;
    const owner = globalThis.crypto.randomUUID();
    const current = (user, version) => userId === user && generation === version;
    const wire = operation => Object.fromEntries(['operationId', 'userId', 'domain', 'entityId', 'baseVersion', 'epoch', 'patch', 'base'].map(key => [key, operation[key]]));

    async function status(user = userId, phase = null, error = null) {
        if (!user || user !== userId) return;
        const operations = await store.listDataOperations(user);
        if (user !== userId) return;
        const conflicts = operations.filter(operation => ['conflict', 'stale_epoch'].includes(operation.status));
        const blocked = operations.find(operation => operation.status === 'blocked');
        const pending = operations.length;
        const state = conflicts.length ? 'conflict' : error || blocked ? 'error' : !online() ? 'offline' : pending ? phase || 'local' : 'synced';
        onState(state, { pending, conflicts: conflicts.length, message: error?.message || blocked?.lastError?.message, operations });
        return { pending, conflicts: conflicts.length, blocked: !!blocked };
    }

    function wake(delay = 0) {
        if (!userId) return;
        if (timer) cancel(timer);
        timer = schedule(() => { timer = null; void run().catch(() => {}); }, delay);
        timer?.unref?.();
    }

    async function snapshot(user, version) {
        const metadata = await transport.metadata(user);
        const rows = await transport.snapshot(user);
        if (!current(user, version)) return;
        await store.replaceServerSnapshot(user, rows, { ...metadata, initialized: true });
        const records = await store.readAllCachedJournal(user);
        const settings = await store.readCachedValue(user, 'settings');
        if (current(user, version)) await onSnapshot(user, records, settings?.value || {}, metadata);
    }

    async function pull(user, version) {
        let metadata = await store.readSyncMetadata(user);
        if (!metadata || metadata.initialized === false) { await snapshot(user, version); metadata = await store.readSyncMetadata(user); }
        while (current(user, version)) {
            const response = await transport.pull(user, metadata.cursor || 0);
            if (!current(user, version)) return;
            if (!response || !Array.isArray(response.changes) || !Number.isSafeInteger(Number(response.cursor))
                || response.cursor == null || Number(response.cursor) < 0 || response.epoch == null) {
                throw syncError('Некоректна відповідь синхронізації.', 'INVALID_SYNC_RESPONSE');
            }
            if (response.resetRequired || String(response.epoch) !== String(metadata.epoch)) {
                await snapshot(user, version);
                metadata = await store.readSyncMetadata(user);
                continue;
            }
            if (!Array.isArray(response.changes) || response.cursor == null || response.epoch == null) throw syncError('Неповна відповідь синхронізації.', 'INVALID_SYNC_RESPONSE');
            if (response.hasMore && Number(response.cursor) <= Number(metadata.cursor || 0)) throw syncError('База не просуває курсор синхронізації.', 'INVALID_SYNC_RESPONSE');
            if (Number(response.cursor) < Number(metadata.cursor || 0)) throw syncError('Курсор синхронізації повернувся назад.', 'INVALID_SYNC_RESPONSE');
            const result = await store.applyRemoteChanges(user, response);
            if (current(user, version) && result.changed.length) await onChange(user, result.changed);
            metadata = { ...metadata, epoch: response.epoch, cursor: response.cursor };
            if (!response.hasMore) break;
        }
    }

    async function synchronize(user, version, requireServer) {
        if (!online()) { await status(user); if (requireServer) throw syncError('Зміни збережено на пристрої. Для цієї дії потрібен інтернет.', 'OFFLINE'); return; }
        await pull(user, version);
        if (!current(user, version)) return;
        await store.repairProtectedSettingsOperations?.(user);
        while (current(user, version)) {
            const all = await store.listDataOperations(user);
            if (!current(user, version)) return;
            // Conflicts survive reloads, and a snapshot can quarantine operations
            // without an apply response. Resume both through the same local policy.
            if (conflictPolicy === 'local') {
                const unresolved = all.filter(operation => ['conflict', 'stale_epoch'].includes(operation.status));
                if (unresolved.length) {
                    const changes = [];
                    for (const operation of unresolved) {
                        if (!current(user, version)) return;
                        const resolved = await store.resolveDataOperation(user, operation.operationId, 'local');
                        if (resolved.change) changes.push(resolved.change);
                        if (resolved.conflictId && transport.resolveConflict) {
                            void transport.resolveConflict(user, resolved.conflictId, 'local').catch(() => {});
                        }
                    }
                    if (current(user, version) && changes.length) await onChange(user, changes);
                    continue;
                }
            }
            const blockedEntities = new Set();
            const eligible = [];
            for (const operation of all) {
                const key = `${operation.domain}:${operation.entityId}`;
                if (operation.status !== 'pending') { blockedEntities.add(key); continue; }
                if (blockedEntities.has(key)) continue;
                // A later operation may depend on this base; never send it before the earlier retry.
                if (!requireServer && operation.nextAttemptAt > now()) { blockedEntities.add(key); continue; }
                eligible.push(operation);
                // Confirm this entity's edit before sending edits based on it.
                blockedEntities.add(key);
            }
            if (!eligible.length) break;
            const first = eligible[0];
            const nextBatch = eligible.findIndex(operation => operation.batchId);
            const operations = first.batchId ? all.filter(operation => operation.batchId === first.batchId)
                : eligible.slice(0, nextBatch < 0 ? 100 : Math.min(nextBatch, 100));
            if (operations.some(operation => operation.status !== 'pending')) break;
            if (operations.length > 2000) throw syncError('Імпорт перевищує 2000 операцій.', 'INVALID_IMPORT');
            await status(user, 'syncing');
            if (!current(user, version)) return;
            try {
                const response = await transport.apply(user, operations.map(wire), !!first.batchId);
                if (!current(user, version)) return;
                if (!Array.isArray(response.results) || response.results.length !== operations.length
                    || operations.some(operation => !response.results.some(result => result.operationId === operation.operationId))) {
                    throw syncError('База не підтвердила всі операції; їх буде повторено без дублювання.', 'INVALID_SYNC_RESPONSE');
                }
                let changed = await store.acknowledgeOperations(user, response.results);
                const conflicts = response.results.filter(result => ['conflict', 'stale_epoch'].includes(result.status));
                // The owner chose local-first conflict handling: keep the edit in
                // IndexedDB, rebase it on the newest server version and resend it.
                // This never drops the server variant; it remains in the audit log.
                if (conflictPolicy === 'local' && conflicts.length) {
                    if (conflicts.some(result => result.status === 'stale_epoch')) await pull(user, version);
                    for (const result of conflicts) {
                        if (!current(user, version)) return;
                        const resolved = await store.resolveDataOperation(user, result.operationId, 'local');
                        if (resolved.change) changed = [...changed, resolved.change];
                        if (resolved.conflictId && transport.resolveConflict) {
                            void transport.resolveConflict(user, resolved.conflictId, 'local')
                                .catch(error => console.warn('[Data sync] conflict audit deferred:', error?.message || error));
                        }
                    }
                }
                if (current(user, version) && changed.length) await onChange(user, changed);
                // The apply cursor is NOT a pull checkpoint: other users/devices may have changed rows before it.
                if (conflictPolicy !== 'local' && response.results.some(result => result.status === 'stale_epoch')) await pull(user, version);
            } catch (error) {
                const retryable = isRetryableSyncError(error);
                const nextAttempt = now() + retryDelay(Math.max(...operations.map(operation => operation.attempts || 0)), random);
                await store.recordOperationFailure(user, operations.map(operation => operation.operationId), error, nextAttempt, !retryable);
                throw error;
            }
        }
        if (!current(user, version)) return;
        await pull(user, version);
        const summary = await status(user);
        if (requireServer && summary?.pending) throw syncError(
            summary.conflicts ? 'Є різні версії правок. Відкрийте Налаштування → Збереження та відновлення й оберіть потрібну версію.'
                : 'Не всі зміни передано на сервер. Відкрийте Налаштування → Збереження та відновлення, щоб переглянути причину.',
            summary.conflicts ? 'SYNC_CONFLICT' : 'SYNC_PENDING', summary);
    }

    async function run(requireServer = false) {
        if (!userId) throw syncError('Немає активного облікового запису.', 'AUTH_REQUIRED');
        if (activeTask) {
            const waitingUser = userId;
            const waitingGeneration = generation;
            await activeTask.catch(error => {
                if (current(waitingUser, waitingGeneration) && requireServer) throw error;
            });
            if (!current(waitingUser, waitingGeneration)) return;
            if (requireServer) return run(true);
            wake(0);
            return;
        }
        const user = userId;
        const version = generation;
        const task = async () => synchronize(user, version, requireServer);
        activeTask = (async () => {
            try {
                const result = lock ? await lock(user, task) : await store.withDataSyncLease(user, owner, task);
                if (result?.locked && requireServer) throw syncError('Інша вкладка синхронізує дані. Повторіть дію після завершення.', 'SYNC_LOCKED');
                failures = 0;
            } catch (error) {
                failures += 1;
                await status(user, null, error);
                throw error;
            } finally {
                activeTask = null;
                if (userId && !current(user, version)) wake(0);
                else if (userId && failures) wake(retryDelay(failures - 1, random));
                else if (userId) {
                    let delay = idleDelay;
                    try {
                        const operations = await store.listDataOperations(user);
                        const pending = (operations || []).filter(operation => operation.status === 'pending');
                        if (pending.length) {
                            const waiting = pending.map(operation => Number(operation.nextAttemptAt) || 0).filter(at => at > now());
                            delay = waiting.length ? Math.max(250, Math.min(...waiting) - now()) : 250;
                        }
                    } catch { delay = idleDelay; }
                    if (userId === user) wake(delay);
                }
            }
        })();
        return activeTask;
    }

    return {
        start(user) { if (userId !== user) { userId = user || null; generation += 1; } if (userId) wake(0); },
        stop() { generation += 1; userId = null; if (timer) cancel(timer); timer = null; },
        notify() { void status().catch(error => onState('error', { message: error.message })); wake(100); },
        flush: () => run(true),
        sync: () => run(false),
        status,
        refreshSnapshot: async () => { if (!userId) throw syncError('Потрібна авторизація.', 'AUTH_REQUIRED'); await snapshot(userId, generation); wake(0); },
    };
}
