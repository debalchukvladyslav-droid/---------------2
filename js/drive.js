// === js/drive.js ===
import { state } from './state.js';
import { saveSettings } from './storage.js';
import { loadImages } from './gallery.js';
import { showToast } from './utils.js';
import { ensureSupabaseStorageUser, uploadToSupabaseStorage } from './supabase_storage.js';
import { buildScreenshotPath, buildScreenshotPathVariants } from './storage_paths.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { ensureGoogleApi, ensureGoogleIdentity } from './vendor_loader.js';

const appConfig = window.TRADING_JOURNAL_CONFIG || {};
const CLIENT_ID = String(appConfig.googleDriveClientId || appConfig.googleSheetsClientId || '').trim();
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const DRIVE_FILES_CACHE_TTL = 60 * 1000;

let _tokenClient = null;
let _accessToken = null;
let _pickerInited = false;
let _gapiInited = false;
let _gsiIniting = null;
let _syncInProgress = false;
let _driveFilesCache = null;

function driveScreenMetaFromFile(file, prev = {}) {
    const createdAt = file.createdTime || file.modifiedTime || prev.createdAt || new Date().toISOString();
    return {
        ...prev,
        source: 'drive',
        createdAt,
        driveCreatedTime: file.createdTime || null,
        driveModifiedTime: file.modifiedTime || null,
        driveId: file.id,
        driveName: file.name,
    };
}

function upsertDriveScreenMeta(storagePath, file) {
    if (!storagePath || !file?.id) return false;
    if (!state.appData.screenMeta || typeof state.appData.screenMeta !== 'object') state.appData.screenMeta = {};
    const prev = state.appData.screenMeta[storagePath] || {};
    const next = driveScreenMetaFromFile(file, prev);
    const changed = JSON.stringify(prev) !== JSON.stringify(next);
    if (changed) state.appData.screenMeta[storagePath] = next;
    return changed;
}

function driveAccessTokenStorageKey() {
    return state.myUserId ? `pj:driveAT:${state.myUserId}` : null;
}

function driveGrantStorageKey() {
    return state.myUserId ? `pj:driveGrant:${state.myUserId}` : null;
}

function persistDriveAccessToken(token, expiresInSec) {
    const k = driveAccessTokenStorageKey();
    if (!k || !token) return;
    const sec = Math.max(120, Number(expiresInSec) || 3600);
    const expiresAt = Date.now() + sec * 1000 - 90_000;
    try {
        localStorage.setItem(k, JSON.stringify({ token, expiresAt }));
        const grantKey = driveGrantStorageKey();
        if (grantKey) localStorage.setItem(grantKey, '1');
    } catch (_) {}
}

function clearDriveAccessTokenStorage() {
    const k = driveAccessTokenStorageKey();
    if (k) {
        try {
            localStorage.removeItem(k);
        } catch (_) {}
    }
}

function clearDriveGrantStorage() {
    clearDriveAccessTokenStorage();
    const k = driveGrantStorageKey();
    if (k) {
        try {
            localStorage.removeItem(k);
        } catch (_) {}
    }
}

function hasPreviousDriveGrant() {
    const k = driveGrantStorageKey();
    return !!(k && localStorage.getItem(k) === '1');
}

/** Відновлює OAuth access token після перезавантаження (поки не прострочений). */
export async function tryRestoreDriveToken() {
    if (_accessToken) return true;
    const k = driveAccessTokenStorageKey();
    if (!k) return false;
    try {
        const raw = localStorage.getItem(k);
        if (!raw) return false;
        const { token, expiresAt } = JSON.parse(raw);
        if (!token || !expiresAt || Date.now() >= expiresAt) {
            localStorage.removeItem(k);
            return false;
        }
        _accessToken = token;
        return true;
    } catch {
        return false;
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function initGapi() {
    if (_gapiInited) return;
    await ensureGoogleApi();
    if (typeof gapi === 'undefined') throw new Error('Google API не завантажився.');
    await new Promise(resolve => gapi.load('client:picker', resolve));
    await gapi.client.init({ discoveryDocs: [] });
    _gapiInited = true;
    _pickerInited = true;
}

async function initGsi() {
    if (!CLIENT_ID) throw new Error('Missing googleDriveClientId in config.js.');
    if (_tokenClient) return;
    if (_gsiIniting) return _gsiIniting;
    _gsiIniting = (async () => {
        await ensureGoogleIdentity();
        if (typeof google === 'undefined' || !google.accounts?.oauth2)
            throw new Error('Google Sign-In не завантажився.');
        _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: () => {},
        });
    })();
    return _gsiIniting;
}

function requestNewToken(onSuccess, onError, options = {}) {
    if (!_tokenClient) { onError(new Error('Google Sign-In ще не ініціалізовано. Спробуйте ще раз.')); return; }
    _tokenClient.callback = (resp) => {
        if (resp.error) { onError(new Error(resp.error)); return; }
        _accessToken = resp.access_token;
        persistDriveAccessToken(resp.access_token, resp.expires_in);
        onSuccess(_accessToken);
    };
    _tokenClient.requestAccessToken({ prompt: options.prompt ?? '' });
}

function requestDriveToken(options = {}) {
    return new Promise((resolve, reject) => {
        requestNewToken(resolve, reject, options);
    });
}

export async function connectGoogleDrive() {
    try {
        await Promise.all([initGapi(), initGsi()]);
    } catch (e) {
        showToast('❌ Помилка ініціалізації: ' + (e.message || e));
        return;
    }
    await tryRestoreDriveToken();
    if (_accessToken) { openFolderPicker(_accessToken); return; }
    requestNewToken(
        (token) => openFolderPicker(token),
        (e) => showToast('❌ Помилка авторизації: ' + (e.message || e)),
        { prompt: hasPreviousDriveGrant() ? '' : 'consent' }
    );
}

function openFolderPicker(token) {
    if (typeof google === 'undefined' || !google.picker) throw new Error('Google Picker недоступний.');
    const picker = new google.picker.PickerBuilder()
        .addView(new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setMimeTypes('application/vnd.google-apps.folder'))
        .setOAuthToken(token)
        .setCallback(async (data) => {
            if (data.action === google.picker.Action.PICKED) {
                const folder = data.docs[0];
                state.appData.settings.driveFolderId = folder.id;
                state.appData.settings.driveFolderName = folder.name;
                await saveSettings();
                updateDriveUI();
                showToast(`✅ Папка "${folder.name}" підключена!`);
                await syncDriveScreenshots();
            }
        })
        .build();
    picker.setVisible(true);
}

async function getTokenSilently() {
    if (_accessToken) return _accessToken;
    return await tryRestoreDriveToken() ? _accessToken : null;
}

export async function syncDriveScreenshots(silent = false) {
    if (_syncInProgress) return;
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) return;
    const folderId = state.appData?.settings?.driveFolderId;
    if (!folderId) return;

    _syncInProgress = true;
    showGlobalLoader('drive-sync', 'Синхронізація Google Drive...');
    const statusEl = document.getElementById('drive-sync-status');
    if (statusEl) statusEl.textContent = '⏳ Синхронізація...';

    try {
        const token = await getTokenSilently();
        if (!token) {
            if (statusEl) statusEl.textContent = '⚠️ Потрібна авторизація';
            hideGlobalLoader('drive-sync');
            return;
        }
        _accessToken = token;
        const storageUser = await ensureSupabaseStorageUser();
        state.myUserId = storageUser.id;

        let files;
        if (_driveFilesCache && Date.now() - _driveFilesCache.ts < DRIVE_FILES_CACHE_TTL) {
            files = _driveFilesCache.files;
        } else {
            const listUrl = new URL('https://www.googleapis.com/drive/v3/files');
            listUrl.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/'`);
            listUrl.searchParams.set('fields', 'files(id,name,mimeType,createdTime,modifiedTime,size)');
            listUrl.searchParams.set('orderBy', 'modifiedTime desc');
            listUrl.searchParams.set('pageSize', '100');
            const resp = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
            const data = await resp.json();
            if (resp.status === 401 || resp.status === 403) {
                _accessToken = null;
                clearDriveAccessTokenStorage();
                if (statusEl) statusEl.textContent = 'Google Drive: потрібна авторизація';
                if (!silent) showToast('Google Drive сесія закінчилась. Підключіть Drive знову кнопкою.');
                hideGlobalLoader('drive-sync');
                return;
            }
            if (!data.files) {
                if (statusEl) statusEl.textContent = '⚠️ Помилка отримання файлів';
                showGlobalLoader('drive-sync', 'Помилка отримання файлів', { type: 'error' });
                hideGlobalLoader('drive-sync', 2600);
                return;
            }
            files = data.files;
            _driveFilesCache = { files, ts: Date.now() };
        }

        const existingPaths = new Set(state.appData.unassignedImages || []);
        const ignored = new Set(state.appData?.settings?.driveIgnored || []);
        for (const day of Object.values(state.appData.journal || {})) {
            for (const arr of Object.values(day.screenshots || {})) {
                for (const p of arr) existingPaths.add(p);
            }
        }

        const fileRecords = files.map(file => {
            if (!/^[a-zA-Z0-9_-]+$/.test(file.id)) return null;
            const variants = buildScreenshotPathVariants(`${file.id}_${file.name}`);
            const existingPath = variants.find(path => existingPaths.has(path)) || '';
            return {
                file,
                variants,
                existingPath,
                storagePath: existingPath || buildScreenshotPath(`${file.id}_${file.name}`),
            };
        }).filter(Boolean);

        let metaUpdatedCount = 0;
        for (const record of fileRecords) {
            if (!record.existingPath || ignored.has(record.existingPath)) continue;
            if (upsertDriveScreenMeta(record.existingPath, record.file)) metaUpdatedCount++;
        }

        const newFiles = fileRecords.filter(record =>
            !record.existingPath && record.variants.every(path => !ignored.has(path))
        );

        let newCount = 0;
        let failedCount = 0;
        await Promise.all(newFiles.map(async ({ file, storagePath }) => {
            if (file.size && parseInt(file.size) > MAX_FILE_SIZE_BYTES) {
                console.warn(`Drive: пропускаємо ${file.name} — розмір перевищує ліміт`);
                return;
            }
            try {
                const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}`);
                fileUrl.searchParams.set('alt', 'media');
                const fileResp = await fetch(fileUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
                if (!fileResp.ok) {
                    throw new Error(`Drive download failed (${fileResp.status})`);
                }
                const blob = await fileResp.blob();
                if (blob.size > MAX_FILE_SIZE_BYTES) {
                    console.warn(`Drive: пропускаємо ${file.name} — blob перевищує ліміт`);
                    return;
                }
                await uploadToSupabaseStorage(storagePath, blob, {
                    bucket: 'screenshots',
                    contentType: blob.type || file.mimeType || 'application/octet-stream',
                });
                if (!state.appData.unassignedImages) state.appData.unassignedImages = [];
                state.appData.unassignedImages.push(storagePath);
                upsertDriveScreenMeta(storagePath, file);
                newCount++;
                if (statusEl) statusEl.textContent = `⏳ Завантажено ${newCount}...`;
                showGlobalLoader('drive-sync', `Завантажено ${newCount}...`);
            } catch (error) {
                failedCount++;
                console.warn('[Drive] screenshot upload skipped', {
                    id: file.id,
                    name: file.name,
                    storagePath,
                    message: error?.message || String(error),
                });
            }
        }));

        if (metaUpdatedCount > 0) {
            console.log('[Drive] updated screenshot dates from Google Drive metadata:', metaUpdatedCount);
        }

        if (newCount > 0 || metaUpdatedCount > 0) {
            _driveFilesCache = null;
            await saveSettings();
            if (newCount > 0) loadImages();
        }

        if (failedCount > 0) {
            const message = `Google Drive: не завантажено ${failedCount} скрінів у Supabase Storage`;
            showGlobalLoader('drive-sync', message, { type: newCount > 0 ? 'warning' : 'error' });
            hideGlobalLoader('drive-sync', 2600);
            if (statusEl) statusEl.textContent = `⚠️ Не завантажено ${failedCount}`;
            if (!silent) showToast(message);
        } else if (newCount > 0) {
            showGlobalLoader('drive-sync', `Синхронізовано ${newCount} скрінів`, { type: 'success' });
            hideGlobalLoader('drive-sync', 1400);
            showToast(`✅ Синхронізовано ${newCount} нових скрінів!`);
        } else if (metaUpdatedCount > 0 && !silent) {
            showGlobalLoader('drive-sync', `Оновлено дати ${metaUpdatedCount} скрінів`, { type: 'success' });
            hideGlobalLoader('drive-sync', 1200);
            showToast(`✅ Оновлено дати ${metaUpdatedCount} скрінів з Google Drive`);
        } else if (!silent) {
            showGlobalLoader('drive-sync', 'Нових скрінів немає', { type: 'success' });
            hideGlobalLoader('drive-sync', 1200);
            showToast('✅ Нових скрінів немає');
        } else {
            hideGlobalLoader('drive-sync');
        }

        if (!failedCount && statusEl) statusEl.textContent = newCount > 0
            ? `✅ +${newCount} нових`
            : metaUpdatedCount > 0 ? `✅ Дати +${metaUpdatedCount}` : '✅ Актуально';
    } catch (e) {
        console.error('Drive sync error:', e);
        showGlobalLoader('drive-sync', 'Помилка синхронізації', { type: 'error' });
        hideGlobalLoader('drive-sync', 2600);
        if (statusEl) statusEl.textContent = '❌ Помилка синхронізації';
        showToast('❌ Помилка: ' + e.message);
    } finally {
        _syncInProgress = false;
    }
}

export function updateDriveUI() {
    const btn = document.getElementById('drive-connect-btn');
    const info = document.getElementById('drive-folder-info');
    const disconnectBtn = document.getElementById('drive-disconnect-btn');
    if (!btn) return;

    const folderId = state.appData.settings.driveFolderId;
    const folderName = state.appData.settings.driveFolderName;

    if (folderId) {
        btn.textContent = '🔄 Змінити папку';
        btn.style.background = 'rgba(16,185,129,0.15)';
        btn.style.borderColor = 'var(--profit)';
        btn.style.color = 'var(--profit)';
        if (info) info.textContent = `📁 ${folderName || folderId}`;
        if (disconnectBtn) disconnectBtn.classList.remove('initially-hidden');
    } else {
        btn.textContent = '🔗 Підключити Google Drive';
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
        if (info) info.textContent = '';
        if (disconnectBtn) disconnectBtn.classList.add('initially-hidden');
    }
}

let _autoSyncInterval = null;
export function startDriveAutoSync() {
    if (_autoSyncInterval) clearInterval(_autoSyncInterval);
    _autoSyncInterval = setInterval(() => {
        if (!document.getElementById('view-screens')?.classList.contains('active')) return;
        if (document.visibilityState !== 'visible') return;
        if (state.appData?.settings?.driveFolderId &&
            state.CURRENT_VIEWED_USER === state.USER_DOC_NAME &&
            !_syncInProgress) {
            syncDriveScreenshots(true);
        }
    }, 30000);
}

export async function disconnectGoogleDrive() {
    if (_accessToken && typeof google !== 'undefined' && google.accounts?.oauth2) {
        google.accounts.oauth2.revoke(_accessToken);
    }
    _accessToken = null;
    clearDriveGrantStorage();
    _driveFilesCache = null;
    state.appData.settings.driveFolderId = null;
    state.appData.settings.driveFolderName = null;
    await saveSettings();
    updateDriveUI();
    loadImages();
    showToast('✅ Google Drive відключено');
}
