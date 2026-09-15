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
export const syncError = (message, code = 'SYNC_FAILED', detail = {}) => Object.assign(new Error(message), { code, ...detail });
export const retryDelay = (attempt = 0, random = Math.random) => Math.round(Math.min(60000, 1000 * (2 ** Math.min(attempt, 6))) * (0.75 + random() * 0.5));
export function isRetryableSyncError(error) {
    const status = Number(error?.status || 0);
    return !['PGRST202', '42883', '42501', 'SYNC_SCHEMA_REQUIRED', 'SYNC_CONFLICT', 'STALE_EPOCH', '22023', '23514'].includes(String(error?.code || ''))
        && status !== 401 && status !== 403 && !(status >= 400 && status < 429);
}
