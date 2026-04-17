import { state } from './state.js';

function currentNick() {
    return String(state.USER_DOC_NAME || '').replace(/_stats$/, '').trim();
}

function sanitizeStorageName(name) {
    return String(name || 'file')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 160);
}

export function getCurrentStorageOwnerKey() {
    return state.myUserId || currentNick() || 'unknown-user';
}

export function buildScreenshotPath(fileName) {
    return `screenshots/${getCurrentStorageOwnerKey()}/${sanitizeStorageName(fileName)}`;
}

export function buildLegacyScreenshotPath(fileName) {
    return `screenshots/${currentNick() || getCurrentStorageOwnerKey()}/${sanitizeStorageName(fileName)}`;
}

export function buildScreenshotPathVariants(fileName) {
    const primary = buildScreenshotPath(fileName);
    const legacy = buildLegacyScreenshotPath(fileName);
    return primary === legacy ? [primary] : [primary, legacy];
}
