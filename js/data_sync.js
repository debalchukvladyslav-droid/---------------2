import { supabase } from './supabase.js';
import { createDataSyncEngine } from './data_sync_engine.js';
import { cacheValue, publishSyncState, readSyncMetadata, saveSyncMetadata } from './local_data_store.js';
import { syncError } from './data_sync_core.js';

let handlers = {};
let activeUserId = null;
const metadataRequests = new Map();
async function rpc(name, parameters) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
        const { data, error } = await supabase.rpc(name, parameters).abortSignal(controller.signal);
        if (error) throw error;
        if (!data || typeof data !== 'object') throw syncError('Некоректна відповідь бази.', 'INVALID_SYNC_RESPONSE');
        return data;
    } finally { clearTimeout(timeout); }
}

const transport = {
    metadata: userId => rpc('get_data_sync_state', { p_user_id: userId }),
    pull: (userId, cursor) => rpc('pull_data_changes', { p_user_id: userId, p_cursor: cursor, p_limit: 8 }),
    apply: (_userId, operations, atomic) => rpc('apply_data_operations', { p_operations: operations, p_atomic: atomic }),
    resolveConflict: (_userId, conflictId, resolution) => rpc('resolve_data_conflict', { p_conflict_id: conflictId, p_resolution: resolution }),
    async snapshot(userId) {
        const rows = [];
        let after = null;
        for (;;) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 25000);
            try {
                let query = supabase.from('journal_days').select('*').eq('user_id', userId).order('trade_date', { ascending: true }).limit(40);
                if (after) query = query.gt('trade_date', after);
                const { data, error } = await query.abortSignal(controller.signal);
                if (error) throw error;
                rows.push(...(data || []));
                if (!data?.length || data.length < 40) break;
                const next = data.at(-1).trade_date;
                if (next === after) throw syncError('Не вдалося завантажити повний журнал.', 'INVALID_SYNC_RESPONSE');
                after = next;
            } finally { clearTimeout(timeout); }
        }
        return rows;
    },
};

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('strum-data-sync-v2') : null;
const engine = createDataSyncEngine({ transport,
    onState: (state, detail) => publishSyncState(state, detail),
    onChange: async (userId, changes) => {
        await handlers.onChange?.(userId, changes);
        channel?.postMessage({ type: 'changed', userId });
    },
    onSnapshot: (userId, records, settings, metadata) => handlers.onSnapshot?.(userId, records, settings, metadata),
    lock: globalThis.navigator?.locks
        ? (userId, run) => navigator.locks.request(`strum-data-sync:${userId}`, { mode: 'exclusive' }, run)
        : null,
    conflictPolicy: 'local',
});

export function setDataSyncHandlers(value) { handlers = value; }
export function beginDataSync(userId) { activeUserId = userId || null; engine.start(activeUserId); }
export function stopDataSync() { activeUserId = null; engine.stop(); }
export function notifyDataSync() { engine.notify(); channel?.postMessage({ type: 'pending', userId: activeUserId }); }
export const flushDataSync = () => engine.flush();
export const syncDataNow = () => engine.sync();
export const refreshDataSnapshot = () => engine.refreshSnapshot();
export const getCachedSyncEpoch = async userId => (await readSyncMetadata(userId))?.epoch ?? null;

export async function ensureDataSyncMetadata(userId) {
    const cached = await readSyncMetadata(userId);
    if (cached?.epoch != null) return cached;
    if (!metadataRequests.has(userId)) {
        metadataRequests.set(userId, (async () => {
            const data = await transport.metadata(userId);
            if (data.epoch == null) throw syncError('Спочатку оновіть схему надійного збереження бази.', 'SYNC_SCHEMA_REQUIRED');
            await cacheValue(userId, 'settings', data.settings || {}, { version: data.settingsVersion });
            return saveSyncMetadata(userId, { ...data, initialized: false });
        })().finally(() => metadataRequests.delete(userId)));
    }
    return metadataRequests.get(userId);
}

if (channel) channel.onmessage = event => {
    if (event.data?.userId !== activeUserId) return;
    if (event.data.type === 'pending') engine.notify();
    if (event.data.type === 'changed') void handlers.onOtherTab?.(activeUserId);
};
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { if (activeUserId) engine.notify(); });
    window.addEventListener('offline', () => void engine.status().catch(() => {}));
    window.addEventListener('focus', () => { if (activeUserId) engine.notify(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && activeUserId) engine.notify(); });
}
