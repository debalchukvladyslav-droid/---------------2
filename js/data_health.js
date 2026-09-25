import { supabase } from './supabase.js';
import { state } from './state.js';
import { listDataOperations } from './local_data_store.js';
import { listPendingUploads, resumePendingUploads } from './durable_uploads.js';

let initialized = false;
let refreshing = false;
const text = (tag, value) => { const element = document.createElement(tag); element.textContent = value; return element; };
function downloadDrafts(operations) {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), userId: state.myUserId, operations }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'journal-pending-changes.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function button(label, handler) {
    const element = text('button', label); element.type = 'button'; element.className = 'btn-secondary';
    element.addEventListener('click', async () => {
        element.disabled = true;
        try { await handler(); await refreshDataHealth(); }
        catch (error) { element.parentElement.appendChild(text('p', error.message)); }
        finally { element.disabled = false; }
    });
    return element;
}
function settingsVisible() {
    return document.getElementById('view-settings')?.classList.contains('active');
}
export async function refreshDataHealth() {
    const anchor = document.getElementById('settings-backup-list');
    if (!anchor || !state.myUserId || refreshing || !settingsVisible()) return;
    const userId = state.myUserId;
    refreshing = true;
    try {
        const [healthResult, operations, uploads, jobsResult] = await Promise.all([
            supabase.rpc('get_data_health'), listDataOperations(userId), listPendingUploads(),
            supabase.from('source_sync_jobs').select('status,last_error,updated_at').eq('user_id', userId),
        ]);
        if (userId !== state.myUserId) return;
        let panel = document.getElementById('data-health-panel');
        if (!panel) { panel = document.createElement('section'); panel.id = 'data-health-panel'; panel.className = 'settings-backup-panel'; anchor.parentElement.appendChild(panel); }
        panel.replaceChildren(text('h4', 'Збереження та відновлення'));
        panel.appendChild(text('p', `Очікує збереження: ${operations.length} змін · завантаження: ${uploads.length} файлів`));
        const health = healthResult.data;
        const unavailable = Boolean(healthResult.error || health?.unavailable);
        const copied = health?.offsite?.completedAt;
        const stale = !copied || Date.now() - Date.parse(copied) > 26 * 3600000;
        panel.appendChild(text('p', unavailable ? 'Стан серверних копій наразі недоступний.'
            : !copied ? 'Незалежну копію ще не підтверджено. Потрібне початкове підключення архіву.'
                : `${stale ? 'Потрібна увага: ' : ''}Остання незалежна копія: ${new Date(copied).toLocaleString('uk-UA')}`));
        panel.appendChild(text('p', `Історія змін та кошик: 30 днів. ${!unavailable && health?.lastRestorePointAt ? 'Остання серверна точка: ' + new Date(health.lastRestorePointAt).toLocaleString('uk-UA') : ''}`));
        if (!unavailable && health?.usage) panel.appendChild(text('p', `Використання: база ${formatBytes(health.usage.databaseBytes)} · файли профілю ${formatBytes(health.usage.storageBytes)}.`));
        const failedJobs = (jobsResult.data || []).filter(job => job.status === 'error' || (job.status === 'running' && Date.now() - Date.parse(job.updated_at) > 10 * 60000));
        if (failedJobs.length) panel.appendChild(text('p', `Потребують уваги підключення Google: ${failedJobs.length}. ${failedJobs[0].last_error || 'Завдання затрималося.'}`));
        panel.appendChild(button('Повторити передачу', async () => {
            const { syncDataNow } = await import('./storage.js'); await syncDataNow(); await resumePendingUploads();
        }));
        if (operations.length) panel.appendChild(button('Завантажити незавершені правки', () => downloadDrafts(operations)));
        for (const operation of operations.filter(op => ['conflict', 'stale_epoch', 'blocked'].includes(op.status))) {
            const item = document.createElement('details');
            item.appendChild(text('summary', `${operation.domain === 'journal' ? 'Журнал ' + operation.entityId : 'Налаштування'} · ${operation.status === 'stale_epoch' ? 'правка до відновлення' : 'потребує узгодження'}`));
            item.appendChild(text('p', 'Порівняйте свою правку з серверними даними перед вибором.'));
            const names = { screenMeta: 'Метадані скріншотів', unassignedImages: 'Неприв’язані скріншоти', screenTags: 'Теги скріншотів' };
            item.appendChild(text('p', 'Змінені поля: ' + Object.keys(operation.patch || {}).map(key => names[key] || key).join(', ')));
            if (operation.lastError?.message) item.appendChild(text('p', operation.lastError.message));
            item.appendChild(text('pre', JSON.stringify({ 'Було': operation.base, 'Моя правка': operation.patch, 'На сервері': operation.remote }, null, 2)));
            item.appendChild(button('Залишити мою правку', async () => { const { resolveSyncIssue } = await import('./storage.js'); await resolveSyncIssue(operation.operationId, 'local'); }));
            item.appendChild(button('Прийняти серверні дані', async () => { const { resolveSyncIssue } = await import('./storage.js'); await resolveSyncIssue(operation.operationId, 'server'); }));
            panel.appendChild(item);
        }
        for (const upload of uploads.filter(job => job.needsAttention)) panel.appendChild(text('p', `${upload.name}: ${upload.lastError}`));
    } finally { refreshing = false; }
}
function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} Б`;
    const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}
export function initDataHealth() {
    if (initialized) return; initialized = true;
    const refresh = () => { if (settingsVisible()) void refreshDataHealth().catch(error => console.warn('[Data health]', error.message)); };
    document.addEventListener('strum:sync-state', refresh);
    document.addEventListener('strum:upload-state', refresh);
    window.addEventListener('focus', refresh);
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    const view = document.getElementById('view-settings');
    if (view) {
        const observer = new MutationObserver(refresh);
        observer.observe(view, { attributes: true, attributeFilter: ['class'] });
    }
    refresh();
}
