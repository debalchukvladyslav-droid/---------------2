// === js/drive.js ===
import { state } from './state.js';
import { saveSettings } from './storage.js';
import { loadImages } from './gallery.js';
import { setCopyableText, showToast } from './utils.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { ensureGoogleApi, ensureGoogleIdentity } from './vendor_loader.js';
import { fetchWithSession } from './authenticated_fetch.js';
import { loadScreenshotRegistry, mergeScreenshotRegistry } from './screenshot_registry.js';
import { driveSyncErrorMessage, isQuietDriveSyncError, shouldSkipSilentDriveSync } from './drive_sync_core.js';

const appConfig = window.TRADING_JOURNAL_CONFIG || {};
const CLIENT_ID = String(appConfig.googleDriveClientId || appConfig.googleSheetsClientId || '').trim();
const SERVICE_ACCOUNT_EMAIL = String(appConfig.googleServiceAccountEmail || '').trim();
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

let _tokenClient = null;
let _accessToken = null;
let _pickerInited = false;
let _gapiInited = false;
let _gsiIniting = null;
let _syncInProgress = false;
let _lastSuccessfulSyncAt = 0;

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
        sessionStorage.setItem(k, JSON.stringify({ token, expiresAt }));
        const grantKey = driveGrantStorageKey();
        if (grantKey) localStorage.setItem(grantKey, '1');
    } catch (_) {}
}

function clearDriveAccessTokenStorage() {
    const k = driveAccessTokenStorageKey();
    if (k) {
        try {
            sessionStorage.removeItem(k);
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
        const raw = sessionStorage.getItem(k);
        if (!raw) return false;
        const { token, expiresAt } = JSON.parse(raw);
        if (!token || !expiresAt || Date.now() >= expiresAt) {
            sessionStorage.removeItem(k);
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
    const owner = state.myUserId;
    const picker = new google.picker.PickerBuilder()
        .addView(new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setMimeTypes('application/vnd.google-apps.folder'))
        .setOAuthToken(token)
        .setCallback(async (data) => {
            if (data.action === google.picker.Action.PICKED) {
                const folder = data.docs[0];
                if (state.myUserId !== owner) return;
                try {
                    await connectDriveFolder(folder.id, token);
                    if (state.myUserId !== owner) return;
                    state.appData.settings.driveFolderId = folder.id;
                    state.appData.settings.driveFolderName = folder.name;
                    await saveSettings();
                    updateDriveUI();
                    showToast(`✅ Папка "${folder.name}" підключена!`);
                    await syncDriveScreenshots();
                } catch (error) { showToast(driveSyncErrorMessage(error)); }
            }
        })
        .build();
    picker.setVisible(true);
}

async function connectDriveFolder(folderId, token = '') {
    const response = await fetchWithSession('/api/drive-service?action=connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-google-access-token': token } : {}) },
        body: JSON.stringify({ folderId }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'Не вдалося підключити папку.'), { status: response.status, code: result.code });
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
    const owner = state.myUserId;
    const input = document.getElementById('drive-service-folder-input');
    const folderId = extractDriveFolderId(input?.value || state.appData?.settings?.driveFolderId || '');
    if (!folderId) return '';
    await connectDriveFolder(folderId);
    if (state.myUserId !== owner) return '';
    if (!state.appData.settings) state.appData.settings = {};
    if (state.appData.settings.driveFolderId !== folderId) {
        state.appData.settings.driveFolderId = folderId;
        state.appData.settings.driveFolderName = 'Service account folder';        await saveSettings();
        updateDriveUI();
    }
    return folderId;
}

export async function syncDriveScreenshotsFromServiceButton() {
    setDriveServiceStatus('Готуємо синхронізацію...', 'loading');
    try {
        const folderId = await saveServiceFolderFromInput();
        if (!folderId) {
            setDriveServiceStatus('Вставте посилання або ID папки Google Drive.', 'error');
            return;
        }
        await syncDriveScreenshots(false);
    } catch (error) {
        const message = driveSyncErrorMessage(error);
        setDriveServiceStatus(message, 'error');
        showToast(message);
    }}

export async function syncDriveScreenshots(silent = false) {
    if (_syncInProgress || !state.myUserId || state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) return;
    const folderId = state.appData?.settings?.driveFolderId;
    if (!folderId) {
        if (!silent) showToast('Підключіть папку Google Drive.');
        return;
    }
    if (shouldSkipSilentDriveSync({ silent, lastSuccessfulSyncAt: _lastSuccessfulSyncAt })) return;
    const owner = state.myUserId;
    _syncInProgress = true;
    const statusEl = document.getElementById('drive-sync-status');
    if (statusEl) statusEl.textContent = 'Перевіряємо скріншоти Google Drive…';
    showGlobalLoader('drive-sync', 'Синхронізація Google Drive…');
    try {
        const response = await fetchWithSession('/api/drive-service?action=sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId, force: !silent }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'Не вдалося синхронізувати Google Drive.'), { status: response.status, code: result.code });
        if (state.myUserId !== owner) return;
        const rows = await loadScreenshotRegistry(owner);
        if (state.myUserId !== owner) return;
        const before = JSON.stringify(state.appData.screenMeta || {});
        const added = mergeScreenshotRegistry(state.appData, rows);
        if (added || before !== JSON.stringify(state.appData.screenMeta || {})) await saveSettings();
        if (state.myUserId !== owner) return;
        if (document.getElementById('view-screens')?.classList.contains('active')) await loadImages();
        _lastSuccessfulSyncAt = Date.now();
        if (statusEl) statusEl.textContent = result.continue ? 'Індексація продовжиться у фоні' : added ? 'Додано скріншотів: ' + added : 'Скріншоти актуальні';
        setDriveServiceStatus('Скріншоти доступні з Google Drive', 'success');
        if (!silent) showToast(added ? 'Додано скріншотів: ' + added : 'Скріншоти актуальні');
    } catch (error) {
        console.warn('[Drive] reference sync:', error?.message || error);
        if (state.myUserId === owner) {
            const message = driveSyncErrorMessage(error);
            if (statusEl) statusEl.textContent = message;
            if (!silent) showToast(message);
        }
    } finally {
        _syncInProgress = false;
        hideGlobalLoader('drive-sync');
    }
}

export function updateDriveUI() {
    const btn = document.getElementById('drive-connect-btn');
    const info = document.getElementById('drive-folder-info');
    const disconnectBtn = document.getElementById('drive-disconnect-btn');
    const serviceEmailEl = document.getElementById('drive-service-email');
    const serviceFolderInput = document.getElementById('drive-service-folder-input');
    if (serviceEmailEl) setCopyableText(serviceEmailEl, SERVICE_ACCOUNT_EMAIL, 'service account email не налаштований');

    const folderId = state.appData.settings.driveFolderId;
    const folderName = state.appData.settings.driveFolderName;
    if (serviceFolderInput && folderId && !serviceFolderInput.value) serviceFolderInput.value = folderId;

    if (folderId) {
        if (btn) {
            btn.textContent = '🔄 Змінити папку';
            btn.style.background = 'rgba(16,185,129,0.15)';
            btn.style.borderColor = 'var(--profit)';
            btn.style.color = 'var(--profit)';
        }
        if (info) info.textContent = `📁 ${folderName || folderId}`;
        if (disconnectBtn) disconnectBtn.classList.remove('initially-hidden');
    } else {
        if (btn) {
            btn.textContent = '🔗 Підключити Google Drive';
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
        }
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
    clearDriveGrantStorage();    state.appData.settings.driveFolderId = null;
    state.appData.settings.driveFolderName = null;
    await saveSettings();
    updateDriveUI();
    loadImages();
    showToast('✅ Google Drive відключено');
}
