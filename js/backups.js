import { state } from './state.js';
import { normalizeAppData } from './data_utils.js';
import { supabase } from './supabase.js';

const BACKUP_VERSION = 1;
const BACKUP_PREFIX = 'tj:compressed-backups:v1';
const MAX_BACKUPS = 12;
const MIN_AUTO_BACKUP_INTERVAL_MS = 2 * 60 * 1000;
let serverBackupsCache = [];
let serverBackupsLoadedFor = '';

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

function mergeBackupEntries(localEntries, remoteEntries) {
    const seen = new Set();
    return [...remoteEntries, ...localEntries]
        .filter((entry) => {
            if (!entry?.id || seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
        })
        .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
        .slice(0, MAX_BACKUPS);
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

function isMissingServerBackupTable(error) {
    const message = String(error?.message || error?.details || error?.hint || '');
    return error?.code === '42P01'
        || error?.code === 'PGRST205'
        || /journal_backups/i.test(message) && /not found|does not exist|schema cache/i.test(message);
}

function normalizeServerBackupError(error) {
    if (isMissingServerBackupTable(error)) {
        return new Error('Server backups table is not installed yet. Run database/security/10_server_journal_backups.sql in Supabase.');
    }
    return error;
}

async function getServerBackupUserId() {
    if (state.myUserId) return state.myUserId;
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    return data?.user?.id || '';
}

function rowToBackupEntry(row) {
    const entry = row?.backup_data && typeof row.backup_data === 'object' ? row.backup_data : {};
    return {
        ...entry,
        id: entry.id || row.backup_id,
        reason: entry.reason || row.reason || 'backup',
        nick: entry.nick || row.nick || backupNick(),
        createdAt: entry.createdAt || row.backup_created_at || row.created_at,
        rawBytes: entry.rawBytes ?? row.raw_bytes,
        storedBytes: entry.storedBytes ?? row.stored_bytes,
        days: entry.days ?? row.days,
        encoding: entry.encoding || row.encoding,
        serverBackedUp: true,
        serverUserId: row.user_id || '',
    };
}

async function saveBackupToServer(entry) {
    const userId = await getServerBackupUserId();
    if (!userId) throw new Error('No authenticated Supabase user for server backup');

    const row = {
        backup_id: entry.id,
        user_id: userId,
        reason: entry.reason || 'backup',
        nick: entry.nick || backupNick(),
        backup_created_at: entry.createdAt,
        backup_data: entry,
        raw_bytes: entry.rawBytes || 0,
        stored_bytes: entry.storedBytes || 0,
        days: entry.days || 0,
        encoding: entry.encoding || '',
    };
    const { error } = await supabase
        .from('journal_backups')
        .upsert(row, { onConflict: 'user_id,backup_id' });
    if (error) throw error;

    serverBackupsCache = mergeBackupEntries([entry], serverBackupsCache).map((item) => (
        item.id === entry.id ? { ...entry, serverBackedUp: true } : item
    ));
    serverBackupsLoadedFor = userId;
    return { ...entry, serverBackedUp: true };
}

async function deleteOldServerBackups(userId) {
    const { data, error } = await supabase
        .from('journal_backups')
        .select('backup_id, backup_created_at, created_at')
        .eq('user_id', userId)
        .order('backup_created_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .range(MAX_BACKUPS, 200);
    if (error || !Array.isArray(data) || !data.length) return;
    const ids = data.map((row) => row.backup_id).filter(Boolean);
    if (!ids.length) return;
    await supabase
        .from('journal_backups')
        .delete()
        .eq('user_id', userId)
        .in('backup_id', ids);
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
    try {
        const serverEntry = await saveBackupToServer(entry);
        const userId = await getServerBackupUserId();
        await deleteOldServerBackups(userId);
        return serverEntry;
    } catch (error) {
        const normalizedError = normalizeServerBackupError(error);
        console.warn('[Backups] server backup failed:', normalizedError?.message || normalizedError);
        if (options.requireServer) throw normalizedError;
        return entry;
    }
}

export function listCompressedBackups() {
    return mergeBackupEntries(readBackupEntries(), serverBackupsCache);
}

export async function refreshServerBackups() {
    const userId = await getServerBackupUserId();
    if (!userId) return [];
    const { data, error } = await supabase
        .from('journal_backups')
        .select('backup_id, user_id, reason, nick, backup_created_at, created_at, raw_bytes, stored_bytes, days, encoding')
        .eq('user_id', userId)
        .order('backup_created_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(MAX_BACKUPS);
    if (error) throw normalizeServerBackupError(error);
    serverBackupsLoadedFor = userId;
    serverBackupsCache = Array.isArray(data) ? data.map(rowToBackupEntry) : [];
    return serverBackupsCache;
}

export async function listServerBackupsForUser(userId, limit = MAX_BACKUPS) {
    if (!userId) return [];
    const safeLimit = Math.min(MAX_BACKUPS, Math.max(1, Number(limit) || 4));
    const { data, error } = await supabase
        .from('journal_backups')
        .select('backup_id, user_id, reason, nick, backup_created_at, created_at, raw_bytes, stored_bytes, days, encoding')
        .eq('user_id', userId)
        .order('backup_created_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(safeLimit);
    if (error) throw normalizeServerBackupError(error);
    return Array.isArray(data) ? data.map(rowToBackupEntry) : [];
}

export async function readCompressedBackup(id) {
    let entry = listCompressedBackups().find((item) => item.id === id);
    if (!entry) {
        await refreshServerBackups();
        entry = listCompressedBackups().find((item) => item.id === id);
    }
    if (!entry) throw new Error('Backup not found');
    return readCompressedBackupEntry(await hydrateServerBackup(entry));
}

async function hydrateServerBackup(entry) {
    if (entry?.data) return entry;
    if (!entry?.id || !entry?.serverBackedUp) throw new Error('Backup data is unavailable');
    const userId = entry.serverUserId || await getServerBackupUserId();
    let query = supabase.from('journal_backups').select('backup_data').eq('backup_id', entry.id);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.single();
    if (error) throw normalizeServerBackupError(error);
    const hydrated = rowToBackupEntry({ ...entry, user_id: userId, backup_data: data?.backup_data });
    serverBackupsCache = serverBackupsCache.map((item) => item.id === hydrated.id ? hydrated : item);
    return hydrated;
}

export async function readCompressedBackupEntry(entry) {
    entry = await hydrateServerBackup(entry);
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
    serverBackupsCache = serverBackupsCache.filter((item) => item.id !== id);
    getServerBackupUserId()
        .then((userId) => userId
            ? supabase.from('journal_backups').delete().eq('user_id', userId).eq('backup_id', id)
            : null)
        .catch((error) => console.warn('[Backups] server delete failed:', error?.message || error));
}

export async function downloadCompressedBackup(id) {
    let entry = listCompressedBackups().find((item) => item.id === id);
    if (!entry) throw new Error('Backup not found');
    entry = await hydrateServerBackup(entry);
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
