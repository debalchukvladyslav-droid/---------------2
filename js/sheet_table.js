// === js/sheet_table.js — Google Sheets UI + мапінг (стани, збереження) ===

import { showToast } from './utils.js';

const LS_KEY = 'tj_google_sheet_import_v1';

/** Підключено до Google (після OAuth). */
const SESSION_GOOGLE = 'sheet_google_connected';
/** Обрана таблиця (Spreadsheet ID). */
const SESSION_SPREADSHEET_ID = 'sheet_spreadsheet_id';
const SESSION_SPREADSHEET_TITLE = 'sheet_spreadsheet_title';

const SMART_KEYS = ['date', 'tradeType', 'profit', 'pv', 'exceptions'];

/** Статичні приклади (старі збереження) + динаміка з таблиці. */
const PRESET_FALLBACK = ['Date', 'Ticker', 'Profit/Loss', 'Notes'];

let _dynamicHeaders = [];
/** Пари літера колонки ↔ текст заголовка з рядка A1:Z1 (value у select = літера). */
let _dynamicColumnChoices = [];

function el(id) {
    return document.getElementById(id);
}

/** Індекс 0 → A, 25 → Z, 26 → AA (на випадок розширення діапазону). */
function indexToColumnLetter(index) {
    let n = index + 1;
    let result = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        result = String.fromCharCode(65 + rem) + result;
        n = Math.floor((n - 1) / 26);
    }
    return result;
}

/**
 * Оновлює <select> у блоці мапінгу: option.value = літера колонки (A, B…),
 * option.text = «Заголовок (A)» — як у вашому описі renderMappingDropdowns.
 */
export function populateSheetMappingFromHeaders(headers) {
    const row = Array.isArray(headers) ? headers : [];
    _dynamicColumnChoices = row.map((cell, index) => ({
        letter: indexToColumnLetter(index),
        header: String(cell ?? '').trim(),
    }));
    _dynamicHeaders = _dynamicColumnChoices.map((c) => c.header).filter((h) => h.length > 0);

    const mapping = el('sheet-smart-mapping');
    if (!mapping) return;

    mapping.querySelectorAll('select.sheet-input-group__select').forEach((sel) => {
        const prev = sel.value;
        sel.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = 'Виберіть колонку...';
        sel.appendChild(opt0);

        _dynamicColumnChoices.forEach(({ letter, header }) => {
            const o = document.createElement('option');
            o.value = letter;
            o.textContent = header ? `${header} (${letter})` : `(${letter} порожньо)`;
            sel.appendChild(o);
        });

        let nextVal = prev;
        if (prev && ![...sel.options].some((o) => o.value === prev)) {
            const byLetter = _dynamicColumnChoices.find((c) => c.letter === prev.toUpperCase());
            const byHeader = _dynamicColumnChoices.find(
                (c) => c.header === prev || (c.header && c.header.toLowerCase() === prev.toLowerCase()),
            );
            if (byLetter) nextVal = byLetter.letter;
            else if (byHeader) nextVal = byHeader.letter;
        }
        if (nextVal && [...sel.options].some((o) => o.value === nextVal)) {
            sel.value = nextVal;
        }
    });

    const cfg = readStoredConfig();
    if (cfg?.smartColumns && typeof cfg.smartColumns === 'object') {
        SMART_KEYS.forEach((k) => {
            setSmartRowValue(k, cfg.smartColumns[k] || '', false);
        });
    }
}

/** Аліас назви з ТЗ. */
export function renderMappingDropdowns(headers) {
    return populateSheetMappingFromHeaders(headers);
}

export function setGoogleAccountEmail(email) {
    const e = el('sheet-mock-email');
    if (e) e.textContent = email || '—';
}

export function rememberSpreadsheet(id, title) {
    sessionStorage.setItem(SESSION_SPREADSHEET_ID, id);
    if (title) sessionStorage.setItem(SESSION_SPREADSHEET_TITLE, title);
    sessionStorage.setItem(SESSION_GOOGLE, '1');
    const nameEl = el('sheet-selected-file-name');
    if (nameEl) nameEl.textContent = title || id;
}

export function clearGoogleSheetSession() {
    sessionStorage.removeItem(SESSION_GOOGLE);
    sessionStorage.removeItem(SESSION_SPREADSHEET_ID);
    sessionStorage.removeItem(SESSION_SPREADSHEET_TITLE);
    sessionStorage.removeItem('sheet_google_access_token');
    const nameEl = el('sheet-selected-file-name');
    if (nameEl) nameEl.textContent = '—';
}

export function syncSheetWorkspaceVisibility() {
    const connected = sessionStorage.getItem(SESSION_GOOGLE) === '1';
    const fileOk = !!sessionStorage.getItem(SESSION_SPREADSHEET_ID);

    const s1 = el('sheet-state-connect');
    const s2 = el('sheet-state-workspace');
    const fileCard = el('sheet-mock-file-card');
    const mapping = el('sheet-smart-mapping');

    if (s1) s1.hidden = connected;
    if (s2) s2.hidden = !connected;
    if (fileCard) fileCard.hidden = !connected || !fileOk;
    if (mapping) mapping.hidden = !connected || !fileOk;
}

function getKnownColumnValues() {
    const s = new Set(PRESET_FALLBACK);
    _dynamicHeaders.forEach((h) => s.add(h));
    _dynamicColumnChoices.forEach((c) => {
        s.add(c.letter);
        if (c.header) s.add(c.header);
    });
    return s;
}

function isColumnLetterToken(v) {
    return typeof v === 'string' && /^[A-Z]{1,3}$/i.test(v.trim());
}

function isPresetValue(v) {
    if (isColumnLetterToken(v)) return true;
    return getKnownColumnValues().has(v);
}

/** Підставляє літеру колонки, якщо збережено старий текст заголовка з таблиці. */
function resolveMappingValueToSelectLetter(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v || v.includes(',')) return v;
    if (isColumnLetterToken(v)) return v.toUpperCase();
    if (!_dynamicColumnChoices.length) return v;
    const hit = _dynamicColumnChoices.find(
        (c) => c.header === v || (c.header && c.header.toLowerCase() === v.toLowerCase()),
    );
    return hit ? hit.letter : v;
}

export function toggleMappingMode(buttonElement) {
    const group = buttonElement?.closest?.('.sheet-input-group');
    if (!group) return;
    const next = group.getAttribute('data-mode') === 'manual' ? 'select' : 'manual';
    group.setAttribute('data-mode', next);
    buttonElement.setAttribute('aria-pressed', next === 'manual' ? 'true' : 'false');
    buttonElement.title = next === 'manual' ? 'Заголовки з таблиці' : 'Вручну';
}

function readSmartRowValue(key) {
    const row = document.querySelector(`[data-smart-field="${key}"]`);
    if (!row) return '';
    const group = row.querySelector('.sheet-input-group');
    if (!group) return '';
    const mode = group.getAttribute('data-mode') === 'manual' ? 'manual' : 'select';
    if (mode === 'manual') {
        const inp = group.querySelector('.sheet-input-group__manual');
        return (inp?.value || '').trim();
    }
    const sel = group.querySelector('.sheet-input-group__select');
    return (sel?.value || '').trim();
}

function setSmartRowValue(key, value, preferManual) {
    const row = document.querySelector(`[data-smart-field="${key}"]`);
    if (!row) return;
    const group = row.querySelector('.sheet-input-group');
    const sel = group?.querySelector('.sheet-input-group__select');
    const inp = group?.querySelector('.sheet-input-group__manual');
    const toggle = group?.querySelector('.sheet-input-group__toggle');
    if (!group || !sel || !inp) return;

    let v = typeof value === 'string' ? value.trim() : '';
    if (!v) {
        group.setAttribute('data-mode', 'select');
        sel.value = '';
        inp.value = '';
        if (toggle) {
            toggle.setAttribute('aria-pressed', 'false');
            toggle.title = 'Вручну';
        }
        return;
    }

    if (!v.includes(',')) {
        v = resolveMappingValueToSelectLetter(v);
    }

    const useManual = preferManual || !isPresetValue(v);

    if (useManual) {
        group.setAttribute('data-mode', 'manual');
        sel.value = '';
        inp.value = v;
        if (toggle) {
            toggle.setAttribute('aria-pressed', 'true');
            toggle.title = 'Заголовки з таблиці';
        }
    } else {
        group.setAttribute('data-mode', 'select');
        sel.value = v;
        inp.value = '';
        if (toggle) {
            toggle.setAttribute('aria-pressed', 'false');
            toggle.title = 'Вручну';
        }
    }
}

function readStoredConfig() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : null;
    } catch {
        return null;
    }
}

function applyConfigToForm(cfg) {
    if (!cfg) return;

    if (cfg.smartColumns && typeof cfg.smartColumns === 'object') {
        SMART_KEYS.forEach((k) => {
            setSmartRowValue(k, cfg.smartColumns[k] || '', false);
        });
        return;
    }

    if (cfg.columns && typeof cfg.columns === 'object') {
        const c = cfg.columns;
        setSmartRowValue('date', c.date || '', true);
        setSmartRowValue('tradeType', c.tradeType || '', true);
        setSmartRowValue('profit', c.profit || '', true);
        setSmartRowValue('pv', c.pv || '', true);
        const ex = Array.isArray(c.exceptions) ? c.exceptions.join(', ') : (c.exceptions || '');
        setSmartRowValue('exceptions', ex, true);
    }
}

let _sheetFormHydratedFromStorage = false;

export function initSheetTableView() {
    syncSheetWorkspaceVisibility();
    const needHydrate = !_sheetFormHydratedFromStorage;
    if (needHydrate) {
        applyConfigToForm(readStoredConfig());
        _sheetFormHydratedFromStorage = true;
    }
    void import('./google_sheet_connector.js')
        .then((m) => m.restoreGoogleSession?.())
        .catch(() => {
            /* конектор може бути недоступний офлайн */
        });
}

function collectFormConfig() {
    const smartColumns = {};
    SMART_KEYS.forEach((k) => {
        smartColumns[k] = readSmartRowValue(k);
    });

    const spreadsheetId = sessionStorage.getItem(SESSION_SPREADSHEET_ID) || '';
    const title =
        el('sheet-selected-file-name')?.textContent?.trim() ||
        sessionStorage.getItem(SESSION_SPREADSHEET_TITLE) ||
        '';

    return {
        version: 3,
        savedAt: new Date().toISOString(),
        spreadsheetId,
        selectedFileName: title,
        sheetHeaders: _dynamicHeaders,
        smartColumns,
    };
}

const BTN_DEFAULT = 'Зберегти мапінг та продовжити';
const BTN_LOADING = "З'єднання...";

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function saveSheetMapping() {
    const btn = el('sheet-save-sync-btn');
    const prevText = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = BTN_LOADING;
    }

    try {
        await sleep(650);
        const cfg = collectFormConfig();
        localStorage.setItem(LS_KEY, JSON.stringify(cfg));
        _sheetFormHydratedFromStorage = true;
        showToast('Мапінг збережено локально.');
    } catch (e) {
        showToast('Не вдалося зберегти: ' + (e?.message || String(e)));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = prevText || BTN_DEFAULT;
        }
    }
}

window.toggleMappingMode = toggleMappingMode;
window.saveSheetMapping = saveSheetMapping;
window.renderMappingDropdowns = renderMappingDropdowns;
window.populateSheetMappingFromHeaders = populateSheetMappingFromHeaders;
