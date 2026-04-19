// === js/google_sheet_connector.js — Google Identity + Picker + Sheets (перший рядок для мапінгу) ===
// Обмежте Client ID та API Key у Google Cloud Console (HTTP referrers / OAuth consent).

import { showToast } from './utils.js';
import {
    populateSheetMappingFromHeaders,
    syncSheetWorkspaceVisibility,
    setGoogleAccountEmail,
    rememberSpreadsheet,
    clearGoogleSheetSession,
} from './sheet_table.js';

/** OAuth 2.0 Web client. */
export const GOOGLE_SHEETS_CLIENT_ID =
    '860755721651-lj7ds44epl45augj0og1nilq9f0ug9qg.apps.googleusercontent.com';

/** Browser API key (обмежте по referrer). */
export const GOOGLE_SHEETS_API_KEY = 'AIzaSyBd91SFHc7xb4FJucC4YLa8lqqzFgMcao4';

/** Номер проєкту Google Cloud — для Picker.setAppId. */
const GOOGLE_CLOUD_PROJECT_NUMBER = '860755721651';

const SCOPES =
    'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly';

const TOKEN_STORAGE_KEY = 'sheet_google_access_token';

let tokenClient = null;
let accessToken = null;
let gapiClientReady = false;
let gapiPickerLoading = null;

function waitForGlobal(name, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            if (typeof window[name] !== 'undefined' && window[name] != null) {
                resolve(window[name]);
                return;
            }
            if (Date.now() - t0 > timeoutMs) {
                reject(new Error(`Не завантажено скрипт: ${name}`));
                return;
            }
            setTimeout(tick, 50);
        };
        tick();
    });
}

async function ensureGapiClientAndPicker() {
    if (gapiClientReady) return;
    if (!gapiPickerLoading) {
        gapiPickerLoading = (async () => {
            const gapi = await waitForGlobal('gapi');
            await new Promise((resolve, reject) => {
                try {
                    gapi.load('client:picker', resolve);
                } catch (e) {
                    reject(e);
                }
            });
            await gapi.client.init({
                apiKey: GOOGLE_SHEETS_API_KEY,
                discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
            });
            gapiClientReady = true;
        })().finally(() => {
            gapiPickerLoading = null;
        });
    }
    await gapiPickerLoading;
}

function applyAccessTokenToGapiClient(token) {
    if (!token || typeof gapi === 'undefined' || !gapi.client) return;
    gapi.client.setToken({ access_token: token });
}

async function fetchGoogleUserEmail(token) {
    try {
        const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.email || null;
    } catch {
        return null;
    }
}

function onTokenSuccess(resp) {
    if (resp.error) {
        showToast('Google OAuth: ' + (resp.error_description || resp.error));
        return;
    }
    accessToken = resp.access_token;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
    sessionStorage.setItem('sheet_google_connected', '1');
    applyAccessTokenToGapiClient(accessToken);
    void (async () => {
        const email = await fetchGoogleUserEmail(accessToken);
        setGoogleAccountEmail(email || 'Google акаунт');
        syncSheetWorkspaceVisibility();
        showToast('Увійшли через Google.');
    })();
}

function ensureTokenClient() {
    return waitForGlobal('google').then(() => {
        if (tokenClient) return;
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_SHEETS_CLIENT_ID,
            scope: SCOPES,
            callback: onTokenSuccess,
        });
    });
}

/** Кнопка «Увійти через Google». */
export async function handleAuthClick() {
    try {
        await ensureGapiClientAndPicker();
        await ensureTokenClient();
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (e) {
        console.error(e);
        showToast(
            (e && e.message) ||
                'Не вдалося ініціалізувати Google. Перевірте скрипти gsi/api у index.html.',
        );
    }
}

/** Google Picker — вибір таблиці. */
export async function openPicker() {
    try {
        await ensureGapiClientAndPicker();
        accessToken = accessToken || sessionStorage.getItem(TOKEN_STORAGE_KEY);
        if (!accessToken) {
            showToast('Спочатку увійдіть через Google.');
            return;
        }
        applyAccessTokenToGapiClient(accessToken);
        await waitForGlobal('google');
        if (!google.picker) {
            showToast('Picker API не завантажився. Оновіть сторінку.');
            return;
        }
        const picker = new google.picker.PickerBuilder()
            .addView(new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS))
            .setOAuthToken(accessToken)
            .setDeveloperKey(GOOGLE_SHEETS_API_KEY)
            .setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)
            .setOrigin(window.location.origin)
            .setCallback(pickerCallback)
            .build();
        picker.setVisible(true);
    } catch (e) {
        console.error(e);
        showToast(e.message || 'Picker: помилка');
    }
}

async function pickerCallback(data) {
    const picked = google.picker?.Action?.PICKED ?? 'picked';
    if (data?.action !== picked) return;

    const doc = data.docs && data.docs[0];
    if (!doc?.id) return;

    const name = doc.name || doc.title || 'Spreadsheet';
    rememberSpreadsheet(doc.id, name);
    syncSheetWorkspaceVisibility();
    showToast(`Обрано: ${name}`);
    try {
        await fetchSpreadsheetData(doc.id);
    } catch (e) {
        console.error(e);
        showToast('Не вдалося зчитати заголовки: ' + (e.message || String(e)));
    }
}

/**
 * Зчитує перший рядок таблиці (заголовки) для розумного мапінгу.
 * (У ТЗ також як fetchSpreadsheetData.)
 */
export async function fetchSpreadsheetData(fileId) {
    await ensureGapiClientAndPicker();
    const token = accessToken || sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!token) throw new Error('Немає access token');
    applyAccessTokenToGapiClient(token);

    const res = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: fileId,
        range: '1:1',
    });
    const row = res.result.values && res.result.values[0] ? res.result.values[0] : [];
    populateSheetMappingFromHeaders(row);
    return row;
}

export async function loadSheetHeaders(fileId) {
    return fetchSpreadsheetData(fileId);
}

export async function googleSheetsLogout() {
    const tok = accessToken || sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (tok && typeof google !== 'undefined' && google.accounts?.oauth2?.revoke) {
        try {
            await new Promise((resolve) => {
                google.accounts.oauth2.revoke(tok, () => resolve());
            });
        } catch (_) {
            /* ignore */
        }
    }
    accessToken = null;
    tokenClient = null;
    if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken(null);
    }
    clearGoogleSheetSession();
    setGoogleAccountEmail('—');
    syncSheetWorkspaceVisibility();
    showToast('Вийшли з Google.');
}

export async function restoreGoogleSession() {
    const tok = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!tok) return;
    try {
        await ensureGapiClientAndPicker();
        accessToken = tok;
        applyAccessTokenToGapiClient(tok);
        sessionStorage.setItem('sheet_google_connected', '1');
        const email = await fetchGoogleUserEmail(tok);
        setGoogleAccountEmail(email || 'Google акаунт');
        const sid = sessionStorage.getItem('sheet_spreadsheet_id');
        const st = sessionStorage.getItem('sheet_spreadsheet_title');
        if (sid) {
            const nameEl = document.getElementById('sheet-selected-file-name');
            if (nameEl) nameEl.textContent = st || sid;
            try {
                await fetchSpreadsheetData(sid);
            } catch (e) {
                console.warn('[Sheets] headers refresh failed', e);
            }
        }
        syncSheetWorkspaceVisibility();
    } catch (e) {
        console.warn('[Google Sheets] restore session failed', e);
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        sessionStorage.removeItem('sheet_google_connected');
    }
}

window.handleAuthClick = handleAuthClick;
window.openPicker = openPicker;
window.googleSheetsLogout = googleSheetsLogout;
window.fetchSpreadsheetData = fetchSpreadsheetData;
window.loadSheetHeaders = loadSheetHeaders;
