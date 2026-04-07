// === js/drive.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { loadImages } from './gallery.js';
import { showToast } from './utils.js';
import { uploadToSupabaseStorage } from './supabase_storage.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

function getClientId() {
    const id = state.systemConfig?.google_client_id || state.appData?.settings?.google_client_id;
    if (!id) throw new Error('Google Client ID не налаштований. Зверніться до адміністратора.');
    return id;
}

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const DRIVE_FILES_CACHE_TTL = 60 * 1000; // 1 хвилина

let _tokenClient = null;
let _accessToken = null;
let _pickerInited = false;
let _gapiInited = false;
let _gsiIniting = null;       // Promise — захист від паралельного initGsi
let _syncInProgress = false;  // захист від паралельних syncDriveScreenshots
let _driveFilesCache = null;  // { files, ts } — кеш списку файлів

// Завантажуємо Google API скрипти динамічно
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
    await loadScript('https://apis.google.com/js/api.js');
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
        await loadScript('https://accounts.google.com/gsi/client');
        if (typeof google === 'undefined' || !google.accounts?.oauth2) throw new Error('Google Sign-In не завантажився.');
        _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: getClientId(),
            scope: SCOPES,
            callback: () => {},
        });
    })();
    return _gsiIniting;
}

// Повертає збережений токен або null (синхронно)
function getCachedToken() {
    const saved = state.appData?.settings?.driveToken;
    if (saved && saved.expires > Date.now()) {
        _accessToken = saved.token;
        return _accessToken;
    }
    return null;
}

// Запитує новий токен через pop-up — має викликатись синхронно в user gesture
function requestNewToken(onSuccess, onError) {
    if (!_tokenClient) { onError(new Error('Google Sign-In ще не ініціалізовано. Спробуйте ще раз.')); return; }
    _tokenClient.callback = (resp) => {
        if (resp.error) { onError(new Error(resp.error)); return; }
        _accessToken = resp.access_token;
        state.appData.settings.driveToken = {
            token: _accessToken,
            expires: Date.now() + 55 * 60 * 1000
        };
        saveToLocal();
        onSuccess(_accessToken);
    };
    // Синхронний виклик — має бути без await перед ним
    _tokenClient.requestAccessToken({ prompt: '' });
}

export async function connectGoogleDrive() {
    try {
        // Ініціалізуємо до user gesture (якщо ще не готово)
        await Promise.all([initGapi(), initGsi()]);
    } catch(e) {
        showToast('❌ Помилка ініціалізації: ' + (e.message || e));
        return;
    }
    // Перевіряємо кеш синхронно
    const cached = getCachedToken();
    if (cached) { openFolderPicker(cached); return; }
    // Запитуємо токен синхронно (без await — щоб браузер вважав це user gesture)
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
                await saveToLocal();
                updateDriveUI();
                showToast(`✅ Папка "${folder.name}" підключена!`);
                // Одразу синхронізуємо
                await syncDriveScreenshots();
            }
        })
        .build();
    picker.setVisible(true);
}

export async function syncDriveScreenshots(silent = false) {
    // Захист від паралельних запитів
    if (_syncInProgress) return;
    // Синхронізація тільки для свого профілю
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) return;
    const folderId = state.appData?.settings?.driveFolderId;
    if (!folderId) return;

    _syncInProgress = true;
    const statusEl = document.getElementById('drive-sync-status');
    if (statusEl) statusEl.textContent = '⏳ Синхронізація...';

    try {
        await Promise.all([initGapi(), initGsi()]);
        const token = getCachedToken();
        if (!token) {
            // Немає дійсного токена — не запускаємо popup автоматично.
            // Користувач має натиснути "Підключити Google Drive" вручну.
            if (statusEl) statusEl.textContent = '⚠️ Потрібна авторизація';
            return;
        }

        // Кешуємо список файлів на 1 хвилину
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
            if (!data.files) { if (statusEl) statusEl.textContent = '⚠️ Помилка отримання файлів'; return; }
            files = data.files;
            _driveFilesCache = { files, ts: Date.now() };
        }

        // Знаходимо нові файли
        const existingPaths = new Set(state.appData.unassignedImages || []);
        const ignored = new Set(state.appData?.settings?.driveIgnored || []);
        for (const day of Object.values(state.appData.journal || {})) {
            const sc = day.screenshots || {};
            for (const arr of Object.values(sc)) {
                for (const p of arr) existingPaths.add(p);
            }
        }

        const nick = state.USER_DOC_NAME.replace('_stats', '');

        const newFiles = files.filter(file => {
            if (!/^[a-zA-Z0-9_-]+$/.test(file.id)) return false;
            const storagePath = `screenshots/${nick}/${file.id}_${file.name}`;
            return !existingPaths.has(storagePath) && !ignored.has(storagePath);
        });

        // Паралельне завантаження з обмеженням розміру
        let newCount = 0;
        await Promise.all(newFiles.map(async (file) => {
            // Перевірка розміру (поле size є в metadata якщо запитали)
            if (file.size && parseInt(file.size) > MAX_FILE_SIZE_BYTES) {
                console.warn(`Drive: пропускаємо ${file.name} — розмір ${file.size} перевищує ліміт`);
                return;
            }
            const storagePath = `screenshots/${nick}/${file.id}_${file.name}`;
            const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}`);
            fileUrl.searchParams.set('alt', 'media');
            const fileResp = await fetch(fileUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
            const blob = await fileResp.blob();
            // Перевірка розміру blob (fallback якщо size не було в metadata)
            if (blob.size > MAX_FILE_SIZE_BYTES) {
                console.warn(`Drive: пропускаємо ${file.name} — blob ${blob.size} перевищує ліміт`);
                return;
            }
            await uploadToSupabaseStorage(storagePath, blob, { contentType: blob.type });
            if (!state.appData.unassignedImages) state.appData.unassignedImages = [];
            state.appData.unassignedImages.push(storagePath);
            newCount++;
            if (statusEl) statusEl.textContent = `⏳ Завантажено ${newCount}...`;
        }));

        if (newCount > 0) {
            _driveFilesCache = null; // інвалідуємо кеш після змін
            await saveToLocal();
            loadImages();
            showToast(`✅ Синхронізовано ${newCount} нових скрінів!`);
        } else if (!silent) {
            showToast('✅ Нових скрінів немає');
        }

        if (statusEl) statusEl.textContent = newCount > 0 ? `✅ +${newCount} нових` : '✅ Актуально';
    } catch(e) {
        console.error('Drive sync error:', e);
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
        if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
    } else {
        btn.textContent = '🔗 Підключити Google Drive';
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
        if (info) info.textContent = '';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
    }
}

let _autoSyncInterval = null;
export function startDriveAutoSync() {
    if (_autoSyncInterval) clearInterval(_autoSyncInterval);
    _autoSyncInterval = setInterval(() => {
        if (state.appData?.settings?.driveFolderId && state.CURRENT_VIEWED_USER === state.USER_DOC_NAME && !_syncInProgress) {
            syncDriveScreenshots(true);
        }
    }, 30000);
}

export async function disconnectGoogleDrive() {
    // Виходимо з Google OAuth
    if (_accessToken && typeof google !== 'undefined' && google.accounts?.oauth2) {
        google.accounts.oauth2.revoke(_accessToken);
    }
    _accessToken = null;
    _driveFilesCache = null;
    state.appData.settings.driveFolderId = null;
    state.appData.settings.driveFolderName = null;
    state.appData.settings.driveToken = null;
    await saveToLocal();
    updateDriveUI();
    loadImages();
    showToast('✅ Google Drive відключено');
}
