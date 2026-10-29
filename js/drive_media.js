import { state } from './state.js';
import { fetchWithSession } from './authenticated_fetch.js';

const loaded = new Map();
const pending = new Map();
let generation = 0;

export function clearDriveMediaUrls() {
    generation++;
    for (const url of loaded.values()) URL.revokeObjectURL(url);
    loaded.clear();
    pending.clear();
}

export async function getDriveMediaUrl(path, revision = '') {
    const owner = state.myUserId;
    if (!owner) return '';
    const key = `${owner}:${path}:${revision}`;
    if (loaded.has(key)) return loaded.get(key);
    if (pending.has(key)) return pending.get(key);
    const started = generation;
    const task = (async () => {
        const cacheKey = new URL(`/__drive_screenshot_cache__?${new URLSearchParams({ path, revision })}`, location.origin).href;
        const cache = await globalThis.caches?.open(`strum-drive-media-v1:${owner}`).catch(() => null);
        let response = await cache?.match(cacheKey).catch(() => null);
        if (!response) {
            response = await fetchWithSession(`/api/drive-service?${new URLSearchParams({ action: 'screenshot', path, revision })}`);
            if (!response.ok) return '';
            if (cache) {
                await cache.put(cacheKey, response.clone()).catch(() => {});
                const keys = await cache.keys().catch(() => []);
                // Device cache only; it consumes no Supabase quota.
                await Promise.all(keys.slice(0, Math.max(0, keys.length - 80)).map(request => cache.delete(request)));
            }
        }
        const blob = await response.blob();
        if (started !== generation || owner !== state.myUserId) return '';
        if (!blob.type.startsWith('image/')) return '';
        const url = URL.createObjectURL(blob);
        loaded.set(key, url);
        return url;
    })().finally(() => { if (pending.get(key) === task) pending.delete(key); });
    pending.set(key, task);
    return task;
}
