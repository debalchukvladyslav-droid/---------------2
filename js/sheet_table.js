// === js/sheet_table.js — Google Sheets UI + мапінг (стани, збереження) ===
//
// Угоди з таблиці: зі стартового рядка (типово 6, або з вибраної клітинки на preview, напр. A8/B8).
// У колонці «Дата» зустрічається день — запам’ятовуємо
// активну дату для всіх нижніх рядків; у колонці «Тікер» непорожня клітинка (напр. B8 = USEG)
// означає угоду: читаємо весь рядок 8 і пишемо в журнал.

import { showToast } from './utils.js';
import { state } from './state.js';
import { supabase } from './supabase.js';
import { getDefaultDayEntry } from './data_utils.js';
import { saveJournalData, markJournalDayDirty } from './storage.js';
import { syncFondexxFromTradesForDay, logTradesImportConsole } from './parsers.js';
import { clearStatsCache } from './stats.js';
import { parseSheetDateCellToIso } from './parser_utils.js';

const LS_KEY = 'tj_google_sheet_import_v1';

/** Підключено до Google (після OAuth). */
const SESSION_GOOGLE = 'sheet_google_connected';
/** Обрана таблиця (Spreadsheet ID). */
const SESSION_SPREADSHEET_ID = 'sheet_spreadsheet_id';
const SESSION_SPREADSHEET_TITLE = 'sheet_spreadsheet_title';
const SESSION_SHEET_TITLE = 'sheet_selected_sheet_title';

/** Колонки таблиці / trade.sheet для статистики та datagrid (порядок = у формі). */
const SMART_KEYS = [
    'date',
    'time',
    'symbol',
    'tradeType',
    'profit',
    'pv',
    'altPv',
    'exceptions',
    'traderComment',
    'exit',
    'teamLeadComment',
    'paperType',
    'period',
    'growthPct',
    'riskUsd',
    'consolidateCents',
    'entryPrice',
    'qtyShares',
    'qtySharesCalc',
];

/** Перший рядок даних угод у Google Sheets (1-based). */
const SHEET_DATA_FIRST_ROW = 6;

let _sheetAutoTimer = null;
let _sheetSyncInProgress = false;

/** Зупинити авто-синхронізацію (вихід з Google, зміна профілю). */
export function stopSheetAutoSync() {
    if (_sheetAutoTimer) {
        clearInterval(_sheetAutoTimer);
        _sheetAutoTimer = null;
    }
}

function clampSheetIntervalMin(n) {
    return Math.min(60, Math.max(5, Number(n) || 15));
}

/**
 * Інтервал з localStorage: лише якщо увімкнено, є файл і токен.
 * Не викликає API, коли вкладка прихована або вже йде синхронізація.
 */
export function ensureSheetAutoSyncFromConfig() {
    stopSheetAutoSync();
    const cfg = readStoredConfig();
    if (!cfg?.autoSync?.enabled) return;
    if (sessionStorage.getItem(SESSION_GOOGLE) !== '1') return;
    if (!sessionStorage.getItem(SESSION_SPREADSHEET_ID)) return;
    const min = clampSheetIntervalMin(cfg.autoSync.intervalMinutes);
    _sheetAutoTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (_sheetSyncInProgress) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        void (async () => {
            try {
                const c = readStoredConfig();
                if (!c?.spreadsheetId || !c?.smartColumns) return;
                await executeSyncWithCfg(c, { quiet: true });
            } catch (e) {
                console.warn('[Google Sheets] авто-синхронізація:', e?.message || e);
            }
        })();
    }, min * 60 * 1000);
}

/** Статичні приклади (старі збереження) + динаміка з таблиці. */
const PRESET_FALLBACK = ['Date', 'Ticker', 'Symbol', 'Profit/Loss', 'Notes'];

let _dynamicHeaders = [];
/** Пари літера колонки ↔ текст заголовка з рядка A1:Z1 (value у select = літера). */
let _dynamicColumnChoices = [];
let _sheetPreviewRows = [];
let _sheetPreviewHoverRef = null;
let _sheetPreviewActiveField = 'date';
let _sheetSmartAnchors = {};
let _sheetGridBindingsReady = false;
let _sheetGridZoom = 1;
let _sheetSessionRestoreStarted = false;

function el(id) {
    return document.getElementById(id);
}

/** A → 0, B → 1, Z → 25, AA → 26. */
export function columnLetterToIndex(letters) {
    const s = String(letters || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
    if (!s) return -1;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i) - 64;
        if (c < 1 || c > 26) return -1;
        n = n * 26 + c;
    }
    return n - 1;
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

function parseCellReference(raw) {
    const v = String(raw || '').trim().toUpperCase();
    const m = /^([A-Z]{1,3})(\d+)$/.exec(v);
    if (!m) return null;
    return {
        ref: `${m[1]}${Number(m[2])}`,
        letter: m[1],
        row: Number(m[2]),
        colIndex: columnLetterToIndex(m[1]),
    };
}

function getStoredAnchorForField(field) {
    const raw = _sheetSmartAnchors?.[field];
    const parsed = parseCellReference(raw);
    return parsed ? parsed.ref : '';
}

function deriveSheetStartRow(anchors = _sheetSmartAnchors, fallback = SHEET_DATA_FIRST_ROW) {
    const preferred = ['date', 'symbol']
        .map((key) => parseCellReference(anchors?.[key]))
        .filter(Boolean)
        .map((cell) => cell.row);
    if (preferred.length) return Math.min(...preferred);

    const anyRows = Object.values(anchors || {})
        .map((value) => parseCellReference(value))
        .filter(Boolean)
        .map((cell) => cell.row);
    return anyRows.length ? Math.min(...anyRows) : fallback;
}

function smartFieldLabel(field) {
    const row = document.querySelector(`[data-smart-field="${field}"] .sheet-smart-row__label`);
    return row?.textContent?.trim() || field || '—';
}

function smartFieldRanges(field) {
    const anchor = parseCellReference(_sheetSmartAnchors?.[field]);
    if (anchor) return [`${anchor.letter}${anchor.row}:${anchor.letter}`];

    const value = readSmartRowValue(field);
    const startRow = deriveSheetStartRow();
    return String(value || '')
        .split(',')
        .map(v => v.trim().toUpperCase())
        .map(v => parseColumnRangeToken(v) || (/^[A-Z]{1,3}$/.test(v) ? { letter: v, row: null } : null))
        .filter(Boolean)
        .map(({ letter, row }) => `${letter}${row || startRow}:${letter}`);
}

function updateSmartRangeHints() {
    document.querySelectorAll('.sheet-smart-row[data-smart-field]').forEach(row => {
        const field = row.dataset.smartField || '';
        const hint = row.querySelector('.sheet-smart-row__hint');
        if (!hint) return;
        if (hint.dataset.baseHint == null) hint.dataset.baseHint = hint.textContent.trim();

        const baseHint = hint.dataset.baseHint || '';
        const ranges = smartFieldRanges(field);
        hint.textContent = baseHint;

        if (!ranges.length) return;
        if (baseHint) hint.appendChild(document.createTextNode(' '));
        const badge = document.createElement('span');
        badge.className = 'sheet-smart-row__range';
        badge.textContent = `Діапазон: ${ranges.join(', ')}`;
        hint.appendChild(badge);
    });
}

function updateGridPickerMeta() {
    const activeEl = el('sheet-grid-picker-active');
    const startRowEl = el('sheet-grid-picker-start-row');
    const zoomEl = el('sheet-grid-zoom-label');
    if (activeEl) activeEl.textContent = smartFieldLabel(_sheetPreviewActiveField);
    if (startRowEl) startRowEl.textContent = String(deriveSheetStartRow());
    if (zoomEl) zoomEl.textContent = `${Math.round(_sheetGridZoom * 100)}%`;
    updateSmartRangeHints();
}

function applySheetGridZoom() {
    const preview = el('sheet-grid-picker-preview');
    if (preview) preview.style.setProperty('--sheet-grid-zoom', String(_sheetGridZoom));
    updateGridPickerMeta();
}

export function changeSheetGridZoom(delta) {
    const next = Math.round(Math.min(1.6, Math.max(0.65, _sheetGridZoom + Number(delta || 0))) * 100) / 100;
    if (next === _sheetGridZoom) return;
    _sheetGridZoom = next;
    applySheetGridZoom();
}

function scrollSheetPreviewToBottom() {
    const preview = el('sheet-grid-picker-preview');
    if (!preview || !_sheetPreviewRows.length) return;
    requestAnimationFrame(() => {
        preview.scrollTop = preview.scrollHeight;
    });
}

function syncActiveGridFieldUi() {
    document.querySelectorAll('.sheet-smart-row[data-smart-field]').forEach((row) => {
        row.classList.toggle('is-grid-active', row.dataset.smartField === _sheetPreviewActiveField);
    });
    updateGridPickerMeta();
    refreshSheetGridSelectionClasses();
}

function setActiveGridField(field) {
    if (!field) return;
    _sheetPreviewActiveField = field;
    syncActiveGridFieldUi();
}

function setSmartAnchor(field, ref) {
    if (!field) return;
    const parsed = parseCellReference(ref);
    if (parsed) _sheetSmartAnchors[field] = parsed.ref;
    else delete _sheetSmartAnchors[field];
    updateGridPickerMeta();
    refreshSheetGridSelectionClasses();
}

export function clearSheetPreviewData() {
    _sheetPreviewRows = [];
    _sheetPreviewHoverRef = null;
    const preview = el('sheet-grid-picker-preview');
    if (preview) {
        preview.innerHTML = '<div class="sheet-grid-picker__empty">Після вибору таблиці тут з’явиться інтерактивне прев’ю.</div>';
    }
    updateGridPickerMeta();
}

function buildSheetGridPreview() {
    const preview = el('sheet-grid-picker-preview');
    if (!preview) return;
    if (!_sheetPreviewRows.length) {
        clearSheetPreviewData();
        return;
    }

    const table = document.createElement('table');
    table.className = 'sheet-grid';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'sheet-grid__corner';
    corner.textContent = '';
    headRow.appendChild(corner);

    const maxCols = Math.max(..._sheetPreviewRows.map((row) => row.length), 0);
    for (let colIndex = 0; colIndex < maxCols; colIndex++) {
        const th = document.createElement('th');
        th.className = 'sheet-grid__col-head';
        th.dataset.colLetter = indexToColumnLetter(colIndex);
        th.textContent = indexToColumnLetter(colIndex);
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    _sheetPreviewRows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        const excelRow = rowIndex + 1;

        const th = document.createElement('th');
        th.className = 'sheet-grid__row-head';
        th.dataset.rowNumber = String(excelRow);
        th.textContent = String(excelRow);
        tr.appendChild(th);

        for (let colIndex = 0; colIndex < maxCols; colIndex++) {
            const letter = indexToColumnLetter(colIndex);
            const cell = document.createElement('td');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sheet-grid__cell';
            btn.dataset.colLetter = letter;
            btn.dataset.rowNumber = String(excelRow);
            btn.dataset.cellRef = `${letter}${excelRow}`;
            btn.textContent = row[colIndex] != null ? String(row[colIndex]) : '';
            btn.title = `${letter}${excelRow}`;
            cell.appendChild(btn);
            tr.appendChild(cell);
        }
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    preview.innerHTML = '';
    applySheetGridZoom();
    preview.appendChild(table);
    refreshSheetGridSelectionClasses();
    scrollSheetPreviewToBottom();
}

function refreshSheetGridSelectionClasses() {
    const preview = el('sheet-grid-picker-preview');
    if (!preview) return;
    const selected = parseCellReference(getStoredAnchorForField(_sheetPreviewActiveField));
    const hover = parseCellReference(_sheetPreviewHoverRef);

    preview.querySelectorAll('.is-hover-range, .is-selected-range, .is-selected-start').forEach((node) => {
        node.classList.remove('is-hover-range', 'is-selected-range', 'is-selected-start');
    });

    preview.querySelectorAll('.sheet-grid__col-head').forEach((node) => {
        const colLetter = node.dataset.colLetter || '';
        if (hover && colLetter === hover.letter) node.classList.add('is-hover-range');
        if (selected && colLetter === selected.letter) node.classList.add('is-selected-range');
    });

    preview.querySelectorAll('.sheet-grid__row-head').forEach((node) => {
        const rowNumber = Number(node.dataset.rowNumber || 0);
        if (selected && rowNumber === selected.row) node.classList.add('is-selected-start');
    });

    preview.querySelectorAll('.sheet-grid__cell').forEach((node) => {
        const colLetter = node.dataset.colLetter || '';
        const rowNumber = Number(node.dataset.rowNumber || 0);
        if (hover && colLetter === hover.letter && rowNumber >= hover.row) node.classList.add('is-hover-range');
        if (selected && colLetter === selected.letter && rowNumber >= selected.row) {
            node.classList.add('is-selected-range');
            if (rowNumber === selected.row) node.classList.add('is-selected-start');
        }
    });
}

export function setSheetPreviewData(rows) {
    _sheetPreviewRows = Array.isArray(rows) ? rows : [];
    _sheetPreviewHoverRef = null;
    buildSheetGridPreview();
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
    if (cfg?.autoSync && typeof cfg.autoSync === 'object') {
        const en = el('sheet-auto-sync-enabled');
        const iv = el('sheet-auto-sync-interval');
        if (en) en.checked = !!cfg.autoSync.enabled;
        if (iv) iv.value = String(clampSheetIntervalMin(cfg.autoSync.intervalMinutes));
    }
    syncActiveGridFieldUi();
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

export function getSelectedSheetTitle() {
    return sessionStorage.getItem(SESSION_SHEET_TITLE) || '';
}

export function setSpreadsheetSheets(sheets, selectedTitle = '') {
    const list = Array.isArray(sheets) ? sheets.filter(s => s && s.title) : [];
    const picker = el('sheet-tab-picker');
    const select = el('sheet-tab-select');
    if (!picker || !select) return;

    select.innerHTML = '';
    list.forEach(sheet => {
        const option = document.createElement('option');
        option.value = sheet.title;
        option.textContent = sheet.title;
        select.appendChild(option);
    });

    const stored = selectedTitle || sessionStorage.getItem(SESSION_SHEET_TITLE) || list[0]?.title || '';
    if (stored && list.some(sheet => sheet.title === stored)) {
        select.value = stored;
        sessionStorage.setItem(SESSION_SHEET_TITLE, stored);
    } else if (list[0]) {
        select.value = list[0].title;
        sessionStorage.setItem(SESSION_SHEET_TITLE, list[0].title);
    } else {
        sessionStorage.removeItem(SESSION_SHEET_TITLE);
    }

    picker.hidden = list.length <= 1;
}

export function clearGoogleSheetSession() {
    stopSheetAutoSync();
    sessionStorage.removeItem(SESSION_GOOGLE);
    sessionStorage.removeItem(SESSION_SPREADSHEET_ID);
    sessionStorage.removeItem(SESSION_SPREADSHEET_TITLE);
    sessionStorage.removeItem(SESSION_SHEET_TITLE);
    sessionStorage.removeItem('sheet_google_access_token');
    const nameEl = el('sheet-selected-file-name');
    if (nameEl) nameEl.textContent = '—';
    setSpreadsheetSheets([]);
}

export function syncSheetWorkspaceVisibility() {
    const connected = sessionStorage.getItem(SESSION_GOOGLE) === '1';
    const fileOk = !!sessionStorage.getItem(SESSION_SPREADSHEET_ID);

    const s1 = el('sheet-state-connect');
    const s2 = el('sheet-state-workspace');
    const fileCard = el('sheet-mock-file-card');
    const mapping = el('sheet-smart-mapping');
    const tabPicker = el('sheet-tab-picker');

    if (s1) s1.hidden = connected;
    if (s2) s2.hidden = !connected;
    if (fileCard) fileCard.hidden = !connected || !fileOk;
    if (mapping) mapping.hidden = !connected || !fileOk;
    if (tabPicker && (!connected || !fileOk)) tabPicker.hidden = true;
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

function parseColumnRangeToken(raw) {
    const v = String(raw || '').trim().toUpperCase().replace(/\$/g, '');
    if (!v) return null;

    let match = /^([A-Z]{1,3})(\d+)?(?::([A-Z]{1,3}))?$/.exec(v);
    if (match && (!match[3] || match[3] === match[1])) {
        return {
            letter: match[1],
            row: match[2] ? Number(match[2]) : null,
        };
    }

    match = /^([A-Z]{1,3})(\d+)?:([A-Z]{1,3})(\d+)?$/.exec(v);
    if (match && match[1] === match[3]) {
        return {
            letter: match[1],
            row: match[2] ? Number(match[2]) : null,
        };
    }

    return null;
}

function isPresetValue(v) {
    if (isColumnLetterToken(v)) return true;
    return getKnownColumnValues().has(v);
}

/** Підставляє літеру колонки, якщо збережено старий текст заголовка з таблиці. */
function resolveMappingValueToSelectLetter(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v || v.includes(',')) return v;
    const rangeToken = parseColumnRangeToken(v);
    if (rangeToken) return rangeToken.letter;
    if (isColumnLetterToken(v)) return v.toUpperCase();
    if (!_dynamicColumnChoices.length) return v;
    const hit = _dynamicColumnChoices.find(
        (c) => c.header === v || (c.header && c.header.toLowerCase() === v.toLowerCase()),
    );
    return hit ? hit.letter : v;
}

function smartValueToColumnIndex(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v || v.includes(',')) return -1;
    const rangeToken = parseColumnRangeToken(v);
    const letter = rangeToken ? rangeToken.letter : isColumnLetterToken(v) ? v.toUpperCase() : resolveMappingValueToSelectLetter(v);
    if (!letter || letter.includes(',')) return -1;
    return columnLetterToIndex(letter);
}

/** Ручний режим виключень: "D, E, F" → індекси колонок. */
function parseExceptionColumnIndices(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return [];
    const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
        const idx = smartValueToColumnIndex(p);
        if (idx >= 0) out.push(idx);
    }
    return out;
}

function getCell(row, colIdx) {
    if (colIdx < 0 || !Array.isArray(row)) return '';
    return row[colIdx] != null && row[colIdx] !== '' ? row[colIdx] : '';
}

function parseMoneyCell(v) {
    if (v == null || v === '') return 0;
    const s = String(v).replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
}

function parseOptionalNumber(v) {
    if (v == null || String(v).trim() === '') return null;
    const s = String(v).replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function computeStopFromEntryAndCents(entryPrice, consolidateCents) {
    const entry = Number(entryPrice);
    const cents = parseOptionalNumber(consolidateCents);
    if (!Number.isFinite(entry) || cents == null) return null;
    return Math.round((entry + cents / 100) * 10000) / 10000;
}

/** Перевірка YYYY-MM-DD (щоб не писати в Supabase «2026-13-03»). */
function isValidIsoDateString(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toIsoFromParts(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayIsoDate() {
    const now = new Date();
    return toIsoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isFutureIsoDateString(iso) {
    return isValidIsoDateString(iso) && iso > todayIsoDate();
}

/** Чи існує такий день у календарі (UTC). */
function calendarYmdValid(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * Дата з клітинки Sheets: YYYY-MM-DD, серійне число, D/M/Y з «.» або «/».
 * Для вашої таблиці slash-формат читаємо як день/місяць: 12/3/2026 = 2026-03-12.
 */
function sheetsCellToIsoDate(value) {
    return parseSheetDateCellToIso(value);
}

function sheetsCellToTimeString(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
        const fraction = value - Math.floor(value);
        if (fraction > 0) {
            const totalMinutes = Math.round(fraction * 24 * 60);
            const hh = Math.floor(totalMinutes / 60) % 24;
            const mm = totalMinutes % 60;
            return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
        }
    }
    const s = String(value).trim();
    const m = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(s);
    if (!m) return '';
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3] || 0);
    const ampm = m[4]?.toUpperCase();
    if (ampm === 'PM' && hh < 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    if (hh > 23 || mm > 59 || ss > 59) return '';
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function isLikelyTicker(v) {
    const t = String(v).trim().toUpperCase();
    if (t.length < 1 || t.length > 15) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
    if (/^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(String(v).trim())) return false;
    if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(t)) return false;
    if (/^\d+$/.test(t) && t.length > 5) return false;
    return true;
}

/**
 * @param {string[][]} values — рядки з API, перший рядок = Excel-рядок startRow
 * @param {Record<string, string>} smartColumns
 * @param {string} spreadsheetId
 */
function parseSheetGridToTrades(values, smartColumns, spreadsheetId, startRow = SHEET_DATA_FIRST_ROW) {
    const dateIdx = smartValueToColumnIndex(smartColumns.date || '');
    const timeIdx = smartValueToColumnIndex(smartColumns.time || '');
    const symIdx = smartValueToColumnIndex(smartColumns.symbol || '');
    const profitIdx = smartValueToColumnIndex(smartColumns.profit || '');
    const typeIdx = smartValueToColumnIndex(smartColumns.tradeType || '');
    const pvIdx = smartValueToColumnIndex(smartColumns.pv || '');
    const altPvIdx = smartValueToColumnIndex(smartColumns.altPv || '');
    const exModeManual = typeof smartColumns.exceptions === 'string' && smartColumns.exceptions.includes(',');
    const exSelectIdx = exModeManual ? -1 : smartValueToColumnIndex(smartColumns.exceptions || '');
    const exMultiIdx = exModeManual ? parseExceptionColumnIndices(smartColumns.exceptions || '') : [];

    const cTrader = smartValueToColumnIndex(smartColumns.traderComment || '');
    const cExit = smartValueToColumnIndex(smartColumns.exit || '');
    const cTeam = smartValueToColumnIndex(smartColumns.teamLeadComment || '');
    const cPaper = smartValueToColumnIndex(smartColumns.paperType || '');
    const cPeriod = smartValueToColumnIndex(smartColumns.period || '');
    const cGrowth = smartValueToColumnIndex(smartColumns.growthPct || '');
    const cRisk = smartValueToColumnIndex(smartColumns.riskUsd || '');
    const cCons = smartValueToColumnIndex(smartColumns.consolidateCents || '');
    const cEntry = smartValueToColumnIndex(smartColumns.entryPrice || '');
    const cQty = smartValueToColumnIndex(smartColumns.qtyShares || '');
    const cQtyCalc = smartValueToColumnIndex(smartColumns.qtySharesCalc || '');

    const dateAnchors = {};
    const outByDay = {};
    let activeDate = null;

    if (!Array.isArray(values)) {
        return { outByDay, dateAnchors, stats: { tradeCount: 0, dayCount: 0 } };
    }

    for (let i = 0; i < values.length; i++) {
        const row = values[i] || [];
        const excelRow = startRow + i;

        const dateRaw = getCell(row, dateIdx);
        const parsedDate = sheetsCellToIsoDate(dateRaw);
        if (parsedDate) {
            activeDate = parsedDate;
            if (dateAnchors[parsedDate] == null) dateAnchors[parsedDate] = excelRow;
        }

        const symRaw = getCell(row, symIdx);
        if (!activeDate || symRaw === '' || symRaw == null) continue;
        if (!isLikelyTicker(symRaw)) continue;

        const symbol = String(symRaw).trim().toUpperCase();
        const parsedTime = sheetsCellToTimeString(timeIdx >= 0 ? getCell(row, timeIdx) : dateRaw);
        const timeStr = parsedTime || '09:30:00';
        const net = profitIdx >= 0 ? parseMoneyCell(getCell(row, profitIdx)) : 0;
        const gross = net;
        const typeCell = typeIdx >= 0 ? String(getCell(row, typeIdx)).trim() : '';

        let exceptionStr = '';
        if (exSelectIdx >= 0) {
            exceptionStr = String(getCell(row, exSelectIdx)).trim();
        } else if (exMultiIdx.length) {
            exceptionStr = exMultiIdx
                .map((ix) => String(getCell(row, ix)).trim())
                .filter(Boolean)
                .join('; ');
        }

        const pvCell = pvIdx >= 0 ? getCell(row, pvIdx) : '';
        const altPvStr = cellStr(row, altPvIdx);
        const exitStr = cellStr(row, cExit);
        const entryNum = cEntry >= 0 ? parseMoneyCell(getCell(row, cEntry)) : NaN;
        const consolidateCents = cellStr(row, cCons);
        const stopPrice = computeStopFromEntryAndCents(entryNum, consolidateCents);
        const qtyRaw =
            cQty >= 0 ? String(getCell(row, cQty)).replace(/\s/g, '').replace(/,/g, '') : '';
        const qtyNum = qtyRaw !== '' ? parseFloat(qtyRaw) : NaN;

        const sheet = {
            source: 'google',
            spreadsheetId,
            sheetRow: excelRow,
            sheetTime: parsedTime || undefined,
            sheetNet: net,
            sheetGross: gross,
            tradeType: typeCell || undefined,
            pv: pvCell !== '' && pvCell != null ? String(pvCell) : undefined,
            altPv: altPvStr || undefined,
            exception: exceptionStr || undefined,
            exceptions: exceptionStr ? [exceptionStr] : undefined,
            traderComment: cellStr(row, cTrader) || undefined,
            exit: exitStr || undefined,
            teamLeadComment: cellStr(row, cTeam) || undefined,
            paperType: cellStr(row, cPaper) || undefined,
            period: cellStr(row, cPeriod) || undefined,
            growthPct: cellStr(row, cGrowth) || undefined,
            riskUsd: cellStr(row, cRisk) || undefined,
            consolidateCents: consolidateCents || undefined,
            entryPrice: Number.isFinite(entryNum) && entryNum !== 0 ? entryNum : undefined,
            stopPrice: stopPrice ?? undefined,
            qtyShares: Number.isFinite(qtyNum) && qtyNum !== 0 ? qtyNum : undefined,
            qtySharesCalc: cellStr(row, cQtyCalc) || undefined,
        };

        const trade = {
            symbol,
            type: typeCell || 'Google Sheet',
            opened: `${activeDate} ${timeStr}`,
            closed: `${activeDate} 16:00:00`,
            held: '',
            entry: Number.isFinite(entryNum) ? entryNum : 0,
            exit: 0,
            stop: stopPrice ?? undefined,
            qty: Number.isFinite(qtyNum) ? Math.round(qtyNum) : 0,
            gross,
            comm: 0,
            net,
            sheet,
        };

        if (!outByDay[activeDate]) outByDay[activeDate] = [];
        outByDay[activeDate].push(trade);
    }

    const dates = Object.keys(outByDay);
    const tradeCount = dates.reduce((n, d) => n + outByDay[d].length, 0);
    return {
        outByDay,
        dateAnchors,
        stats: { tradeCount, dayCount: dates.length },
    };
}

function normalizeTradeSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function tradeTimeMinutes(opened) {
    const m = /\b(\d{1,2}):(\d{2})(?::\d{2})?/.exec(String(opened || ''));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

function pnlTolerance(value) {
    const n = Math.abs(Number(value) || 0);
    return Math.max(5, n * 0.08);
}

function findSheetMatchIndex(existingTrades, incomingTrade, usedIndices) {
    const symbol = normalizeTradeSymbol(incomingTrade?.symbol);
    if (!symbol) return -1;

    const incomingNet = Number(incomingTrade?.net);
    const candidates = [];

    existingTrades.forEach((trade, index) => {
        if (usedIndices.has(index)) return;
        if (normalizeTradeSymbol(trade?.symbol) !== symbol) return;
        const existingNet = Number(trade?.net);
        const hasPnl = Number.isFinite(existingNet) && Number.isFinite(incomingNet);
        const pnlDiff = hasPnl ? Math.abs(existingNet - incomingNet) : Number.POSITIVE_INFINITY;
        const okByPnl = hasPnl && pnlDiff <= pnlTolerance(incomingNet);
        const noSheetYet = !trade?.sheet || trade.sheet.source !== 'google';
        if (hasPnl && !okByPnl) return;
        if (!hasPnl && !noSheetYet) return;
        const existingMin = tradeTimeMinutes(trade?.opened);
        const incomingMin = incomingTrade?.sheet?.sheetTime ? tradeTimeMinutes(incomingTrade.opened) : null;
        const timeDiff = existingMin != null && incomingMin != null ? Math.abs(existingMin - incomingMin) : null;
        if (timeDiff != null && timeDiff > 90) return;
        candidates.push({
            index,
            score: (okByPnl ? 1000 - pnlDiff : 10) + (noSheetYet ? 20 : 0) + (timeDiff != null ? Math.max(0, 90 - timeDiff) : 0),
        });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.index ?? -1;
}

function enrichTradeWithSheet(existingTrade, incomingTrade) {
    const sheet = {
        ...(existingTrade.sheet && typeof existingTrade.sheet === 'object' ? existingTrade.sheet : {}),
        ...(incomingTrade.sheet || {}),
        matchedBy: incomingTrade.sheet?.sheetTime ? 'date+ticker+pnl+time' : 'date+ticker+pnl',
    };

    return {
        ...existingTrade,
        type: existingTrade.type || incomingTrade.type,
        entry: Number(existingTrade.entry) ? existingTrade.entry : incomingTrade.entry,
        exit: Number(existingTrade.exit) ? existingTrade.exit : incomingTrade.exit,
        qty: Number(existingTrade.qty) ? existingTrade.qty : incomingTrade.qty,
        stop: existingTrade.stop ?? incomingTrade.stop,
        sheet,
    };
}

function isSameSpreadsheetGoogleTrade(trade, spreadsheetId) {
    return !!(
        trade?.sheet &&
        trade.sheet.source === 'google' &&
        String(trade.sheet.spreadsheetId || '') === String(spreadsheetId)
    );
}

function isPureGoogleSheetTrade(trade, spreadsheetId) {
    return isSameSpreadsheetGoogleTrade(trade, spreadsheetId) && !trade.sheet?.matchedBy;
}

function sumTradeMoney(trades = []) {
    return trades.reduce((sum, trade) => {
        sum.gross += Number(trade?.gross) || 0;
        sum.net += Number(trade?.net) || 0;
        sum.comm += Number(trade?.comm) || 0;
        return sum;
    }, { gross: 0, net: 0, comm: 0 });
}

function almostEqualMoney(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
}

function fondexxLooksDerivedFromTrades(fondexx, trades) {
    if (!fondexx || typeof fondexx !== 'object' || !Array.isArray(trades) || trades.length === 0) return false;
    const totals = sumTradeMoney(trades);
    return almostEqualMoney(fondexx.gross, totals.gross)
        && almostEqualMoney(fondexx.net, totals.net)
        && almostEqualMoney(fondexx.comm, totals.comm);
}

function hasAnyScreenshot(day) {
    const screens = day?.screenshots && typeof day.screenshots === 'object' ? day.screenshots : {};
    return Object.values(screens).some((items) => Array.isArray(items) && items.length > 0);
}

function hasNonEmptyObject(value) {
    return value && typeof value === 'object' && Object.keys(value).length > 0;
}

function isDayEmptyAfterSheetCleanup(day) {
    if (!day || typeof day !== 'object') return true;
    if (Array.isArray(day.trades) && day.trades.length > 0) return false;
    if (String(day.notes || '').trim() || String(day.mentor_comment || '').trim()) return false;
    if (hasAnyScreenshot(day)) return false;
    if (Array.isArray(day.errors) && day.errors.length > 0) return false;
    if (Array.isArray(day.checkedParams) && day.checkedParams.length > 0) return false;
    if (hasNonEmptyObject(day.sliders) || hasNonEmptyObject(day.tradeTypesData) || hasNonEmptyObject(day.review_requests)) return false;
    if (String(day.sessionGoal || '').trim() || String(day.sessionPlan || '').trim() || day.sessionDone) return false;
    const fondexx = day.fondexx && typeof day.fondexx === 'object' ? day.fondexx : {};
    if (Number(fondexx.net) || Number(fondexx.gross) || Number(fondexx.comm) || Number(fondexx.locates)) return false;
    const ppro = day.ppro && typeof day.ppro === 'object' ? day.ppro : {};
    if (Number(ppro.net) || Number(ppro.gross) || Number(ppro.comm) || Number(ppro.locates)) return false;
    return true;
}

function cleanupPreviousGoogleSheetImport(spreadsheetId) {
    const deletedDates = [];
    const touchedDates = [];
    const journal = state.appData?.journal || {};

    Object.keys(journal).forEach((dateStr) => {
        const day = journal[dateStr];
        const trades = Array.isArray(day?.trades) ? day.trades : [];
        const removedTrades = trades.filter((trade) => isPureGoogleSheetTrade(trade, spreadsheetId));
        const nextTrades = trades.filter((trade) => !isPureGoogleSheetTrade(trade, spreadsheetId));
        if (nextTrades.length === trades.length) return;

        const clearSheetDerivedFondexx = nextTrades.length === 0 && fondexxLooksDerivedFromTrades(day.fondexx, removedTrades);
        day.trades = nextTrades;
        if (clearSheetDerivedFondexx) {
            day.fondexx = { gross: 0, net: 0, comm: 0, locates: Number(day.fondexx?.locates) || 0, tickers: [] };
            day.pnl = null;
            day.gross_pnl = null;
            day.commissions = null;
        }
        syncFondexxFromTradesForDay(dateStr);

        if (isDayEmptyAfterSheetCleanup(day)) {
            delete journal[dateStr];
            deletedDates.push(dateStr);
        } else {
            touchedDates.push(dateStr);
            markJournalDayDirty(dateStr);
        }
    });

    return { deletedDates, touchedDates };
}

function mergeGoogleSheetTradesIntoJournal(outByDay, spreadsheetId) {
    const cleanup = cleanupPreviousGoogleSheetImport(spreadsheetId);
    const touchedDates = new Set(cleanup.touchedDates);

    for (const dateStr of Object.keys(outByDay)) {
        if (!isValidIsoDateString(dateStr)) {
            console.warn('[Google Sheets] Пропущено невалідну дату (не пишемо в журнал):', dateStr);
            continue;
        }
        const incoming = outByDay[dateStr];
        if (!incoming.length) continue;
        if (!state.appData.journal[dateStr]) state.appData.journal[dateStr] = getDefaultDayEntry();
        const prev = Array.isArray(state.appData.journal[dateStr].trades)
            ? state.appData.journal[dateStr].trades
            : [];
        const kept = prev.filter((t) => !isPureGoogleSheetTrade(t, spreadsheetId));
        const usedIndices = new Set();
        const merged = [...kept];
        const appended = [];

        incoming.forEach((trade) => {
            const matchIndex = findSheetMatchIndex(merged, trade, usedIndices);
            if (matchIndex >= 0) {
                merged[matchIndex] = enrichTradeWithSheet(merged[matchIndex], trade);
                usedIndices.add(matchIndex);
            } else {
                appended.push(trade);
            }
        });

        state.appData.journal[dateStr].trades = [...merged, ...appended];
        syncFondexxFromTradesForDay(dateStr);
        markJournalDayDirty(dateStr);
        touchedDates.add(dateStr);
    }

    return { deletedDates: cleanup.deletedDates, touchedDates: [...touchedDates] };
}

async function deleteJournalDatesFromSupabase(dateStrs = []) {
    const uniqueDates = [...new Set(dateStrs)].filter((dateStr) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr));
    if (!uniqueDates.length) return;
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    if (!user?.id) return;

    for (let i = 0; i < uniqueDates.length; i += 100) {
        const chunk = uniqueDates.slice(i, i + 100);
        const { error } = await supabase
            .from('journal_days')
            .delete()
            .eq('user_id', user.id)
            .in('trade_date', chunk);
        if (error) throw error;
    }
}

function canMutateSheetSync(opts = {}) {
    const silent = !!opts.silent;
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        if (!silent) showToast('Синхронізація заборонена: переглядається чужий профіль.');
        return false;
    }
    return true;
}

function cellStr(row, colIdx) {
    if (colIdx < 0 || !Array.isArray(row)) return '';
    const v = row[colIdx];
    return v != null && String(v).trim() !== '' ? String(v).trim() : '';
}

/**
 * Одна синхронізація за збереженим cfg (ручна або тиха).
 * @param {{ quiet?: boolean }} options — quiet: без toast і зайвих логів (авто-режим).
 */
async function executeSyncWithCfg(cfg, options = {}) {
    const quiet = !!options.quiet;
    if (!canMutateSheetSync({ silent: quiet })) return { ok: false };

    const spreadsheetId = cfg.spreadsheetId || sessionStorage.getItem(SESSION_SPREADSHEET_ID) || '';
    if (!spreadsheetId) {
        if (!quiet) showToast('Оберіть таблицю на Google Диску.');
        return { ok: false };
    }

    const smart = cfg.smartColumns || {};
    const startRow = Math.max(1, Number(cfg.dataStartRow) || deriveSheetStartRow(cfg.smartAnchors || {}, SHEET_DATA_FIRST_ROW));
    const dateIdx = smartValueToColumnIndex(smart.date || '');
    const symIdx = smartValueToColumnIndex(smart.symbol || '');
    if (dateIdx < 0 || symIdx < 0) {
        if (!quiet) showToast('Для синхронізації оберіть колонки «Дата» та «Тікер» (зазвичай A і B).');
        return { ok: false };
    }

    const token = sessionStorage.getItem('sheet_google_access_token');
    if (!token) {
        if (!quiet) showToast('Немає доступу Google — увійдіть знову.');
        return { ok: false };
    }

    if (_sheetSyncInProgress) return { ok: false, skipped: true };
    _sheetSyncInProgress = true;

    try {
        const mod = await import('./google_sheet_connector.js');
        const values = await mod.fetchSpreadsheetValuesRange(spreadsheetId, `A${startRow}:ZZ2000`, cfg.sheetTitle || getSelectedSheetTitle());
        const { outByDay, dateAnchors, stats } = parseSheetGridToTrades(values, smart, spreadsheetId, startRow);

        if (!quiet) {
            console.group('[Google Sheets] Синхронізація');
            console.log('Таблиця:', cfg.selectedFileName || spreadsheetId);
            if (cfg.sheetTitle || getSelectedSheetTitle()) console.log('Лист:', cfg.sheetTitle || getSelectedSheetTitle());
            console.log('Якорі дат (перший рядок Excel з цією датою в колонці дати):', dateAnchors);
            console.groupEnd();
            logTradesImportConsole('Google Sheets → журнал', outByDay);
        }

        const mergeResult = mergeGoogleSheetTradesIntoJournal(outByDay, spreadsheetId);
        await deleteJournalDatesFromSupabase(mergeResult.deletedDates);
        await saveJournalData();
        try {
            clearStatsCache(state.USER_DOC_NAME);
        } catch (_) {
            /* ignore */
        }

        if (!quiet) {
            if (stats.tradeCount > 0) {
                console.log(
                    `[Google Sheets] Імпортовано у журнал: ${stats.tradeCount} угод у ${stats.dayCount} днях (рядки з ${startRow}).`,
                );
                showToast(`Синхронізовано: ${stats.tradeCount} угод у ${stats.dayCount} днях.`);
            } else {
                console.warn(
                        '[Google Sheets] Угод не знайдено: перевірте дати в колонці дати та тікери з рядка ' +
                        startRow +
                        ' (активна дата має бути вище рядка з тікером).',
                );
                showToast(`Угод у діапазоні не знайдено — перевірте колонки та рядок ${startRow}+.`);
            }
        }

        if (window.updateAutoFlags) window.updateAutoFlags();
        if (window.renderView) window.renderView();
        if (window.requestTradesDatagridRefresh) {
            window.requestTradesDatagridRefresh();
        } else if (document.getElementById('view-datagrid')?.classList.contains('active') && window.renderTradesDatagrid) {
            window.renderTradesDatagrid();
        }
        const viewStats = document.getElementById('view-stats');
        if (viewStats && viewStats.classList.contains('active') && window.refreshStatsView) {
            window.refreshStatsView();
        }
        if (window.selectDate) window.selectDate(state.selectedDateStr);

        return { ok: true, stats, dateAnchors };
    } catch (e) {
        if (!quiet) {
            console.error('[Google Sheets] sync', e);
            showToast('Помилка синхронізації: ' + (e?.message || String(e)));
        }
        throw e;
    } finally {
        _sheetSyncInProgress = false;
    }
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

function bindSheetGridPicker() {
    if (_sheetGridBindingsReady) return;
    _sheetGridBindingsReady = true;

    document.addEventListener('click', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (row) {
            setActiveGridField(row.dataset.smartField || 'date');
            return;
        }

        const cell = event.target?.closest?.('.sheet-grid__cell');
        if (!cell) return;
        const field = _sheetPreviewActiveField || 'date';
        const colLetter = cell.dataset.colLetter || '';
        const rowNumber = Number(cell.dataset.rowNumber || 0);
        if (!colLetter || !rowNumber) return;

        setSmartRowValue(field, colLetter, false);
        setSmartAnchor(field, `${colLetter}${rowNumber}`);
    });

    document.addEventListener('focusin', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (!row) return;
        setActiveGridField(row.dataset.smartField || 'date');
    });

    document.addEventListener('mouseover', (event) => {
        const cell = event.target?.closest?.('.sheet-grid__cell');
        if (!cell) return;
        _sheetPreviewHoverRef = cell.dataset.cellRef || null;
        refreshSheetGridSelectionClasses();
    });

    document.addEventListener('mouseout', (event) => {
        const cell = event.target?.closest?.('.sheet-grid__cell');
        if (!cell) return;
        const related = event.relatedTarget;
        if (related?.closest?.('#sheet-grid-picker-preview')) return;
        _sheetPreviewHoverRef = null;
        refreshSheetGridSelectionClasses();
    });

    document.addEventListener('change', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (!row) return;
        delete _sheetSmartAnchors[row.dataset.smartField || ''];
        updateGridPickerMeta();
    });

    document.addEventListener('input', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (!row) return;
        delete _sheetSmartAnchors[row.dataset.smartField || ''];
        updateGridPickerMeta();
    });
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
    _sheetSmartAnchors = cfg?.smartAnchors && typeof cfg.smartAnchors === 'object' ? { ...cfg.smartAnchors } : {};
    if (cfg?.sheetTitle) sessionStorage.setItem(SESSION_SHEET_TITLE, cfg.sheetTitle);
    if (!cfg) {
        updateGridPickerMeta();
        syncActiveGridFieldUi();
        return;
    }

    if (cfg.smartColumns && typeof cfg.smartColumns === 'object') {
        SMART_KEYS.forEach((k) => {
            setSmartRowValue(k, cfg.smartColumns[k] || '', false);
        });
    }

    if (cfg.autoSync && typeof cfg.autoSync === 'object') {
        const en = el('sheet-auto-sync-enabled');
        const iv = el('sheet-auto-sync-interval');
        if (en) en.checked = !!cfg.autoSync.enabled;
        if (iv) iv.value = String(clampSheetIntervalMin(cfg.autoSync.intervalMinutes));
    }
    if (!(cfg.smartColumns && typeof cfg.smartColumns === 'object') && cfg.columns && typeof cfg.columns === 'object') {
        const c = cfg.columns;
        setSmartRowValue('date', c.date || '', true);
        setSmartRowValue('symbol', c.symbol || '', true);
        setSmartRowValue('tradeType', c.tradeType || '', true);
        setSmartRowValue('profit', c.profit || '', true);
        setSmartRowValue('pv', c.pv || '', true);
        const ex = Array.isArray(c.exceptions) ? c.exceptions.join(', ') : (c.exceptions || '');
        setSmartRowValue('exceptions', ex, true);
    }

    updateGridPickerMeta();
    syncActiveGridFieldUi();
}

let _sheetFormHydratedFromStorage = false;

export function initSheetTableView() {
    bindSheetGridPicker();
    syncSheetWorkspaceVisibility();
    applySheetGridZoom();
    const needHydrate = !_sheetFormHydratedFromStorage;
    if (needHydrate) {
        applyConfigToForm(readStoredConfig());
        _sheetFormHydratedFromStorage = true;
    }
    if (!_sheetSessionRestoreStarted) {
        _sheetSessionRestoreStarted = true;
        void import('./google_sheet_connector.js')
            .then((m) => m.restoreGoogleSession?.())
            .catch(() => {
                /* конектор може бути недоступний офлайн */
            })
            .finally(() => {
                ensureSheetAutoSyncFromConfig();
            });
    } else {
        ensureSheetAutoSyncFromConfig();
    }
}

export async function handleSheetTabChange(selectEl) {
    const title = String(selectEl?.value || '').trim();
    const spreadsheetId = sessionStorage.getItem(SESSION_SPREADSHEET_ID) || '';
    if (!title || !spreadsheetId) return;

    sessionStorage.setItem(SESSION_SHEET_TITLE, title);
    try {
        const mod = await import('./google_sheet_connector.js');
        await mod.fetchSpreadsheetData(spreadsheetId, title);
        showToast(`Обрано лист: ${title}`);
    } catch (e) {
        console.error('[Google Sheets] sheet tab change', e);
        showToast('Не вдалося зчитати лист: ' + (e?.message || String(e)));
    }
}

function collectFormConfig() {
    const smartColumns = {};
    SMART_KEYS.forEach((k) => {
        smartColumns[k] = readSmartRowValue(k);
    });

    const spreadsheetId = sessionStorage.getItem(SESSION_SPREADSHEET_ID) || '';
    const sheetTitle = getSelectedSheetTitle();
    const title =
        el('sheet-selected-file-name')?.textContent?.trim() ||
        sessionStorage.getItem(SESSION_SPREADSHEET_TITLE) ||
        '';

    const autoSync = {
        enabled: !!el('sheet-auto-sync-enabled')?.checked,
        intervalMinutes: clampSheetIntervalMin(Number(el('sheet-auto-sync-interval')?.value) || 15),
    };

    return {
        version: 5,
        savedAt: new Date().toISOString(),
        spreadsheetId,
        selectedFileName: title,
        sheetTitle,
        sheetHeaders: _dynamicHeaders,
        smartColumns,
        smartAnchors: { ..._sheetSmartAnchors },
        dataStartRow: deriveSheetStartRow(),
        autoSync,
    };
}

const BTN_DEFAULT = 'Зберегти мапінг і синхронізувати угоди';
const BTN_LOADING = 'Синхронізація…';

export async function saveSheetMapping() {
    if (!canMutateSheetSync()) return;

    const btn = el('sheet-save-sync-btn');
    const prevText = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = BTN_LOADING;
    }

    try {
        const cfg = collectFormConfig();
        localStorage.setItem(LS_KEY, JSON.stringify(cfg));
        _sheetFormHydratedFromStorage = true;

        await executeSyncWithCfg(cfg, { quiet: false });
        ensureSheetAutoSyncFromConfig();
    } catch (e) {
        console.error('[Google Sheets] sync', e);
        showToast('Помилка синхронізації: ' + (e?.message || String(e)));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = prevText || BTN_DEFAULT;
        }
    }
}

window.toggleMappingMode = toggleMappingMode;
window.saveSheetMapping = saveSheetMapping;
window.handleSheetTabChange = handleSheetTabChange;
window.changeSheetGridZoom = changeSheetGridZoom;
window.renderMappingDropdowns = renderMappingDropdowns;
window.populateSheetMappingFromHeaders = populateSheetMappingFromHeaders;
window.stopSheetAutoSync = stopSheetAutoSync;
window.ensureSheetAutoSyncFromConfig = ensureSheetAutoSyncFromConfig;
