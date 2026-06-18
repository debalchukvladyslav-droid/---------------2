// === js/google_sheet_connector.js — Google Identity + Picker + Sheets (перший рядок для мапінгу) ===
// Обмежте Client ID та API Key у Google Cloud Console (HTTP referrers / OAuth consent).
//
// COOP / вікно входу: для локальної розробки відкривайте саме http://localhost:5500 (не 127.0.0.1).
// Якщо в консолі «липне» COOP — нове вікно Інкогніто з тим самим localhost часто скидає політики.

import { setCopyableText, showToast } from './utils.js';
import {
    populateSheetMappingFromHeaders,
    setSheetPreviewData,
    clearSheetPreviewData,
    syncSheetWorkspaceVisibility,
    setGoogleAccountEmail,
    rememberSpreadsheet,
    clearGoogleSheetSession,
    setSpreadsheetSheets,
    getSelectedSheetTitle,
    getCurrentStoredSpreadsheetId,
    getCurrentStoredSpreadsheetTitle,
    setGoogleSheetConnectedFlag,
} from './sheet_table.js';
import { ensureGoogleApi, ensureGoogleIdentity } from './vendor_loader.js';
import { state } from './state.js';

const appConfig = window.TRADING_JOURNAL_CONFIG || {};
const SERVICE_ACCOUNT_EMAIL = String(appConfig.googleServiceAccountEmail || '').trim();

function requiredGoogleConfig(name) {
    const value = appConfig[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new Error(`Missing ${name} in config.js. Copy config.example.js to config.js and fill it in.`);
}

/** OAuth 2.0 Web client. */
export const GOOGLE_SHEETS_CLIENT_ID = String(appConfig.googleSheetsClientId || '').trim();

/** Browser API key (обмежте по referrer). */
export const GOOGLE_SHEETS_API_KEY = String(appConfig.googleSheetsApiKey || '').trim();

const GOOGLE_PICKER_APP_ID = String(appConfig.googlePickerAppId || '').trim();

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

/** Збільшуйте після зміни SCOPES — старі токени з sessionStorage ігноруються (інакше userinfo дає 401). */
const OAUTH_SCOPES_VERSION = '2';

const TOKEN_STORAGE_KEY = 'sheet_google_access_token';
const TOKEN_EXPIRES_KEY = 'sheet_google_access_token_expires_at';
const SCOPES_VERSION_KEY = 'sheet_google_scopes_v';
const SELECTED_SHEET_TITLE_KEY = 'sheet_selected_sheet_title';
const SHEET_PREVIEW_MAX_ROWS = 60;
const SHEET_PREVIEW_MAX_COLS = 52;

let tokenClient = null;
let accessToken = null;
let gapiClientReady = false;
let gapiPickerLoading = null;

function quoteSheetTitle(title) {
    return `'${String(title).replace(/'/g, "''")}'`;
}

function rangeForSelectedSheet(range, sheetTitle = getSelectedSheetTitle()) {
    if (!sheetTitle || String(range).includes('!')) return range;
    return `${quoteSheetTitle(sheetTitle)}!${range}`;
}

function setSheetServiceStatus(message, type = '') {
    const status = document.getElementById('sheet-service-status');
    if (!status) return;
    status.textContent = message || '';
    status.dataset.state = type;
}

function setSheetServiceEmail() {
    const emailEls = document.querySelectorAll('#sheet-service-email, #sheet-mock-email');
    emailEls.forEach((el) => {
        setCopyableText(el, SERVICE_ACCOUNT_EMAIL, 'service account email не налаштований');
    });
}

function extractSpreadsheetId(value = '') {
    const raw = String(value || '').trim();
    const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (match?.[1]) return match[1];
    const idParam = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParam?.[1]) return idParam[1];
    return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : '';
}

async function getSupabaseAccessToken() {
    const { supabase } = await import('./supabase.js');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data?.session?.access_token || '';
}

async function fetchSheetsService(params) {
    const token = await getSupabaseAccessToken();
    if (!token) throw new Error('Supabase session expired');
    const url = new URL('/api/sheets-service', window.location.origin);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    console.info('[Sheets service] request', params);
    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    console.info('[Sheets service] response', {
        action: params.action || 'metadata',
        status: response.status,
        ok: response.ok && data.ok !== false,
        error: data.error || '',
    });
    if (!response.ok || data.ok === false) {
        const error = new Error(data.error || `Sheets service ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function indexToColumnLetter(index) {
    let n = Math.max(0, Number(index) || 0) + 1;
    let result = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        result = String.fromCharCode(65 + rem) + result;
        n = Math.floor((n - 1) / 26);
    }
    return result;
}

function previewRangeForHeaders(headers = []) {
    const usedCols = Array.isArray(headers) ? headers.length : 0;
    const colCount = Math.min(SHEET_PREVIEW_MAX_COLS, Math.max(26, usedCols || 0));
    return `A1:${indexToColumnLetter(colCount - 1)}${SHEET_PREVIEW_MAX_ROWS}`;
}

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
            const gapi = await ensureGoogleApi();
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

function userStorageKey(baseKey) {
    return state.myUserId ? `${baseKey}:${state.myUserId}` : baseKey;
}

function readStoredGoogleToken() {
    const scopedTokenKey = userStorageKey(TOKEN_STORAGE_KEY);
    const token = sessionStorage.getItem(scopedTokenKey)
        || localStorage.getItem(scopedTokenKey)
        || (!state.myUserId ? sessionStorage.getItem(TOKEN_STORAGE_KEY) : null);
    if (!token) return null;
    const expiresAtRaw = localStorage.getItem(userStorageKey(TOKEN_EXPIRES_KEY));
    const expiresAt = Number(expiresAtRaw || 0);
    if (expiresAt && Date.now() >= expiresAt) {
        clearStoredGoogleToken();
        return null;
    }
    return token;
}

function persistStoredGoogleToken(token, expiresInSec) {
    if (!token) return;
    const sec = Math.max(120, Number(expiresInSec) || 3600);
    const expiresAt = Date.now() + sec * 1000 - 90_000;
    sessionStorage.setItem(userStorageKey(TOKEN_STORAGE_KEY), token);
    localStorage.setItem(userStorageKey(TOKEN_STORAGE_KEY), token);
    localStorage.setItem(userStorageKey(TOKEN_EXPIRES_KEY), String(expiresAt));
    localStorage.setItem(userStorageKey(SCOPES_VERSION_KEY), OAUTH_SCOPES_VERSION);
    if (state.myUserId) {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        localStorage.removeItem(TOKEN_EXPIRES_KEY);
        localStorage.removeItem(SCOPES_VERSION_KEY);
    }
}

function clearStoredGoogleToken() {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(SCOPES_VERSION_KEY);
    sessionStorage.removeItem(userStorageKey(TOKEN_STORAGE_KEY));
    sessionStorage.removeItem(userStorageKey(SCOPES_VERSION_KEY));
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(TOKEN_EXPIRES_KEY);
    localStorage.removeItem(SCOPES_VERSION_KEY);
    localStorage.removeItem(userStorageKey(TOKEN_STORAGE_KEY));
    localStorage.removeItem(userStorageKey(TOKEN_EXPIRES_KEY));
    localStorage.removeItem(userStorageKey(SCOPES_VERSION_KEY));
}

/** Скидає OAuth у сесії (токен виданий без актуальних scope або прострочений). */
function invalidateStoredGoogleOAuth() {
    clearStoredGoogleToken();
    accessToken = null;
    tokenClient = null;
    if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken(null);
    }
    sessionStorage.removeItem('sheet_google_connected');
    clearGoogleSheetSession();
    clearSheetPreviewData();
    setGoogleAccountEmail('—');
    syncSheetWorkspaceVisibility();
}

/**
 * Профіль користувача — лише після валідного accessToken з потрібними scope.
 * @param {{ silent401?: boolean }} opts — при silent401 (restore) не шумимо в консоль і очищаємо застарілий токен.
 */
async function fetchGoogleUserEmail(token, opts = {}) {
    const silent401 = !!opts.silent401;
    if (!token || typeof token !== 'string' || !token.trim()) {
        if (!silent401) console.warn('[Google] userinfo: пропущено — access token ще порожній');
        return null;
    }
    const accessTok = token.trim();

    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessTok}`,
                Accept: 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status === 401) {
                if (silent401) {
                    console.warn(
                        '[Google] userinfo 401 — токен без userinfo scope або прострочений. Натисніть «Увійти через Google» ще раз.',
                    );
                    invalidateStoredGoogleOAuth();
                } else {
                    console.error(
                        '[Google] userinfo 401: перевірте SCOPES у Cloud Console та повторний вхід (consent).',
                    );
                }
            } else if (!silent401) {
                console.error('[Google] userinfo: HTTP', response.status);
            }
            return null;
        }

        const data = await response.json();
        if (data.email && !silent401) {
            console.log('[Google] Дані користувача (email):', data.email);
        }
        return data.email || null;
    } catch (error) {
        if (!silent401) console.error('[Google] Помилка профілю:', error);
        return null;
    }
}

function onTokenSuccess(resp, options = {}) {
    if (resp.error) {
        showToast('Google OAuth: ' + (resp.error_description || resp.error));
        return;
    }
    accessToken = resp.access_token;
    persistStoredGoogleToken(accessToken, resp.expires_in);
    sessionStorage.setItem(userStorageKey(SCOPES_VERSION_KEY), OAUTH_SCOPES_VERSION);
    setGoogleSheetConnectedFlag(true);
    applyAccessTokenToGapiClient(accessToken);
    void (async () => {
        const email = await fetchGoogleUserEmail(accessToken, { silent401: !!options.silent });
        setGoogleAccountEmail(email || 'Google акаунт');
        syncSheetWorkspaceVisibility();
        if (!options.silent) showToast('Увійшли через Google.');
    })();
}

function hasCurrentGoogleGrant() {
    return (
        localStorage.getItem(userStorageKey(SCOPES_VERSION_KEY)) === OAUTH_SCOPES_VERSION ||
        sessionStorage.getItem(SCOPES_VERSION_KEY) === OAUTH_SCOPES_VERSION
    );
}

function ensureTokenClient() {
    return ensureGoogleIdentity().then(() => {
        if (tokenClient) return;
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_SHEETS_CLIENT_ID,
            scope: SCOPES,
            callback: onTokenSuccess,
        });
    });
}

async function requestAccessToken(prompt = '', options = {}) {
    await ensureTokenClient();
    return new Promise((resolve, reject) => {
        tokenClient.callback = (resp) => {
            if (resp?.error) {
                reject(new Error(resp.error_description || resp.error));
                return;
            }
            onTokenSuccess(resp, options);
            resolve(resp.access_token || '');
        };
        tokenClient.requestAccessToken({ prompt });
    });
}

/** Кнопка «Увійти через Google». */
export async function handleAuthClick() {
    try {
        await ensureGapiClientAndPicker();
        await requestAccessToken(hasCurrentGoogleGrant() ? '' : 'consent');
    } catch (e) {
        console.error(e);
        showToast(
            (e && e.message) ||
                'Не вдалося ініціалізувати Google. Перевірте скрипти gsi/api у index.html.',
        );
    }
}

/**
 * Google Picker — вибір таблиці.
 * Помилка «The API developer key is invalid»: у Google Cloud → Credentials → API key
 * обмеження «HTTP referrers» має містити http://localhost:5500/* (той самий origin, що в адресному рядку).
 * Увімкніть також API: Google Picker API, Google Drive API, Google Sheets API.
 */
export async function openPicker() {
    try {
        await ensureGapiClientAndPicker();
        accessToken = accessToken || readStoredGoogleToken();
        if (!accessToken) {
            console.error('Немає accessToken! Спочатку треба залогінитись.');
            showToast('Спочатку увійдіть через Google.');
            return;
        }
        applyAccessTokenToGapiClient(accessToken);
        await waitForGlobal('google');
        if (!google.picker) {
            showToast('Picker API не завантажився. Оновіть сторінку.');
            return;
        }
        const API_KEY = GOOGLE_SHEETS_API_KEY;

        const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS);
        const picker = new google.picker.PickerBuilder()
            .enableFeature(google.picker.Feature.NAV_HIDDEN)
            .setDeveloperKey(API_KEY)
            .setAppId(GOOGLE_PICKER_APP_ID)
            .setOAuthToken(accessToken)
            .addView(view)
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
        const selectedSheet = await loadSpreadsheetSheets(doc.id);
        await fetchSpreadsheetData(doc.id, selectedSheet);
    } catch (e) {
        console.error(e);
        showToast('Не вдалося зчитати заголовки: ' + (e.message || String(e)));
    }
}

export async function loadSpreadsheetFromServiceInput(trigger = null) {
    const input = trigger?.closest?.('.sheet-workspace')
        ? document.getElementById('sheet-service-url-input-workspace')
        : (document.getElementById('sheet-service-url-input') || document.getElementById('sheet-service-url-input-workspace'));
    const fallbackId = getCurrentStoredSpreadsheetId();
    const spreadsheetId = extractSpreadsheetId(input?.value || fallbackId);
    if (!spreadsheetId) {
        setSheetServiceStatus('Вставте посилання або ID Google таблиці.', 'error');
        showToast('Вставте посилання або ID Google таблиці.');
        return;
    }

    setSheetServiceEmail();
    setSheetServiceStatus('Читаємо таблицю через service account...', 'loading');
    try {
        const selectedSheet = await loadSpreadsheetSheets(spreadsheetId);
        await fetchSpreadsheetData(spreadsheetId, selectedSheet);
        syncSheetWorkspaceVisibility();
        setSheetServiceStatus('Таблиця підключена через service account.', 'success');
        showToast('Google таблицю підключено через service account.');
    } catch (error) {
        console.error('[Google Sheets] service account load failed', error);
        setSheetServiceStatus(`Не вдалося прочитати таблицю: ${error?.message || error}`, 'error');
        showToast('Не вдалося прочитати таблицю: ' + (error?.message || String(error)));
    }
}

async function loadSpreadsheetSheets(fileId) {
    const data = await fetchSheetsService({ action: 'metadata', spreadsheetId: fileId });
    const sheets = (data.sheets || [])
        .filter(Boolean)
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    const stored = localStorage.getItem(SELECTED_SHEET_TITLE_KEY) || sessionStorage.getItem(SELECTED_SHEET_TITLE_KEY);
    const selected = stored && sheets.some(sheet => sheet.title === stored)
        ? stored
        : (sheets[0]?.title || '');
    setSpreadsheetSheets(sheets, selected);
    if (data.title) rememberSpreadsheet(fileId, data.title);
    return selected;
}

/**
 * Зчитує перший рядок таблиці (заголовки) для розумного мапінгу.
 * (У ТЗ також як fetchSpreadsheetData.)
 */
export async function fetchSpreadsheetData(fileId, sheetTitle = getSelectedSheetTitle()) {
    try {
        const headersResponse = await fetchSheetsService({
            action: 'values',
            spreadsheetId: fileId,
            range: rangeForSelectedSheet('A1:ZZ1', sheetTitle),
        });
        const row = headersResponse.values && headersResponse.values.length > 0 ? headersResponse.values[0] : [];
        const previewResponse = await fetchSheetsService({
            action: 'values',
            spreadsheetId: fileId,
            range: rangeForSelectedSheet(previewRangeForHeaders(row), sheetTitle),
        });
        const previewRows = previewResponse.values || [];
        populateSheetMappingFromHeaders(row);
        setSheetPreviewData(previewRows);
        setSheetServiceStatus(`Таблиця підключена. Лист: ${sheetTitle || 'перший'}`, 'success');
        return row;
    } catch (err) {
        console.error('Помилка отримання заголовків:', err);
        throw err;
    }
}

/** Зчитує перший рядок A1:Z1 і оновлює випадаючі списки мапінгу. */
export async function loadSheetHeaders(fileId) {
    return fetchSpreadsheetData(fileId);
}

/**
 * Довільний діапазон A1-нотації (наприклад A6:ZZ2000 для рядків угод).
 * @param {string} spreadsheetId
 * @param {string} range
 * @returns {Promise<string[][]>}
 */
export async function fetchSpreadsheetValuesRange(spreadsheetId, range, sheetTitle = getSelectedSheetTitle()) {
    const response = await fetchSheetsService({
        action: 'values',
        spreadsheetId,
        range: rangeForSelectedSheet(range, sheetTitle),
    });
    return response.values || [];
}

export async function googleSheetsLogout() {
    const tok = accessToken || readStoredGoogleToken();
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
    clearStoredGoogleToken();
    if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken(null);
    }
    clearGoogleSheetSession();
    clearSheetPreviewData();
    setGoogleAccountEmail('—');
    syncSheetWorkspaceVisibility();
    showToast('Вийшли з Google.');
}

export async function restoreGoogleSession() {
    setSheetServiceEmail();
    setGoogleAccountEmail(SERVICE_ACCOUNT_EMAIL || 'Service account');
    const sid = getCurrentStoredSpreadsheetId();
    const st = getCurrentStoredSpreadsheetTitle();
    const input = document.getElementById('sheet-service-url-input');
    const workspaceInput = document.getElementById('sheet-service-url-input-workspace');
    if (input && sid && !input.value) input.value = sid;
    if (workspaceInput && sid && !workspaceInput.value) workspaceInput.value = sid;
    if (sid) {
        setGoogleSheetConnectedFlag(true);
        if (st) {
            const nameEl = document.getElementById('sheet-selected-file-name');
            if (nameEl) nameEl.textContent = st;
        }
        try {
            const selectedSheet = await loadSpreadsheetSheets(sid);
            await fetchSpreadsheetData(sid, selectedSheet);
        } catch (e) {
            console.warn('[Google Sheets] service restore failed', e);
            setSheetServiceStatus('Не вдалося оновити прев’ю. Перевірте доступ service account до таблиці.', 'error');
        }
    }
    syncSheetWorkspaceVisibility();
    return;

    const scopeVer = localStorage.getItem(userStorageKey(SCOPES_VERSION_KEY)) || sessionStorage.getItem(SCOPES_VERSION_KEY);
    if (scopeVer !== OAUTH_SCOPES_VERSION) {
        console.warn(
            '[Google] збережений токен виданий зі старими дозволами — виконайте вхід знову (потрібні userinfo + Sheets + Drive).',
        );
        invalidateStoredGoogleOAuth();
        return;
    }

    try {
        await ensureGapiClientAndPicker();
        let tok = readStoredGoogleToken();
        const wasConnected = readStoredGoogleToken() || getCurrentStoredSpreadsheetId();
        if (!tok && wasConnected && hasCurrentGoogleGrant()) {
            try {
                tok = await requestAccessToken('', { silent: true });
            } catch (error) {
                console.warn('[Google Sheets] silent token refresh failed:', error?.message || error);
                syncSheetWorkspaceVisibility();
                return;
            }
        }
        if (!tok) return;
        accessToken = tok;
        sessionStorage.setItem(userStorageKey(TOKEN_STORAGE_KEY), tok);
        sessionStorage.setItem(userStorageKey(SCOPES_VERSION_KEY), OAUTH_SCOPES_VERSION);
        applyAccessTokenToGapiClient(tok);
        setGoogleSheetConnectedFlag(true);
        const email = await fetchGoogleUserEmail(tok, { silent401: true });
        setGoogleAccountEmail(email || 'Google акаунт');

        const sid = getCurrentStoredSpreadsheetId();
        const st = getCurrentStoredSpreadsheetTitle();
        if (sid && readStoredGoogleToken()) {
            const nameEl = document.getElementById('sheet-selected-file-name');
            if (nameEl) nameEl.textContent = st || sid;
            try {
                const selectedSheet = await loadSpreadsheetSheets(sid);
                await fetchSpreadsheetData(sid, selectedSheet);
            } catch (e) {
                console.warn('[Sheets] headers refresh failed', e);
            }
        }
        syncSheetWorkspaceVisibility();
    } catch (e) {
        console.warn('[Google Sheets] restore session failed', e);
        invalidateStoredGoogleOAuth();
    }
}

window.handleAuthClick = handleAuthClick;
window.openPicker = openPicker;
window.googleSheetsLogout = googleSheetsLogout;
window.fetchSpreadsheetData = fetchSpreadsheetData;
window.loadSheetHeaders = loadSheetHeaders;
window.fetchSpreadsheetValuesRange = fetchSpreadsheetValuesRange;
window.loadSpreadsheetFromServiceInput = loadSpreadsheetFromServiceInput;
