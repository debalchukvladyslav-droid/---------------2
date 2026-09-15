import { state } from './state.js';
import { supabase } from './supabase.js';

const BACKUP_PREFIX = 'tj:compressed-backups:v1';
let serverBackupsCache = [];
let serverBackupsLoadedFor = '';
function assertContext(userId) { if (state.myUserId !== userId) throw new Error('Обліковий запис змінився. Відкрийте список копій заново.'); }
async function getServerBackupUserId() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    const authenticatedUserId = data?.user?.id || '';
    if (!authenticatedUserId) throw new Error('Увійдіть, щоб отримати резервні копії.');
    assertContext(authenticatedUserId);
    return authenticatedUserId;
}
async function rpc(name, args = {}) { const { data, error } = await supabase.rpc(name, args); if (error) throw error; return data; }
function readLocalEntries() {
    try { return JSON.parse(localStorage.getItem(`${BACKUP_PREFIX}:${state.myUserId}`) || '[]').filter(entry => entry?.id && entry?.data); }
    catch { return []; }
}
function pointEntry(point) {
    return { ...point, version: 2, serverUserId: point.userId, serverBackedUp: true,
        days: point.counts?.journal_days || 0, encoding: 'server-snapshot', nick: String(state.USER_DOC_NAME || 'journal').replace(/_stats$/, '') };
}
function legacyEntry(row) {
    return { ...row.backup_data, id: row.backup_id, serverUserId: row.user_id, serverBackedUp: true, version: 1,
        reason: row.reason || 'legacy', createdAt: row.backup_created_at || row.created_at, days: row.days,
        encoding: row.encoding, storedBytes: row.stored_bytes, rawBytes: row.raw_bytes, incomplete: true };
}
export async function createCompressedBackup(options = {}) {
    const owner = await getServerBackupUserId();
    const reason = options.reason || 'manual';
    const last = serverBackupsLoadedFor === owner ? serverBackupsCache[0] : null;
    if (!options.force && last?.version === 2 && Date.now() - Date.parse(last.createdAt) < 120000) return last;
    const entry = pointEntry(await rpc('create_restore_point', { p_reason: reason, p_user_id: owner }));
    assertContext(owner);
    if (serverBackupsLoadedFor !== owner) serverBackupsCache = [];
    serverBackupsLoadedFor = owner;
    serverBackupsCache = [entry, ...serverBackupsCache].slice(0, 200);
    return entry;
}
export function listCompressedBackups() {
    const remote = serverBackupsLoadedFor === state.myUserId ? serverBackupsCache : [];
    return [...remote, ...readLocalEntries().map(entry => ({ ...entry, incomplete: true }))]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
export async function listServerBackupsForUser(userId, limit = 100) {
    if (!userId) return [];
    const points = await rpc('list_restore_points', { p_user_id: userId, p_limit: Math.min(200, limit) });
    const legacy = await supabase.from('journal_backups')
        .select('backup_id,user_id,reason,backup_created_at,created_at,days,encoding,raw_bytes,stored_bytes')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(Math.min(200, limit));
    if (legacy.error && !['42P01', 'PGRST205'].includes(legacy.error.code)) throw legacy.error;
    return [...(points || []).map(pointEntry), ...(legacy.data || []).map(legacyEntry)]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
export async function refreshServerBackups() {
    const owner = await getServerBackupUserId();
    const entries = await listServerBackupsForUser(owner);
    assertContext(owner); serverBackupsLoadedFor = owner; serverBackupsCache = entries;
    return entries;
}
async function decodeLegacy(entry) {
    if (!entry?.data && entry.serverBackedUp) {
        const result = await supabase.from('journal_backups').select('backup_data')
            .eq('user_id', entry.serverUserId).eq('backup_id', entry.id).single();
        if (result.error) throw result.error;
        entry = { ...entry, ...result.data.backup_data };
    }
    const bytes = Uint8Array.from(atob(String(entry.data || '')), value => value.charCodeAt(0));
    let text;
    if (entry.encoding === 'gzip-base64') {
        if (typeof DecompressionStream === 'undefined') throw new Error('Браузер не підтримує цей стиснений файл.');
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        const chunks = []; let size = 0;
        while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('Розпакована копія перевищує 32 МБ.'); }
            chunks.push(part.value);
        }
        text = await new Blob(chunks).text();
    } else text = new TextDecoder().decode(bytes);
    const payload = JSON.parse(text);
    if (!payload?.appData?.journal || typeof payload.appData.journal !== 'object') throw new Error('Файл не містить журналу.');
    return { entry, payload };
}
export async function readCompressedBackupEntry(entry) {
    if (entry.version === 2) {
        const point = entry.snapshot ? entry : await rpc('get_restore_point', { p_restore_point_id: entry.id, p_user_id: entry.serverUserId || entry.userId });
        return { entry: { ...entry, ...point }, payload: point.snapshot };
    }
    return decodeLegacy(entry);
}
export async function readCompressedBackup(id) {
    let entry = listCompressedBackups().find(item => item.id === id);
    if (!entry) { await refreshServerBackups(); entry = listCompressedBackups().find(item => item.id === id); }
    if (!entry) throw new Error('Копію не знайдено.');
    return readCompressedBackupEntry(entry);
}
export async function prepareBackupRestore(entry, userId = state.myUserId) {
    const { payload } = await readCompressedBackupEntry(entry);
    const point = entry.version === 2 && !entry.importedFile ? entry
        : await rpc(entry.version === 2 ? 'import_restore_point' : 'prepare_legacy_restore',
            entry.version === 2 ? { p_payload: payload, p_user_id: userId } : { p_app_data: payload.appData, p_user_id: userId });
    return rpc('preview_restore', { p_restore_point_id: point.id, p_user_id: userId });
}
export async function restorePreparedBackup(preview, userId = state.myUserId) {
    if (!preview.canRestore) throw new Error('Копія неповна або її файли відсутні. Спочатку відновіть файли з незалежного архіву.');
    const result = await rpc('restore_data', { p_restore_point_id: preview.restorePointId, p_expected_epoch: preview.epoch, p_user_id: userId });
    if (userId === state.myUserId) {
        const { resyncAfterRestore } = await import('./storage.js');
        await resyncAfterRestore(); await refreshServerBackups();
    }
    return result;
}
export async function restoreCompressedBackup(id) {
    const entry = listCompressedBackups().find(item => item.id === id);
    if (!entry) throw new Error('Копію не знайдено.');
    return restorePreparedBackup(await prepareBackupRestore(entry));
}
export async function restoreCompressedBackupEntry(entry) { return restorePreparedBackup(await prepareBackupRestore({ ...entry, importedFile: true })); }
export function deleteCompressedBackup(id) {
    if (serverBackupsCache.some(entry => entry.id === id)) throw new Error('Серверні точки відновлення зберігаються автоматично протягом 30 днів.');
    localStorage.setItem(`${BACKUP_PREFIX}:${state.myUserId}`, JSON.stringify(readLocalEntries().filter(entry => entry.id !== id)));
}
export async function downloadCompressedBackup(id) {
    const owner = state.myUserId;
    const { entry, payload } = await readCompressedBackup(id); assertContext(owner);
    const value = entry.version === 2 ? { ...entry, snapshot: payload } : entry;
    const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `journal_${String(entry.createdAt || '').replace(/[:.]/g, '-')}.tjbackup.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
supabase.auth.onAuthStateChange(() => { serverBackupsCache = []; serverBackupsLoadedFor = ''; });
