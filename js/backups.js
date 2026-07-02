import { state } from './state.js';
import { normalizeAppData } from './data_utils.js';

const BACKUP_VERSION = 1;
const BACKUP_PREFIX = 'tj:compressed-backups:v1';
const MAX_BACKUPS = 12;
const MIN_AUTO_BACKUP_INTERVAL_MS = 2 * 60 * 1000;

function backupOwnerKey() {
    return state.myUserId || state.USER_DOC_NAME || 'anonymous';
}

function storageKey() {
    return `${BACKUP_PREFIX}:${backupOwnerKey()}`;
}

function backupNick() {
    return String(state.USER_DOC_NAME || state.CURRENT_VIEWED_USER || 'profile').replace(/_stats$/, '') || 'profile';
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function gzipText(text) {
    if (typeof CompressionStream === 'undefined') {
        return { encoding: 'plain-base64', data: bytesToBase64(new TextEncoder().encode(text)) };
    }
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    return { encoding: 'gzip-base64', data: bytesToBase64(new Uint8Array(buffer)) };
}

async function gunzipText(entry) {
    const bytes = base64ToBytes(entry?.data || '');
    if (entry?.encoding !== 'gzip-base64') {
        return new TextDecoder().decode(bytes);
    }
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot read compressed backups');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

function readBackupEntries() {
    try {
        const raw = localStorage.getItem(storageKey());
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.data) : [];
    } catch {
        return [];
    }
}

function writeBackupEntries(entries) {
    const clean = entries.slice(0, MAX_BACKUPS);
    try {
        localStorage.setItem(storageKey(), JSON.stringify(clean));
        return clean;
    } catch (error) {
        if (clean.length <= 1) throw error;
        return writeBackupEntries(clean.slice(0, -1));
    }
}

function estimateBytes(text) {
    return new TextEncoder().encode(String(text || '')).length;
}

function buildBackupPayload(reason = 'manual') {
    return {
        version: BACKUP_VERSION,
        reason,
        createdAt: new Date().toISOString(),
        userDocName: state.USER_DOC_NAME,
        currentViewedUser: state.CURRENT_VIEWED_USER,
        myUserId: state.myUserId,
        appData: state.appData || {},
    };
}

function shouldSkipAutoBackup(entries, reason) {
    if (reason === 'manual') return false;
    const latest = entries[0];
    if (!latest) return false;
    if (latest.reason !== reason && latest.reason !== 'manual-sync' && reason !== 'sync') return false;
    const lastMs = Date.parse(latest.createdAt || '');
    return Number.isFinite(lastMs) && Date.now() - lastMs < MIN_AUTO_BACKUP_INTERVAL_MS;
}

export async function createCompressedBackup(options = {}) {
    const reason = options.reason || 'manual';
    const existing = readBackupEntries();
    if (!options.force && shouldSkipAutoBackup(existing, reason)) return existing[0] || null;

    const payload = buildBackupPayload(reason);
    const json = JSON.stringify(payload);
    const compressed = await gzipText(json);
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        version: BACKUP_VERSION,
        reason,
        nick: backupNick(),
        createdAt: payload.createdAt,
        userDocName: payload.userDocName,
        encoding: compressed.encoding,
        data: compressed.data,
        rawBytes: estimateBytes(json),
        storedBytes: estimateBytes(compressed.data),
        days: Object.keys(payload.appData?.journal || {}).filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)).length,
    };
    writeBackupEntries([entry, ...existing.filter((item) => item.id !== entry.id)]);
    return entry;
}

export function listCompressedBackups() {
    return readBackupEntries();
}

export async function readCompressedBackup(id) {
    const entry = readBackupEntries().find((item) => item.id === id);
    if (!entry) throw new Error('Backup not found');
    return readCompressedBackupEntry(entry);
}

export async function readCompressedBackupEntry(entry) {
    const text = await gunzipText(entry);
    const payload = JSON.parse(text);
    if (!payload?.appData || typeof payload.appData !== 'object') {
        throw new Error('Backup file is invalid');
    }
    return { entry, payload };
}

export async function restoreCompressedBackup(id) {
    const { payload } = await readCompressedBackup(id);
    state.appData = normalizeAppData(payload.appData);
    return payload;
}

export async function restoreCompressedBackupEntry(entry) {
    const { payload } = await readCompressedBackupEntry(entry);
    state.appData = normalizeAppData(payload.appData);
    return payload;
}

export function deleteCompressedBackup(id) {
    writeBackupEntries(readBackupEntries().filter((item) => item.id !== id));
}

export function downloadCompressedBackup(id) {
    const entry = readBackupEntries().find((item) => item.id === id);
    if (!entry) throw new Error('Backup not found');
    const blob = new Blob([JSON.stringify(entry)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup_${entry.nick || 'journal'}_${String(entry.createdAt || '').replace(/[:.]/g, '-')}.tjbackup.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
