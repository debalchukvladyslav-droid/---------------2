// === js/drive.js ===
import { state } from './state.js';
import { saveSettings } from './storage.js';
import { loadImages } from './gallery.js';
import { showToast } from './utils.js';
import { uploadToSupabaseStorage } from './supabase_storage.js';
import { buildScreenshotPath, buildScreenshotPathVariants } from './storage_paths.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { ensureGoogleApi, ensureGoogleIdentity } from './vendor_loader.js';

const CLIENT_ID = '860755721651-eorsocc3iod2qnimc0qejch046vkeji6.apps.googleusercontent.com';
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

function driveAccessTokenStorageKey() {
    return state.myUserId ? `pj:driveAT:${state.myUserId}` : null;
}

function persistDriveAccessToken(token, expiresInSec) {
    const k = driveAccessTokenStorageKey();
    if (!k || !token) return;
    const sec = Math.max(120, Number(expiresInSec) || 3600);
    const expiresAt = Date.now() + sec * 1000 - 90_000;
    try {
        localStorage.setItem(k, JSON.stringify({ token, expiresAt }));
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

function requestNewToken(onSuccess, onError) {
    if (!_tokenClient) { onError(new Error('Google Sign-In ще не ініціалізовано. Спробуйте ще раз.')); return; }
    _tokenClient.callback = (resp) => {
        if (resp.error) { onError(new Error(resp.error)); return; }
        _accessToken = resp.access_token;
        persistDriveAccessToken(resp.access_token, resp.expires_in);
        onSuccess(_accessToken);
    };
    _tokenClient.requestAccessToken({ prompt: '' });
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
        (e) => showToast('❌ Помилка авторизації: ' + (e.message || e))
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
    // Повертаємо тільки існуючий токен — не запитуємо новий автоматично.
    // Новий токен видається тільки через явний клік користувача (connectGoogleDrive).
    return _accessToken || null;
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
        await Promise.all([initGapi(), initGsi()]);
        await tryRestoreDriveToken();

        const token = await getTokenSilently();
        if (!token) {
            if (statusEl) statusEl.textContent = '⚠️ Потрібна авторизація';
            hideGlobalLoader('drive-sync');
            return;
        }
        _accessToken = token;

        let files;
        if (_driveFilesCache && Date.now() - _driveFilesCache.ts < DRIVE_FILES_CACHE_TTL) {
            files = _driveFilesCache.files;
        } else {
            const listUrl = new URL('https://www.googleapis.com/drive/v3/files');
            listUrl.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/'`);
            listUrl.searchParams.set('fields', 'files(id,name,modifiedTime,size)');
            listUrl.searchParams.set('orderBy', 'modifiedTime desc');
            listUrl.searchParams.set('pageSize', '20');
            const resp = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
            const data = await resp.json();
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

        const newFiles = files.filter(file => {
            if (!/^[a-zA-Z0-9_-]+$/.test(file.id)) return false;
            const variants = buildScreenshotPathVariants(`${file.id}_${file.name}`);
            return variants.every(path => !existingPaths.has(path) && !ignored.has(path));
        });

        let newCount = 0;
        await Promise.all(newFiles.map(async (file) => {
            if (file.size && parseInt(file.size) > MAX_FILE_SIZE_BYTES) {
                console.warn(`Drive: пропускаємо ${file.name} — розмір перевищує ліміт`);
                return;
            }
            const storagePath = buildScreenshotPath(`${file.id}_${file.name}`);
            const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}`);
            fileUrl.searchParams.set('alt', 'media');
            const fileResp = await fetch(fileUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
            const blob = await fileResp.blob();
            if (blob.size > MAX_FILE_SIZE_BYTES) {
                console.warn(`Drive: пропускаємо ${file.name} — blob перевищує ліміт`);
                return;
            }
            await uploadToSupabaseStorage(storagePath, blob, { contentType: blob.type });
            if (!state.appData.unassignedImages) state.appData.unassignedImages = [];
            state.appData.unassignedImages.push(storagePath);
            newCount++;
            if (statusEl) statusEl.textContent = `⏳ Завантажено ${newCount}...`;
            showGlobalLoader('drive-sync', `Завантажено ${newCount}...`);
        }));

        if (newCount > 0) {
            _driveFilesCache = null;
            await saveSettings();
            loadImages();
            showGlobalLoader('drive-sync', `Синхронізовано ${newCount} скрінів`, { type: 'success' });
            hideGlobalLoader('drive-sync', 1400);
            showToast(`✅ Синхронізовано ${newCount} нових скрінів!`);
        } else if (!silent) {
            showGlobalLoader('drive-sync', 'Нових скрінів немає', { type: 'success' });
            hideGlobalLoader('drive-sync', 1200);
            showToast('✅ Нових скрінів немає');
        } else {
            hideGlobalLoader('drive-sync');
        }

        if (statusEl) statusEl.textContent = newCount > 0 ? `✅ +${newCount} нових` : '✅ Актуально';
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
    clearDriveAccessTokenStorage();
    _driveFilesCache = null;
    state.appData.settings.driveFolderId = null;
    state.appData.settings.driveFolderName = null;
    await saveSettings();
    updateDriveUI();
    loadImages();
    showToast('✅ Google Drive відключено');
}
