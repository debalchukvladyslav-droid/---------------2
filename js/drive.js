// === js/drive.js ===
import { state } from './state.js';
import { saveSettings } from './storage.js';
import { loadImages } from './gallery.js';
import { setCopyableText, showToast } from './utils.js';
import { ensureSupabaseStorageUser, uploadToSupabaseStorage } from './supabase_storage.js';
import { buildScreenshotPath, buildScreenshotPathVariants } from './storage_paths.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { ensureGoogleApi, ensureGoogleIdentity } from './vendor_loader.js';
import { supabase } from './supabase.js';

const appConfig = window.TRADING_JOURNAL_CONFIG || {};
const CLIENT_ID = String(appConfig.googleDriveClientId || appConfig.googleSheetsClientId || '').trim();
const SERVICE_ACCOUNT_EMAIL = String(appConfig.googleServiceAccountEmail || '').trim();
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
let _serviceDriveAvailable = true;

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

async function getSupabaseAccessToken() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data?.session?.access_token || '';
}

async function fetchServiceDriveJson(params) {
    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) throw new Error('Supabase session expired');
    const url = new URL('/api/drive-service', window.location.origin);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    console.info('[Drive test] service request:', {
        action: params.action || 'list',
        folderId: params.folderId || '',
    });
    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => ({}));
    console.info('[Drive test] service response:', {
        action: params.action || 'list',
        status: response.status,
        ok: response.ok && data.ok !== false,
        files: Array.isArray(data.files) ? data.files.length : undefined,
        error: data.error || '',
    });
    if (!response.ok || data.ok === false) {
        const error = new Error(data.error || `Drive service ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

async function fetchServiceDriveBlob(fileId) {
    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) throw new Error('Supabase session expired');
    const url = new URL('/api/drive-service', window.location.origin);
    url.searchParams.set('action', 'media');
    url.searchParams.set('fileId', fileId);
    console.info('[Drive test] media request:', { fileId });
    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.info('[Drive test] media response:', {
        fileId,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') || '',
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data.error || `Drive service ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return await response.blob();
}

async function listDriveFilesViaService(folderId) {
    const data = await fetchServiceDriveJson({ action: 'list', folderId });
    return data.files || [];
}

function setDriveServiceStatus(message, type = '') {
    const status = document.getElementById('drive-service-status');
    if (!status) return;
    status.textContent = message || '';
    status.dataset.state = type;
}

function extractDriveFolderId(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const foldersMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (foldersMatch?.[1]) return foldersMatch[1];
    const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParamMatch?.[1]) return idParamMatch[1];
    return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : '';
}

async function saveServiceFolderFromInput() {
    const input = document.getElementById('drive-service-folder-input');
    const folderId = extractDriveFolderId(input?.value || state.appData?.settings?.driveFolderId || '');
    if (!folderId) return '';
    if (!state.appData.settings) state.appData.settings = {};
    if (state.appData.settings.driveFolderId !== folderId) {
        state.appData.settings.driveFolderId = folderId;
        state.appData.settings.driveFolderName = 'Service account folder';
        _driveFilesCache = null;
        await saveSettings();
        updateDriveUI();
    }
    return folderId;
}

async function syncDriveScreenshotsFromServiceButton() {
    console.info('[Drive test] service sync button clicked');
    setDriveServiceStatus('Готуємо синхронізацію...', 'loading');
    const folderId = await saveServiceFolderFromInput();
    if (!folderId) {
        setDriveServiceStatus('Вставте посилання або ID папки Google Drive.', 'error');
        console.warn('[Drive test] service sync stopped: missing folderId');
        return;
    }
    _serviceDriveAvailable = true;
    await syncDriveScreenshots(false);
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', (event) => {
        const trigger = event.target?.closest?.('[data-action="drive-service-sync"]');
        if (!trigger) return;
        event.preventDefault();
        syncDriveScreenshotsFromServiceButton();
    }, true);
}

export async function syncDriveScreenshots(silent = false) {
    if (_syncInProgress) {
        setDriveServiceStatus('Синхронізація вже виконується...', 'loading');
        console.warn('[Drive test] sync skipped: already in progress');
        return;
    }
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        setDriveServiceStatus('Синхронізація доступна тільки у власному профілі.', 'error');
        console.warn('[Drive test] sync skipped: not own profile', {
            userDoc: state.USER_DOC_NAME,
            currentView: state.CURRENT_VIEWED_USER,
        });
        return;
    }
    const folderId = state.appData?.settings?.driveFolderId;
    if (!folderId) {
        setDriveServiceStatus('Вставте посилання або ID папки Google Drive.', 'error');
        console.warn('[Drive test] sync skipped: missing folderId');
        return;
    }

    console.groupCollapsed('[Drive test] sync start');
    console.info('[Drive test] context:', {
        silent,
        folderId,
        userDoc: state.USER_DOC_NAME,
        currentView: state.CURRENT_VIEWED_USER,
        myUserId: state.myUserId || '',
        serviceDriveAvailable: _serviceDriveAvailable,
        cacheFresh: !!(_driveFilesCache && Date.now() - _driveFilesCache.ts < DRIVE_FILES_CACHE_TTL),
    });
    _syncInProgress = true;
    showGlobalLoader('drive-sync', 'Синхронізація Google Drive...');
    const statusEl = document.getElementById('drive-sync-status');
    if (statusEl) statusEl.textContent = '⏳ Синхронізація...';
    setDriveServiceStatus('Перевіряємо доступ service account до папки...', 'loading');

    try {
        let token = null;
        const storageUser = await ensureSupabaseStorageUser();
        state.myUserId = storageUser.id;
        console.info('[Drive test] Supabase auth user:', { id: storageUser.id, email: storageUser.email || '' });

        let files;
        let driveFilesViaService = false;
        if (_driveFilesCache && Date.now() - _driveFilesCache.ts < DRIVE_FILES_CACHE_TTL) {
            files = _driveFilesCache.files;
            driveFilesViaService = !!_driveFilesCache.viaService;
            console.info('[Drive test] files loaded from cache:', {
                count: files.length,
                viaService: driveFilesViaService,
            });
        } else {
            let loadedViaService = false;
            if (_serviceDriveAvailable) {
                try {
                    console.info('[Drive test] trying service account list');
                    files = await listDriveFilesViaService(folderId);
                    loadedViaService = true;
                    driveFilesViaService = true;
                    console.info('[Drive test] service account list OK:', { count: files.length });
                    setDriveServiceStatus(`Service account бачить папку: ${files.length} файлів`, 'success');
                } catch (error) {
                    _serviceDriveAvailable = false;
                    console.warn('[Drive] service account list failed, falling back to browser OAuth', error);
                    console.warn('[Drive test] service account list failed:', {
                        status: error?.status || '',
                        message: error?.message || String(error),
                    });
                    setDriveServiceStatus(`Service account не має доступу: ${error?.message || error}`, 'error');
                    if (error.status === 403 || error.status === 404) {
                        const message = 'Google Drive: поширте папку на service account email';
                        if (statusEl) statusEl.textContent = message;
                        if (!silent) showToast(message);
                    }
                }
            }
            if (!loadedViaService) {
                console.info('[Drive test] trying browser OAuth fallback');
                token = await getTokenSilently();
                if (!token) {
                    console.warn('[Drive test] no browser OAuth token; sync stopped');
                    if (statusEl) statusEl.textContent = 'Google Drive: потрібна авторизація або доступ service account до папки';
                    hideGlobalLoader('drive-sync');
                    return;
                }
                _accessToken = token;
                console.info('[Drive test] browser OAuth token restored');
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
                console.info('[Drive test] browser OAuth list OK:', { count: files.length });
                setDriveServiceStatus(`Fallback через Google login: ${files.length} файлів`, 'fallback');
            }
            _driveFilesCache = { files, ts: Date.now(), viaService: driveFilesViaService };
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
        console.info('[Drive test] file decision:', {
            totalFiles: files.length,
            records: fileRecords.length,
            existing: fileRecords.length - newFiles.length,
            newFiles: newFiles.length,
            ignored: ignored.size,
            viaService: driveFilesViaService,
        });

        let newCount = 0;
        let failedCount = 0;
        await Promise.all(newFiles.map(async ({ file, storagePath }) => {
            if (file.size && parseInt(file.size) > MAX_FILE_SIZE_BYTES) {
                console.warn(`Drive: пропускаємо ${file.name} — розмір перевищує ліміт`);
                return;
            }
            try {
                let blob;
                if (driveFilesViaService) {
                    console.info('[Drive test] downloading via service:', { fileId: file.id, name: file.name });
                    blob = await fetchServiceDriveBlob(file.id);
                } else {
                    console.info('[Drive test] downloading via browser OAuth:', { fileId: file.id, name: file.name });
                    const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}`);
                    fileUrl.searchParams.set('alt', 'media');
                    const fileResp = await fetch(fileUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
                    if (!fileResp.ok) {
                        throw new Error(`Drive download failed (${fileResp.status})`);
                    }
                    blob = await fileResp.blob();
                }
                if (blob.size > MAX_FILE_SIZE_BYTES) {
                    console.warn(`Drive: пропускаємо ${file.name} — blob перевищує ліміт`);
                    return;
                }
                await uploadToSupabaseStorage(storagePath, blob, {
                    bucket: 'screenshots',
                    contentType: blob.type || file.mimeType || 'application/octet-stream',
                });
                console.info('[Drive test] uploaded to Supabase:', {
                    name: file.name,
                    storagePath,
                    size: blob.size,
                    contentType: blob.type || file.mimeType || '',
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
        console.info('[Drive test] sync result:', {
            newCount,
            failedCount,
            metaUpdatedCount,
            viaService: driveFilesViaService,
        });
        if (driveFilesViaService) {
            setDriveServiceStatus(
                failedCount > 0
                    ? `Service account працює, але ${failedCount} файлів не завантажилось у Supabase`
                    : `Service account працює. Нових: ${newCount}, оновлено дат: ${metaUpdatedCount}`,
                failedCount > 0 ? 'error' : 'success'
            );
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
        console.error('[Drive test] sync fatal error:', {
            message: e?.message || String(e),
            status: e?.status || '',
        });
        showGlobalLoader('drive-sync', 'Помилка синхронізації', { type: 'error' });
        hideGlobalLoader('drive-sync', 2600);
        if (statusEl) statusEl.textContent = '❌ Помилка синхронізації';
        showToast('❌ Помилка: ' + e.message);
        setDriveServiceStatus(`Помилка синхронізації: ${e.message}`, 'error');
    } finally {
        _syncInProgress = false;
        console.groupEnd();
    }
}

export function updateDriveUI() {
    const btn = document.getElementById('drive-connect-btn');
    const info = document.getElementById('drive-folder-info');
    const disconnectBtn = document.getElementById('drive-disconnect-btn');
    const serviceEmailEl = document.getElementById('drive-service-email');
    const serviceFolderInput = document.getElementById('drive-service-folder-input');
    if (!btn) return;
    if (serviceEmailEl) setCopyableText(serviceEmailEl, SERVICE_ACCOUNT_EMAIL, 'service account email не налаштований');

    const folderId = state.appData.settings.driveFolderId;
    const folderName = state.appData.settings.driveFolderName;
    if (serviceFolderInput && folderId && !serviceFolderInput.value) serviceFolderInput.value = folderId;

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
