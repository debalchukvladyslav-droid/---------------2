// === js/sheet_table.js — Google Sheets UI + мапінг (стани, збереження) ===
//
// Угоди з таблиці: зі стартового рядка (типово 6, або з вибраної клітинки на preview, напр. A8/B8).
// У колонці «Дата» зустрічається день — запам’ятовуємо
// активну дату для всіх нижніх рядків; у колонці «Тікер» непорожня клітинка (напр. B8 = USEG)
// означає угоду: читаємо весь рядок 8 і пишемо в журнал.

import { showToast } from './utils.js';
import { state } from './state.js';
import { supabase } from './supabase.js';
import { saveJournalData, saveSettings, markJournalDayDirty } from './storage.js';
import { syncFondexxFromTradesForDay, logTradesImportConsole } from './parsers.js';
import { clearStatsCache } from './stats.js';
import { isPureGoogleSheetTrade } from './trade_filters.js';
import {
    parseSheetGridToTrades as parseSheetGridToTradesCore,
} from './sheet_sync_core.js';
import { mergeGoogleSheetTradesIntoJournal as mergeSheetTradesIntoJournal } from './sheet_journal_merge.js';
import {
    duplicateSheetMappingConfig,
    normalizeSheetImportMode,
    SHEET_MODE_CUMULATIVE,
    SHEET_MODE_MAIN,
} from './sheet_import_modes.js';
import { detectExactSheetAutoMapping, migrateLegacyClassificationMapping } from './sheet_auto_mapping.js';

const LS_KEY = 'tj_google_sheet_import_v1';
const LS_KEY_CUMULATIVE = 'tj_google_sheet_cumulative_import_v1';
const LS_MODE_KEY = 'tj_google_sheet_import_mode';

/** Підключено до Google (після OAuth). */
const SESSION_GOOGLE = 'sheet_google_connected';
/** Обрана таблиця (Spreadsheet ID). */
const SESSION_SPREADSHEET_ID = 'sheet_spreadsheet_id';
const SESSION_SPREADSHEET_TITLE = 'sheet_spreadsheet_title';
const SESSION_SHEET_TITLE = 'sheet_selected_sheet_title';
const SESSION_CUMULATIVE_SPREADSHEET_ID = 'sheet_cumulative_spreadsheet_id';
const SESSION_CUMULATIVE_SPREADSHEET_TITLE = 'sheet_cumulative_spreadsheet_title';
const SESSION_CUMULATIVE_SHEET_TITLE = 'sheet_cumulative_selected_sheet_title';
const GOOGLE_PANEL_OPEN_KEY = 'tj_google_sheet_panel_open';

const DEFAULT_SPREADSHEET_TITLES = {
    [SHEET_MODE_MAIN]: 'Основна таблиця',
    [SHEET_MODE_CUMULATIVE]: 'Накопичувальна таблиця',
};

/** Колонки таблиці / trade.sheet для статистики та datagrid (порядок = у формі). */
const SMART_KEYS = [
    'date',
    'symbol',
    'tradeType',
    'profit',
    'profitRisk',
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

const QUICK_MAPPING_KEYS = [
    'date',
    'symbol',
    'tradeType',
    'profit',
    'profitRisk',
    'pv',
    'exceptions',
    'altPv',
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

const REQUIRED_MAPPING_KEYS = ['date', 'symbol'];
const MULTI_MAPPING_KEYS = new Set(['tradeType', 'exceptions']);

const AUTO_MAP_SCAN_ROWS = 20;
const AUTO_MAP_HEADER_WINDOW = 3;
const AUTO_MAP_ALIASES = {
    date: ['дата', 'date', 'trade date', 'дата угоди', 'час', 'time', 'opened', 'open time'],
    symbol: ['ticker', 'тікер', 'тикер', 'символ', 'symbol', 'instrument', 'asset'],
    tradeType: ['тип сдєлки', 'тип сделки', 'тип угоди', 'класифікація', 'trade type', 'type', 'side', 'direction', 'buy/sell'],
    profit: ['профіт факт', 'профіт', 'прибуток', 'profit', 'p&l', 'pnl', 'net pnl', 'realized pnl', 'profit/loss'],
    profitRisk: ['профіт в ризиках', 'profit risk', 'risk profit', 'r', 'r-multiple', 'profit r', 'прибуток в ризиках'],
    pv: ['pv=pv', 'pv', 'пв'],
    altPv: ['alt pv', 'alternative pv', 'альт pv', 'альтернативний pv'],
    exceptions: ['у чому виключення', 'виключення', 'исключения', 'exception', 'exceptions', 'mistake', 'error'],
    traderComment: ['коментар трейдера', 'комментарий трейдера', 'trader comment', 'comment', 'notes', 'нотатки'],
    exit: ['вихід', 'выход', 'exit', 'close', 'close reason'],
    teamLeadComment: ['коментар teamlead', 'teamlead', 'team lead comment', 'tl comment'],
    paperType: ['тип паперу', 'тип бумаги', 'paper type', 'stock type'],
    period: ['період', 'период', 'period', 'session'],
    growthPct: ['виросла %', 'рост %', 'growth %', 'move %', 'percent move'],
    riskUsd: ['ризик $', 'ризик ($)', 'risk $', 'risk usd', 'risk'],
    consolidateCents: ['консол. (цц)', 'консол', 'consolidation', 'consolidate cents', 'цц'],
    entryPrice: ['ціна входу', 'цена входа', 'entry price', 'entry', 'open price'],
    qtyShares: ['шер брав', 'shares', 'qty', 'quantity', 'size', 'кількість', 'кол-во'],
    qtySharesCalc: ['розрах. шер', 'розрахунок шер', 'calc shares', 'calculated shares', 'planned shares'],
};

/** Перший рядок даних угод у Google Sheets (1-based). */
const SHEET_DATA_FIRST_ROW = 6;
const SHEET_PREVIEW_RENDER_MAX_ROWS = 60;
const SHEET_PREVIEW_RENDER_MAX_COLS = 52;
const SHEET_MAPPING_SELECT_MAX_COLS = 80;

let _sheetSyncInProgress = false;

function userScopedStorageKey(key) {
    return state.myUserId ? `${key}:${state.myUserId}` : key;
}

function getStoredValue(key) {
    const scopedKey = userScopedStorageKey(key);
    return localStorage.getItem(scopedKey) || sessionStorage.getItem(scopedKey) || '';
}

function setStoredValue(key, value) {
    const scopedKey = userScopedStorageKey(key);
    if (value == null || value === '') {
        sessionStorage.removeItem(scopedKey);
        localStorage.removeItem(scopedKey);
        return;
    }
    sessionStorage.setItem(scopedKey, value);
    localStorage.setItem(scopedKey, value);
}

function removeStoredValue(key) {
    const scopedKey = userScopedStorageKey(key);
    sessionStorage.removeItem(scopedKey);
    localStorage.removeItem(scopedKey);
    if (!state.myUserId) return;
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
}

/** Сумісність зі старими викликами: синхронізацією тепер керує загальний цикл застосунку. */
export function stopSheetAutoSync() {
    // Навмисно порожньо.
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
let _sheetSelectionRefreshQueued = false;
let _sheetGooglePanelBindingReady = false;
let _sheetAddNextColumnForField = '';

function el(id) {
    return document.getElementById(id);
}

function getActiveSheetMode() {
    return normalizeSheetImportMode(getStoredValue(LS_MODE_KEY));
}

function setActiveSheetMode(mode) {
    const normalized = normalizeSheetImportMode(mode);
    setStoredValue(LS_MODE_KEY, normalized);
    return normalized;
}

function isCumulativeMode(mode = getActiveSheetMode()) {
    return normalizeSheetImportMode(mode) === SHEET_MODE_CUMULATIVE;
}

function modeStorageKeys(mode = getActiveSheetMode()) {
    return isCumulativeMode(mode)
        ? {
            config: LS_KEY_CUMULATIVE,
            spreadsheetId: SESSION_CUMULATIVE_SPREADSHEET_ID,
            spreadsheetTitle: SESSION_CUMULATIVE_SPREADSHEET_TITLE,
            sheetTitle: SESSION_CUMULATIVE_SHEET_TITLE,
        }
        : {
            config: LS_KEY,
            spreadsheetId: SESSION_SPREADSHEET_ID,
            spreadsheetTitle: SESSION_SPREADSHEET_TITLE,
            sheetTitle: SESSION_SHEET_TITLE,
        };
}

function getModeStoredItem(kind, mode = getActiveSheetMode()) {
    const key = modeStorageKeys(mode)[kind];
    return getStoredValue(key);
}

export function getDefaultSpreadsheetId(mode = getActiveSheetMode()) {
    return '';
}

export function getDefaultSpreadsheetTitle(mode = getActiveSheetMode()) {
    return DEFAULT_SPREADSHEET_TITLES[normalizeSheetImportMode(mode)] || DEFAULT_SPREADSHEET_TITLES[SHEET_MODE_MAIN];
}

export function getEffectiveSpreadsheetId(mode = getActiveSheetMode()) {
    return getModeStoredItem('spreadsheetId', mode);
}

function setModeStoredItem(kind, value, mode = getActiveSheetMode()) {
    const key = modeStorageKeys(mode)[kind];
    setStoredValue(key, value);
}

function removeModeStoredItem(kind, mode = getActiveSheetMode()) {
    removeStoredValue(modeStorageKeys(mode)[kind]);
}

function isGoogleSheetPanelOpen() {
    return localStorage.getItem(GOOGLE_PANEL_OPEN_KEY) === '1';
}

function setGoogleSheetPanelOpen(open) {
    if (open) localStorage.setItem(GOOGLE_PANEL_OPEN_KEY, '1');
    else localStorage.setItem(GOOGLE_PANEL_OPEN_KEY, '0');
    syncSheetWorkspaceVisibility();
}

function syncGoogleSheetPanelToggle() {
    const open = isGoogleSheetPanelOpen();
    const toggle = el('sheet-google-panel-toggle');
    const stateLabel = el('sheet-google-panel-state');
    if (toggle) {
        toggle.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (stateLabel) stateLabel.textContent = open ? 'Сховати' : 'Показати';
}

function syncSheetModeUi() {
    const mode = getActiveSheetMode();
    document.querySelectorAll('[data-action="sheet-import-mode"][data-sheet-mode]').forEach((button) => {
        const active = normalizeSheetImportMode(button.dataset.sheetMode) === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const duplicateBtn = el('sheet-duplicate-mapping-btn');
    if (duplicateBtn) duplicateBtn.hidden = !isCumulativeMode(mode);

    const syncBtn = el('sheet-save-sync-btn');
    if (syncBtn) syncBtn.textContent = isCumulativeMode(mode) ? 'Імпортувати накопичувальну' : BTN_DEFAULT;

    const nameEl = el('sheet-selected-file-name');
    if (nameEl) nameEl.textContent = getModeStoredItem('spreadsheetTitle', mode) || getModeStoredItem('spreadsheetId', mode) || '—';

    const serviceInput = el('sheet-service-url-input');
    const serviceWorkspaceInput = el('sheet-service-url-input-workspace');
    const storedId = getModeStoredItem('spreadsheetId', mode);
    const currentId = storedId;
    if (serviceInput) serviceInput.value = currentId;
    if (serviceWorkspaceInput) serviceWorkspaceInput.value = currentId;

    const fileBtn = document.querySelector('[data-action="sheet-service-load"].sheet-btn-file');
    if (fileBtn) fileBtn.textContent = 'Змінити таблицю';
}

function bindGoogleSheetPanelToggle() {
    if (_sheetGooglePanelBindingReady) return;
    _sheetGooglePanelBindingReady = true;
    document.addEventListener('click', (event) => {
        const toggle = event.target?.closest?.('#sheet-google-panel-toggle');
        if (!toggle) return;
        const nextOpen = !isGoogleSheetPanelOpen();
        setGoogleSheetPanelOpen(nextOpen);
        if (nextOpen) initSheetTableView({ forceGoogleRestore: true });
    });
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

function smartFieldAnchorLabel(field) {
    const anchor = parseCellReference(_sheetSmartAnchors?.[field]);
    if (anchor) return anchor.ref;

    const value = readSmartRowValue(field);
    if (!value) return '';
    const first = String(value)
        .split(',')
        .map((v) => v.trim().toUpperCase())
        .find(Boolean);
    if (!first) return '';

    const parsed = parseColumnRangeToken(first);
    if (parsed?.letter) return `${parsed.letter}${parsed.row || deriveSheetStartRow()}`;
    if (/^[A-Z]{1,3}$/.test(first)) return `${first}${deriveSheetStartRow()}`;
    return first;
}

function smartFieldChipValue(field) {
    const ranges = smartFieldRanges(field);
    if (ranges.length) return ranges.join(', ');
    const raw = readSmartRowValue(field);
    return raw ? String(raw).trim() : '';
}

function renderMappingStatus() {
    const host = el('sheet-mapping-status');
    if (!host) return;

    const fragment = document.createDocumentFragment();
    QUICK_MAPPING_KEYS.forEach((field) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sheet-mapping-chip';
        button.dataset.sheetMapField = field;
        button.classList.toggle('is-active', field === _sheetPreviewActiveField);
        button.classList.toggle('is-required', REQUIRED_MAPPING_KEYS.includes(field));

        const label = document.createElement('span');
        label.className = 'sheet-mapping-chip__label';
        label.textContent = smartFieldLabel(field);

        const value = document.createElement('span');
        const anchorLabel = smartFieldChipValue(field);
        value.className = 'sheet-mapping-chip__value';
        value.textContent = anchorLabel || (REQUIRED_MAPPING_KEYS.includes(field) ? 'потрібно' : 'порожньо');
        button.classList.toggle('is-empty', !anchorLabel);

        button.append(label, value);
        fragment.appendChild(button);

        if (anchorLabel) {
            const clearButton = document.createElement('button');
            clearButton.type = 'button';
            clearButton.className = 'sheet-mapping-clear-btn';
            clearButton.dataset.action = 'sheet-clear-mapping';
            clearButton.dataset.sheetMapField = field;
            clearButton.title = `Очистити ${smartFieldLabel(field)}`;
            clearButton.setAttribute('aria-label', `Очистити мапінг ${smartFieldLabel(field)}`);
            clearButton.textContent = '×';
            fragment.appendChild(clearButton);
        }

        if (field === 'exceptions') {
            const addButton = document.createElement('button');
            addButton.type = 'button';
            addButton.className = 'sheet-mapping-add-btn sheet-mapping-add-btn--chip';
            addButton.classList.toggle('is-armed', _sheetAddNextColumnForField === field);
            addButton.dataset.action = 'sheet-add-mapping-column';
            addButton.dataset.sheetMapField = field;
            addButton.title = 'Додати ще одну колонку';
            addButton.setAttribute('aria-label', 'Додати ще одну колонку до У чому виключення');
            addButton.textContent = '+';
            fragment.appendChild(addButton);
        }
    });

    host.replaceChildren(fragment);
}

function getCurrentSpreadsheetId() {
    return getModeStoredItem('spreadsheetId');
}

function collectSheetRowsForCurrentSpreadsheet() {
    const spreadsheetId = getCurrentSpreadsheetId();
    const sourceStore = isCumulativeMode() ? state.appData?.cumulativeSheetRows : state.appData?.sheetRows;
    const store = sourceStore && typeof sourceStore === 'object' ? sourceStore : {};
    const byDay = spreadsheetId ? store[spreadsheetId] : null;
    if (!byDay || typeof byDay !== 'object') return [];

    return Object.keys(byDay)
        .sort()
        .flatMap((dateStr) => (Array.isArray(byDay[dateStr]) ? byDay[dateStr] : []).map((row) => ({ dateStr, row })));
}

function collectMatchedSheetRowKeys() {
    const spreadsheetId = getCurrentSpreadsheetId();
    const matched = new Set();
    if (!spreadsheetId) return matched;

    Object.entries(state.appData?.journal || {}).forEach(([dateStr, day]) => {
        const trades = Array.isArray(day?.trades) ? day.trades : [];
        trades.forEach((trade) => {
            const sheet = trade?.sheet;
            if (!sheet || sheet.source !== 'google') return;
            if (sheet.spreadsheetId !== spreadsheetId) return;
            if (sheet.sheetRow == null) return;
            matched.add(`${dateStr}:${sheet.sheetRow}`);
        });
    });
    return matched;
}

function formatSheetMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}`;
}

function appendSheetRowsCell(tr, text, className = '') {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text == null || text === '' ? '-' : String(text);
    tr.appendChild(td);
}

function renderSheetRowsPanel() {
    const panel = el('sheet-rows-panel');
    const summary = el('sheet-rows-summary');
    const list = el('sheet-rows-list');
    if (!panel || !summary || !list) return;

    const rows = collectSheetRowsForCurrentSpreadsheet();
    panel.hidden = rows.length === 0;
    list.replaceChildren();
    if (!rows.length) {
        summary.textContent = 'Після синхронізації тут будуть рядки з Google Sheets.';
        return;
    }

    const matched = collectMatchedSheetRowKeys();
    const matchedCount = rows.reduce((count, { dateStr, row }) => {
        const key = `${dateStr}:${row?.sheet?.sheetRow}`;
        return count + (matched.has(key) ? 1 : 0);
    }, 0);
    const auxiliaryCount = Math.max(0, rows.length - matchedCount);
    summary.textContent = `Всього з таблиці: ${rows.length}. Оновлено Trades: ${matchedCount}. Без Trades: ${auxiliaryCount}.`;

    const table = document.createElement('table');
    table.className = 'sheet-rows-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Дата', 'Рядок', 'Тікер', 'P/L', 'Класифікація', 'Статус', 'Виключення'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(({ dateStr, row }) => {
        const tr = document.createElement('tr');
        const sheet = row?.sheet || {};
        const key = `${dateStr}:${sheet.sheetRow}`;
        const isMatched = matched.has(key);

        appendSheetRowsCell(tr, dateStr);
        appendSheetRowsCell(tr, sheet.sheetRow);
        appendSheetRowsCell(tr, row?.symbol);
        appendSheetRowsCell(tr, formatSheetMoney(row?.net));
        appendSheetRowsCell(tr, sheet.tradeType || row?.type);

        const statusCell = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'sheet-rows-status';
        badge.classList.toggle('is-matched', isMatched);
        badge.textContent = isMatched ? 'у Trades' : 'допоміжно';
        statusCell.appendChild(badge);
        tr.appendChild(statusCell);

        appendSheetRowsCell(tr, sheet.exception || (Array.isArray(sheet.exceptions) ? sheet.exceptions.join('; ') : ''));
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    list.appendChild(table);
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
    renderMappingStatus();
    document.querySelectorAll('[data-action="sheet-add-mapping-column"][data-sheet-map-field]').forEach((button) => {
        button.classList.toggle('is-armed', button.dataset.sheetMapField === _sheetAddNextColumnForField);
    });
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

function focusNextUnmappedField(currentField) {
    const currentIndex = QUICK_MAPPING_KEYS.indexOf(currentField);
    if (currentIndex < 0) return;
    const next = QUICK_MAPPING_KEYS
        .slice(currentIndex + 1)
        .find((field) => !smartFieldAnchorLabel(field));
    if (next) setActiveGridField(next);
}

function setSmartAnchor(field, ref) {
    if (!field) return;
    const parsed = parseCellReference(ref);
    if (parsed) _sheetSmartAnchors[field] = parsed.ref;
    else delete _sheetSmartAnchors[field];
    updateGridPickerMeta();
    refreshSheetGridSelectionClasses();
}

export function clearSheetMappingField(field = '') {
    const key = String(field || '').trim();
    if (!SMART_KEYS.includes(key)) return;
    setSmartRowValue(key, '', false);
    delete _sheetSmartAnchors[key];
    if (_sheetAddNextColumnForField === key) _sheetAddNextColumnForField = '';
    setActiveGridField(key);
    updateGridPickerMeta();
    refreshSheetGridSelectionClasses();
    persistSheetMappingDraft();
}

function setChipManualMapping(field) {
    if (!field) return;
    const current = readSmartRowValue(field);
    const label = smartFieldLabel(field);
    const next = window.prompt(`${label}: введіть літеру колонки${MULTI_MAPPING_KEYS.has(field) ? ' або кілька через кому' : ''}`, current || '');
    if (next == null) return;
    setSmartRowValue(field, next.trim(), true);
    delete _sheetSmartAnchors[field];
    updateGridPickerMeta();
    refreshSheetGridSelectionClasses();
    persistSheetMappingDraft();
}

function focusManualMappingInput(field, seedValue = '') {
    if (!field) return;
    const row = document.querySelector(`[data-smart-field="${field}"]`);
    const group = row?.querySelector('.sheet-input-group');
    const input = group?.querySelector('.sheet-input-group__manual');
    const toggle = group?.querySelector('.sheet-input-group__toggle');
    if (!group || !input) return;

    const current = readSmartRowValue(field);
    group.setAttribute('data-mode', 'manual');
    input.value = current || seedValue || '';
    if (toggle) {
        toggle.setAttribute('aria-pressed', 'true');
        toggle.title = 'Заголовки з таблиці';
    }
    delete _sheetSmartAnchors[field];
    updateGridPickerMeta();
    refreshSheetGridSelectionClasses();
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });
}

function toggleMultiMappingColumn(field, colLetter) {
    const parts = String(readSmartRowValue(field) || '')
        .split(',')
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean);
    const normalized = String(colLetter || '').trim().toUpperCase();
    if (!normalized) return '';
    const next = parts.includes(normalized)
        ? parts.filter((part) => part !== normalized)
        : [...parts, normalized];
    const value = next.join(', ');
    setSmartRowValue(field, value, true);
    delete _sheetSmartAnchors[field];
    return value;
}

export function armSheetMultiColumnAdd(field = 'exceptions') {
    if (!MULTI_MAPPING_KEYS.has(field)) return;
    _sheetAddNextColumnForField = field;
    setActiveGridField(field);
    updateGridPickerMeta();
    showToast(`Клікніть по колонці, щоб додати її до «${smartFieldLabel(field)}».`);
}

function setMappingFromGridCell(field, colLetter, rowNumber, event = null) {
    if (!field || !colLetter || !rowNumber) return;
    const additive = !!(event?.ctrlKey || event?.metaKey || event?.shiftKey || _sheetAddNextColumnForField === field);
    if (MULTI_MAPPING_KEYS.has(field) && additive) {
        toggleMultiMappingColumn(field, colLetter);
        if (_sheetAddNextColumnForField === field) _sheetAddNextColumnForField = '';
    } else {
        setSmartRowValue(field, colLetter, false);
        setSmartAnchor(field, `${colLetter}${rowNumber}`);
        if (_sheetAddNextColumnForField === field) _sheetAddNextColumnForField = '';
    }
    updateGridPickerMeta();
    persistSheetMappingDraft();
    if (!MULTI_MAPPING_KEYS.has(field)) focusNextUnmappedField(field);
}

function persistSheetMappingDraft() {
    try {
        const cfg = collectFormConfig();
        setStoredValue(modeStorageKeys(getActiveSheetMode()).config, JSON.stringify(cfg));
        _sheetFormHydratedFromStorage = true;
    } catch (e) {
        console.warn('[Google Sheets] mapping draft save failed', e);
    }
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

    const maxCols = Math.min(
        SHEET_PREVIEW_RENDER_MAX_COLS,
        Math.max(..._sheetPreviewRows.map((row) => row.length), 0),
    );
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

function requestSheetGridSelectionRefresh() {
    if (_sheetSelectionRefreshQueued) return;
    _sheetSelectionRefreshQueued = true;
    requestAnimationFrame(() => {
        _sheetSelectionRefreshQueued = false;
        refreshSheetGridSelectionClasses();
    });
}

export function setSheetPreviewData(rows) {
    _sheetPreviewRows = Array.isArray(rows)
        ? rows.slice(0, SHEET_PREVIEW_RENDER_MAX_ROWS).map((row) => Array.isArray(row) ? row.slice(0, SHEET_PREVIEW_RENDER_MAX_COLS) : [])
        : [];
    const storedConfig = readStoredConfig(getActiveSheetMode());
    if (storedConfig) {
        const migrated = migrateLegacyClassificationMapping(storedConfig, _sheetPreviewRows.slice(0, 20));
        if (migrated.changed) {
            setStoredValue(modeStorageKeys(getActiveSheetMode()).config, JSON.stringify(migrated.config));
            applyConfigToForm(migrated.config);
        }
    }
    _sheetPreviewHoverRef = null;
    buildSheetGridPreview();
    const hasRequiredMapping = REQUIRED_MAPPING_KEYS.every((key) => storedConfig?.smartColumns?.[key]);
    if (!hasRequiredMapping) autoMapSheetColumns({ silent: true });
}

function normalizeAutoMapText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[єё]/g, 'е')
        .replace(/ї/g, 'і')
        .replace(/[\s\n\r\t_/\\-]+/g, ' ')
        .replace(/[^\p{L}\p{N}&.%+ ]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function autoMapHeaderMatches(header, aliases = []) {
    const normalized = normalizeAutoMapText(header);
    if (!normalized) return false;
    return aliases
        .map(normalizeAutoMapText)
        .filter(Boolean)
        .some((alias) => alias === normalized || normalized.includes(alias) || alias.includes(normalized));
}

function autoMapRowScore(row = []) {
    return (row || []).reduce((score, cell) => {
        const hit = Object.values(AUTO_MAP_ALIASES).some((aliases) => autoMapHeaderMatches(cell, aliases));
        return score + (hit ? 1 : 0);
    }, 0);
}

function autoMapCellValue(grid, row, col) {
    const direct = grid[row]?.[col];
    if (direct != null && String(direct).trim()) return String(direct).trim();

    for (let r = row - 1; r >= Math.max(0, row - AUTO_MAP_HEADER_WINDOW); r -= 1) {
        const value = grid[r]?.[col];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    for (let c = col - 1; c >= 0; c -= 1) {
        const value = grid[row]?.[c];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function flattenAutoMapHeaders(grid, topRow, bottomRow, maxCols) {
    const headers = [];
    for (let col = 0; col < maxCols; col += 1) {
        const parts = [];
        for (let row = topRow; row <= bottomRow; row += 1) {
            const value = autoMapCellValue(grid, row, col);
            if (!value) continue;
            const prev = parts[parts.length - 1];
            if (!prev || normalizeAutoMapText(prev) !== normalizeAutoMapText(value)) parts.push(value);
        }
        headers.push(parts.join(' ').trim());
    }
    return headers;
}

function mapAutoHeaders(headers = []) {
    const mapped = {};
    Object.entries(AUTO_MAP_ALIASES).forEach(([field, aliases]) => {
        let best = null;
        headers.forEach((header, index) => {
            if (!autoMapHeaderMatches(header, aliases)) return;
            const candidate = { index, length: normalizeAutoMapText(header).length };
            if (!best || candidate.length < best.length) best = candidate;
        });
        if (best) mapped[field] = best.index;
    });
    return mapped;
}

function detectAutoMapHeader(grid = []) {
    const rows = grid.slice(0, AUTO_MAP_SCAN_ROWS);
    const maxCols = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0), 0);
    if (!rows.length || !maxCols) return null;

    const anchorRows = rows
        .map((row, index) => ({ index, score: autoMapRowScore(row) }))
        .filter((row) => row.score > 0);
    if (!anchorRows.length) return null;

    let best = null;
    anchorRows.forEach(({ index: anchor }) => {
        for (let top = Math.max(0, anchor - 2); top <= anchor; top += 1) {
            for (let bottom = anchor; bottom <= Math.min(rows.length - 1, anchor + 2); bottom += 1) {
                const headers = flattenAutoMapHeaders(rows, top, bottom, maxCols);
                const mapped = mapAutoHeaders(headers);
                const mandatoryHits = ['date', 'symbol'].filter((field) => mapped[field] != null).length;
                const totalHits = Object.keys(mapped).length;
                const score = mandatoryHits * 100 + totalHits * 10 - (bottom - top);
                if (!best || score > best.score) best = { top, bottom, headers, mapped, score };
            }
        }
    });
    return best;
}

export function autoMapSheetColumns(options = {}) {
    const silent = Boolean(options?.silent);
    if (!_sheetPreviewRows.length) {
        if (!silent) showToast('Спочатку підключіть таблицю, щоб з’явилось прев’ю.');
        return;
    }

    const detected = detectExactSheetAutoMapping(_sheetPreviewRows, { headerScanRows: 20 });
    if (!detected.ok) {
        if (!silent) showToast(detected.reason === 'ticker-header-not-found'
            ? 'Автомапінг: не знайдено точний заголовок Ticker у перших 20 рядках.'
            : 'Автомапінг: під заголовком Ticker не знайдено рядок, що починається з латинської літери.');
        return;
    }

    populateSheetMappingFromHeaders(detected.headers);
    _dynamicHeaders = detected.headers.filter((header) => String(header || '').trim());
    const startRow = detected.startRow;
    let applied = 0;

    Object.entries(detected.mapped).forEach(([field, index]) => {
        if (!SMART_KEYS.includes(field)) return;
        const letter = indexToColumnLetter(index);
        setSmartRowValue(field, letter, false);
        _sheetSmartAnchors[field] = `${letter}${startRow}`;
        applied += 1;
    });

    updateGridPickerMeta();
    syncActiveGridFieldUi();
    refreshSheetGridSelectionClasses();
    persistSheetMappingDraft();

    const missing = REQUIRED_MAPPING_KEYS.filter((field) => detected.mapped[field] == null);
    if (!silent) showToast(missing.length
        ? `Автомапінг частковий: ${applied} полів. Не знайдено: ${missing.map(smartFieldLabel).join(', ')}.`
        : `Автомапінг готовий: ${applied} полів, старт з рядка ${startRow}.`);
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

    const storedConfig = readStoredConfig(getActiveSheetMode());
    if (storedConfig) {
        const migrated = migrateLegacyClassificationMapping(storedConfig, row);
        if (migrated.changed) {
            setStoredValue(modeStorageKeys(getActiveSheetMode()).config, JSON.stringify(migrated.config));
        }
    }

    const mapping = el('sheet-smart-mapping');
    if (!mapping) return;

    mapping.querySelectorAll('select.sheet-input-group__select').forEach((sel) => {
        const prev = sel.value;
        sel.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = 'Виберіть колонку...';
        sel.appendChild(opt0);

        _dynamicColumnChoices.slice(0, SHEET_MAPPING_SELECT_MAX_COLS).forEach(({ letter, header }) => {
            const o = document.createElement('option');
            o.value = letter;
            o.textContent = header ? `${header} (${letter})` : `(${letter} порожньо)`;
            sel.appendChild(o);
        });
        if (_dynamicColumnChoices.length > SHEET_MAPPING_SELECT_MAX_COLS) {
            const o = document.createElement('option');
            o.disabled = true;
            o.textContent = `... ${_dynamicColumnChoices.length - SHEET_MAPPING_SELECT_MAX_COLS} more columns: use manual mode`;
            sel.appendChild(o);
        }

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

    const cfg = readStoredConfig(getActiveSheetMode());
    if (cfg?.smartColumns && typeof cfg.smartColumns === 'object') {
        SMART_KEYS.forEach((k) => {
            setSmartRowValue(k, cfg.smartColumns[k] || '', false);
        });
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
    const mode = getActiveSheetMode();
    setModeStoredItem('spreadsheetId', id, mode);
    if (title) setModeStoredItem('spreadsheetTitle', title, mode);
    setGoogleSheetConnectedFlag(true);
    const nameEl = el('sheet-selected-file-name');
    if (nameEl) nameEl.textContent = title || id;
    const serviceInput = el('sheet-service-url-input');
    const serviceWorkspaceInput = el('sheet-service-url-input-workspace');
    if (serviceInput && !serviceInput.value) serviceInput.value = id;
    if (serviceWorkspaceInput && !serviceWorkspaceInput.value) serviceWorkspaceInput.value = id;
    renderSheetRowsPanel();
}

export function getSelectedSheetTitle(mode = getActiveSheetMode()) {
    return getModeStoredItem('sheetTitle', mode);
}

export function getCurrentStoredSpreadsheetId(mode = getActiveSheetMode()) {
    return getModeStoredItem('spreadsheetId', mode);
}

export function getCurrentStoredSpreadsheetTitle(mode = getActiveSheetMode()) {
    return getModeStoredItem('spreadsheetTitle', mode);
}

export function setGoogleSheetConnectedFlag(connected) {
    if (connected) setStoredValue(SESSION_GOOGLE, '1');
    else removeStoredValue(SESSION_GOOGLE);
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

    const mode = getActiveSheetMode();
    const stored = selectedTitle || getModeStoredItem('sheetTitle', mode) || list[0]?.title || '';
    if (stored && list.some(sheet => sheet.title === stored)) {
        select.value = stored;
        setModeStoredItem('sheetTitle', stored, mode);
    } else if (list[0]) {
        select.value = list[0].title;
        setModeStoredItem('sheetTitle', list[0].title, mode);
    } else {
        removeModeStoredItem('sheetTitle', mode);
    }

    picker.hidden = list.length <= 1;
}

export function clearGoogleSheetSession() {
    stopSheetAutoSync();
    setGoogleSheetConnectedFlag(false);
    sessionStorage.removeItem('sheet_google_access_token');
    [SHEET_MODE_MAIN, SHEET_MODE_CUMULATIVE].forEach((mode) => {
        removeModeStoredItem('spreadsheetId', mode);
        removeModeStoredItem('spreadsheetTitle', mode);
        removeModeStoredItem('sheetTitle', mode);
    });
    const nameEl = el('sheet-selected-file-name');
    if (nameEl) nameEl.textContent = '—';
    setSpreadsheetSheets([]);
    renderSheetRowsPanel();
}

export function syncSheetWorkspaceVisibility() {
    const connected = getStoredValue(SESSION_GOOGLE) === '1';
    const fileOk = !!getModeStoredItem('spreadsheetId');
    const panelOpen = isGoogleSheetPanelOpen();

    const s1 = el('sheet-state-connect');
    const s2 = el('sheet-state-workspace');
    const fileCard = el('sheet-mock-file-card');
    const mapping = el('sheet-smart-mapping');
    const tabPicker = el('sheet-tab-picker');

    syncGoogleSheetPanelToggle();
    syncSheetModeUi();
    if (s1) s1.hidden = !panelOpen || connected;
    if (s2) s2.hidden = !panelOpen || !connected;
    if (fileCard) fileCard.hidden = !panelOpen || !connected || !fileOk;
    if (mapping) mapping.hidden = !panelOpen || !connected || !fileOk;
    if (tabPicker && (!panelOpen || !connected || !fileOk)) tabPicker.hidden = true;
    renderSheetRowsPanel();
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

function normalizeSmartColumnsForCore(smart = {}) {
    const normalized = {};
    Object.entries(smart || {}).forEach(([key, value]) => {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) {
            normalized[key] = '';
            return;
        }
        normalized[key] = raw
            .split(',')
            .map((part) => {
                const token = part.trim();
                return token ? resolveMappingValueToSelectLetter(token) : '';
            })
            .filter(Boolean)
            .join(',');
    });
    return normalized;
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
    const mode = normalizeSheetImportMode(options.mode || cfg.mode || getActiveSheetMode());
    const cumulative = isCumulativeMode(mode);
    if (!canMutateSheetSync({ silent: quiet })) return { ok: false };

    const spreadsheetId = cfg.spreadsheetId || getModeStoredItem('spreadsheetId', mode);
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

    if (_sheetSyncInProgress) return { ok: false, skipped: true };
    _sheetSyncInProgress = true;

    try {
        const mod = await import('./google_sheet_connector.js');
        const endRow = cumulative ? '' : '2000';
        const values = await mod.fetchSpreadsheetValuesRange(spreadsheetId, `A${startRow}:ZZ${endRow}`, cfg.sheetTitle || getSelectedSheetTitle(mode));
        const parsedSmart = normalizeSmartColumnsForCore(smart);
        const { outByDay, dateAnchors, stats } = parseSheetGridToTradesCore(values, parsedSmart, spreadsheetId, startRow);

        if (!quiet) {
            console.group('[Google Sheets] Синхронізація');
            console.log('Таблиця:', cfg.selectedFileName || spreadsheetId);
            if (cfg.sheetTitle || getSelectedSheetTitle(mode)) console.log('Лист:', cfg.sheetTitle || getSelectedSheetTitle(mode));
            console.log('Якорі дат (перший рядок Excel з цією датою в колонці дати):', dateAnchors);
            console.groupEnd();
            logTradesImportConsole('Google Sheets → журнал', outByDay);
        }

        const mergeResult = mergeSheetTradesIntoJournal(state.appData?.journal || {}, outByDay, spreadsheetId, {
            mode: cumulative ? SHEET_MODE_CUMULATIVE : SHEET_MODE_MAIN,
            sheetRowsStore: cumulative
                ? (state.appData.cumulativeSheetRows || (state.appData.cumulativeSheetRows = {}))
                : (state.appData.sheetRows || (state.appData.sheetRows = {})),
            syncDayTotals: (dateStr) => syncFondexxFromTradesForDay(dateStr),
            markTouched: (dateStr) => markJournalDayDirty(dateStr),
            warnInvalidDate: (dateStr) => console.warn('[Google Sheets] Пропущено невалідну дату (не пишемо в журнал):', dateStr),
        });
        await deleteJournalDatesFromSupabase(mergeResult.deletedDates);
        await saveJournalData();
        await saveSettings();
        renderSheetRowsPanel();
        try {
            clearStatsCache(state.USER_DOC_NAME);
        } catch (_) {
            /* ignore */
        }

        if (!quiet) {
            if (stats.tradeCount > 0) {
                console.log(
                    `[Google Sheets] Imported ${mergeResult.importedSheetRows} sheet rows as auxiliary criteria; ${mergeResult.matchedSheetRows} matched Trades; ${mergeResult.skippedSheetRows} stored without Trades.`,
                );
                showToast(cumulative
                    ? `Накопичувальна імпортована: ${mergeResult.importedSheetRows}. Оновлено Trades: ${mergeResult.matchedSheetRows}. Без Trades: ${mergeResult.skippedSheetRows}.`
                    : `Таблиця імпортована: ${mergeResult.importedSheetRows}. Оновлено Trades: ${mergeResult.matchedSheetRows}. Без Trades збережено допоміжно: ${mergeResult.skippedSheetRows}.`);
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
        if (!cumulative && window.requestTradesDatagridRefresh) {
            window.requestTradesDatagridRefresh();
        } else if (!cumulative && document.getElementById('view-datagrid')?.classList.contains('active') && window.renderTradesDatagrid) {
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

function readSmartColumnForConfig(key) {
    const value = readSmartRowValue(key);
    if (value) return value;
    const anchor = parseCellReference(_sheetSmartAnchors?.[key]);
    return anchor?.letter || '';
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

    const hasSelectOption = [...sel.options].some((o) => o.value === v);
    const useManual = preferManual || !isPresetValue(v) || !hasSelectOption;

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
        if (event.detail >= 2) {
            const chip = event.target?.closest?.('[data-sheet-map-field]');
            if (chip) {
                event.preventDefault();
                event.stopPropagation();
                focusManualMappingInput(chip.dataset.sheetMapField || '');
                return;
            }

            const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
            if (row && !event.target?.closest?.('.sheet-input-group__manual')) {
                event.preventDefault();
                event.stopPropagation();
                focusManualMappingInput(row.dataset.smartField || '');
                return;
            }

            const cell = event.target?.closest?.('.sheet-grid__cell');
            if (cell) {
                event.preventDefault();
                event.stopPropagation();
                focusManualMappingInput(_sheetPreviewActiveField || 'date', cell.dataset.colLetter || '');
                return;
            }
        }

        const chip = event.target?.closest?.('[data-sheet-map-field]');
        if (chip) {
            setActiveGridField(chip.dataset.sheetMapField || 'date');
            return;
        }

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

        setMappingFromGridCell(field, colLetter, rowNumber, event);
    });

    document.addEventListener('dblclick', (event) => {
        if (event.target?.closest?.('.sheet-input-group__manual')) return;
        const chip = event.target?.closest?.('[data-sheet-map-field]');
        if (chip) {
            event.preventDefault();
            event.stopPropagation();
            focusManualMappingInput(chip.dataset.sheetMapField || '');
            return;
        }

        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (row) {
            event.preventDefault();
            event.stopPropagation();
            focusManualMappingInput(row.dataset.smartField || '');
            return;
        }

        const cell = event.target?.closest?.('.sheet-grid__cell');
        if (!cell) return;
        event.preventDefault();
        event.stopPropagation();
        const field = _sheetPreviewActiveField || 'date';
        focusManualMappingInput(field, cell.dataset.colLetter || '');
    }, true);

    document.addEventListener('focusin', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (!row) return;
        setActiveGridField(row.dataset.smartField || 'date');
    });

    document.addEventListener('mouseover', (event) => {
        const cell = event.target?.closest?.('.sheet-grid__cell');
        if (!cell) return;
        _sheetPreviewHoverRef = cell.dataset.cellRef || null;
        requestSheetGridSelectionRefresh();
    });

    document.addEventListener('mouseout', (event) => {
        const cell = event.target?.closest?.('.sheet-grid__cell');
        if (!cell) return;
        const related = event.relatedTarget;
        if (related?.closest?.('#sheet-grid-picker-preview')) return;
        _sheetPreviewHoverRef = null;
        requestSheetGridSelectionRefresh();
    });

    document.addEventListener('change', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (!row) return;
        delete _sheetSmartAnchors[row.dataset.smartField || ''];
        updateGridPickerMeta();
        persistSheetMappingDraft();
    });

    document.addEventListener('input', (event) => {
        const row = event.target?.closest?.('.sheet-smart-row[data-smart-field]');
        if (!row) return;
        delete _sheetSmartAnchors[row.dataset.smartField || ''];
        updateGridPickerMeta();
        persistSheetMappingDraft();
    });
}

function readStoredConfig(mode = getActiveSheetMode()) {
    try {
        const raw = getStoredValue(modeStorageKeys(mode).config);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return null;
        const migrated = migrateLegacyClassificationMapping(o);
        if (migrated.changed) setStoredValue(modeStorageKeys(mode).config, JSON.stringify(migrated.config));
        return migrated.config;
    } catch {
        return null;
    }
}

function applyConfigToForm(cfg) {
    _sheetSmartAnchors = cfg?.smartAnchors && typeof cfg.smartAnchors === 'object' ? { ...cfg.smartAnchors } : {};
    if (cfg?.sheetTitle) setModeStoredItem('sheetTitle', cfg.sheetTitle);
    if (!cfg) {
        SMART_KEYS.forEach((k) => setSmartRowValue(k, '', false));
        updateGridPickerMeta();
        syncActiveGridFieldUi();
        return;
    }

    if (cfg.smartColumns && typeof cfg.smartColumns === 'object') {
        SMART_KEYS.forEach((k) => {
            setSmartRowValue(k, cfg.smartColumns[k] || '', false);
        });
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

export function switchSheetImportMode(mode = SHEET_MODE_MAIN) {
    const nextMode = normalizeSheetImportMode(mode);
    const currentMode = getActiveSheetMode();
    if (nextMode === currentMode) {
        syncSheetWorkspaceVisibility();
        return;
    }

    try {
        setStoredValue(modeStorageKeys(currentMode).config, JSON.stringify(collectFormConfig()));
    } catch (_) {
        /* ignore draft save */
    }

    setActiveSheetMode(nextMode);
    _sheetFormHydratedFromStorage = true;
    applyConfigToForm(readStoredConfig(nextMode));
    syncSheetWorkspaceVisibility();

    const spreadsheetId = getModeStoredItem('spreadsheetId', nextMode);
    const sheetTitle = getSelectedSheetTitle(nextMode);
    if (spreadsheetId) {
        void import('./google_sheet_connector.js')
            .then((m) => m.fetchSpreadsheetData?.(spreadsheetId, sheetTitle))
            .catch((e) => console.warn('[Google Sheets] mode preview refresh failed', e));
    } else {
        clearSheetPreviewData();
    }
}

export function duplicateMainSheetMappingToCumulative() {
    const mainCfg = readStoredConfig(SHEET_MODE_MAIN) || {};
    const cumulativeCfg = readStoredConfig(SHEET_MODE_CUMULATIVE) || {};
    const next = duplicateSheetMappingConfig(mainCfg, cumulativeCfg);
    setStoredValue(LS_KEY_CUMULATIVE, JSON.stringify(next));
    if (isCumulativeMode()) {
        applyConfigToForm(next);
        syncSheetWorkspaceVisibility();
    }
    showToast('Мапінг продубльовано в накопичувальну.');
}

let _sheetFormHydratedFromStorage = false;
let _sheetFormHydratedForUser = null;

function sheetHydrationOwnerKey() {
    return state.myUserId || '';
}

export function initSheetTableView(options = {}) {
    bindGoogleSheetPanelToggle();
    bindSheetGridPicker();
    syncSheetWorkspaceVisibility();
    applySheetGridZoom();
    const hydrationOwner = sheetHydrationOwnerKey();
    const needHydrate = !_sheetFormHydratedFromStorage || _sheetFormHydratedForUser !== hydrationOwner;
    if (needHydrate) {
        applyConfigToForm(readStoredConfig(getActiveSheetMode()));
        _sheetFormHydratedFromStorage = true;
        _sheetFormHydratedForUser = hydrationOwner;
    }

    const isImportTabActive = !!el('view-table')?.classList.contains('active');
    if (!isGoogleSheetPanelOpen() && !options?.forceGoogleRestore) {
        return;
    }
    if (options?.deferGoogleRestore && !isImportTabActive) {
        return;
    }

    if (!_sheetSessionRestoreStarted) {
        _sheetSessionRestoreStarted = true;
        void import('./google_sheet_connector.js')
            .then((m) => m.restoreGoogleSession?.())
            .catch(() => {
                /* конектор може бути недоступний офлайн */
            });
    }
}

export async function handleSheetTabChange(selectEl) {
    const title = String(selectEl?.value || '').trim();
    const spreadsheetId = getModeStoredItem('spreadsheetId');
    if (!title || !spreadsheetId) return;

    setModeStoredItem('sheetTitle', title);
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
        smartColumns[k] = readSmartColumnForConfig(k);
    });

    const mode = getActiveSheetMode();
    const spreadsheetId = getModeStoredItem('spreadsheetId', mode);
    const sheetTitle = getSelectedSheetTitle();
    const title =
        el('sheet-selected-file-name')?.textContent?.trim() ||
        getModeStoredItem('spreadsheetTitle', mode) ||
        '';

    return {
        version: 5,
        mode,
        savedAt: new Date().toISOString(),
        spreadsheetId,
        selectedFileName: title,
        sheetTitle,
        sheetHeaders: _dynamicHeaders,
        smartColumns,
        smartAnchors: { ..._sheetSmartAnchors },
        dataStartRow: deriveSheetStartRow(),
    };
}

function validateSheetMappingConfig(cfg) {
    const missing = [];
    if (!cfg?.smartColumns?.date) missing.push('Дата');
    if (!cfg?.smartColumns?.symbol) missing.push('Тікер');
    return missing;
}

const BTN_DEFAULT = 'Зберегти мапінг і синхронізувати угоди';
const BTN_LOADING = 'Синхронізація…';

async function persistServerSheetSyncConfig(cfg) {
    try {
        if (validateSheetMappingConfig(cfg).length) return;
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const token = data?.session?.access_token || '';
        if (!token) return;

        const response = await fetch('/api/google-sheet-sync-config', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ config: cfg }),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(text || `HTTP ${response.status}`);
        }
    } catch (e) {
        console.warn('[Google Sheets] server sync config save failed:', e?.message || e);
    }
}

function refreshAfterSheetMatchUpdate() {
    renderSheetRowsPanel();
    try {
        clearStatsCache(state.USER_DOC_NAME);
    } catch (_) {
        /* ignore */
    }
    if (window.updateAutoFlags) window.updateAutoFlags();
    if (window.renderView) window.renderView();
    if (window.requestTradesDatagridRefresh) window.requestTradesDatagridRefresh();
    else if (document.getElementById('view-datagrid')?.classList.contains('active') && window.renderTradesDatagrid) window.renderTradesDatagrid();
    const viewStats = document.getElementById('view-stats');
    if (viewStats && viewStats.classList.contains('active') && window.refreshStatsView) window.refreshStatsView();
    if (window.selectDate) window.selectDate(state.selectedDateStr);
}

async function rematchStoredMainSheetRows(spreadsheetId) {
    const store = state.appData?.sheetRows && typeof state.appData.sheetRows === 'object'
        ? state.appData.sheetRows
        : null;
    const outByDay = spreadsheetId && store?.[spreadsheetId] && typeof store[spreadsheetId] === 'object'
        ? store[spreadsheetId]
        : null;
    if (!outByDay) return { ok: false, reason: 'no-stored-sheet-rows' };

    const mergeResult = mergeSheetTradesIntoJournal(state.appData?.journal || {}, outByDay, spreadsheetId, {
        mode: SHEET_MODE_MAIN,
        sheetRowsStore: store,
        syncDayTotals: (dateStr) => syncFondexxFromTradesForDay(dateStr),
        markTouched: (dateStr) => markJournalDayDirty(dateStr),
        warnInvalidDate: (dateStr) => console.warn('[Google Sheets] skipped invalid stored sheet date during local rematch:', dateStr),
    });
    await deleteJournalDatesFromSupabase(mergeResult.deletedDates);
    await saveJournalData();
    await saveSettings();
    refreshAfterSheetMatchUpdate();
    return { ok: true, local: true, mergeResult };
}

export async function refreshSheetMatchesAfterTradesImport(options = {}) {
    const quiet = options.quiet !== false;
    const cfg = readStoredConfig(SHEET_MODE_MAIN);
    const spreadsheetId = cfg?.spreadsheetId || getModeStoredItem('spreadsheetId', SHEET_MODE_MAIN);
    if (!spreadsheetId) return { ok: false, reason: 'no-main-sheet-mapping' };

    if (cfg?.smartColumns && !validateSheetMappingConfig(cfg).length) {
        try {
            const result = await executeSyncWithCfg(cfg, { quiet: true, mode: SHEET_MODE_MAIN });
            if (!result?.ok) throw new Error(result?.skipped ? 'sheet sync already in progress' : 'sheet sync did not complete');
            if (!quiet) showToast('Статуси Google Sheets оновлено після імпорту Trades.');
            return { ok: true, resynced: true, result };
        } catch (error) {
            console.warn('[Google Sheets] quiet resync after Trades import failed; trying local rematch', error?.message || error);
        }
    }

    const localResult = await rematchStoredMainSheetRows(spreadsheetId);
    if (localResult.ok && !quiet) showToast('Статуси Google Sheets оновлено локально після імпорту Trades.');
    return localResult;
}

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
        const missing = validateSheetMappingConfig(cfg);
        if (missing.length) {
            showToast(`Заповніть обов’язковий мапінг: ${missing.join(', ')}.`);
            return;
        }

        const mode = getActiveSheetMode();
        setStoredValue(modeStorageKeys(mode).config, JSON.stringify(cfg));
        _sheetFormHydratedFromStorage = true;
        if (!isCumulativeMode(mode)) void persistServerSheetSyncConfig(cfg);

        await executeSyncWithCfg(cfg, { quiet: false, mode });
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
window.switchSheetImportMode = switchSheetImportMode;
window.duplicateMainSheetMappingToCumulative = duplicateMainSheetMappingToCumulative;
window.handleSheetTabChange = handleSheetTabChange;
window.changeSheetGridZoom = changeSheetGridZoom;
window.autoMapSheetColumns = autoMapSheetColumns;
window.armSheetMultiColumnAdd = armSheetMultiColumnAdd;
window.clearSheetMappingField = clearSheetMappingField;
window.renderMappingDropdowns = renderMappingDropdowns;
window.populateSheetMappingFromHeaders = populateSheetMappingFromHeaders;
window.stopSheetAutoSync = stopSheetAutoSync;
window.refreshSheetMatchesAfterTradesImport = refreshSheetMatchesAfterTradesImport;
