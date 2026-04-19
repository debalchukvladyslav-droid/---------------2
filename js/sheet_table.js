// === js/sheet_table.js — Google Sheets UI + мапінг (стани, збереження) ===
//
// Угоди з таблиці: з рядка 6 (A6, B6…). У колонці «Дата» зустрічається день — запам’ятовуємо
// активну дату для всіх нижніх рядків; у колонці «Тікер» непорожня клітинка (напр. B8 = USEG)
// означає угоду: читаємо весь рядок 8 і пишемо в журнал.

import { showToast } from './utils.js';
import { state } from './state.js';
import { getDefaultDayEntry } from './data_utils.js';
import { saveJournalData, markJournalDayDirty } from './storage.js';
import { syncFondexxFromTradesForDay, logTradesImportConsole } from './parsers.js';
import { clearStatsCache } from './stats.js';

const LS_KEY = 'tj_google_sheet_import_v1';

/** Підключено до Google (після OAuth). */
const SESSION_GOOGLE = 'sheet_google_connected';
/** Обрана таблиця (Spreadsheet ID). */
const SESSION_SPREADSHEET_ID = 'sheet_spreadsheet_id';
const SESSION_SPREADSHEET_TITLE = 'sheet_spreadsheet_title';

/** Колонки таблиці / trade.sheet для статистики та datagrid (порядок = у формі). */
const SMART_KEYS = [
    'date',
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
    stopSheetAutoSync();
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

function smartValueToColumnIndex(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v || v.includes(',')) return -1;
    const letter = isColumnLetterToken(v) ? v.toUpperCase() : resolveMappingValueToSelectLetter(v);
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

/** Чи існує такий день у календарі (UTC). */
function calendarYmdValid(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * Дата з клітинки Sheets: YYYY-MM-DD, серійне число, D/M/Y з «.» або «/».
 * Для 3/13/2026 (US) і 13.03.2026 (EU) обираємо валідну інтерпретацію; якщо обидві валідні — пріоритет DD.MM (UA).
 */
function sheetsCellToIsoDate(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return isValidIsoDateString(s) ? s : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const epoch = Date.UTC(1899, 11, 30);
        const d = new Date(epoch + Math.round(value) * 86400000);
        const y = d.getUTCFullYear();
        const mo = d.getUTCMonth() + 1;
        const da = d.getUTCDate();
        if (y < 1990 || y > 2100) return null;
        const iso = toIsoFromParts(y, mo, da);
        return isValidIsoDateString(iso) ? iso : null;
    }
    const m1 = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
    if (m1) {
        const a = Number(m1[1]);
        const b = Number(m1[2]);
        const year = Number(m1[3]);
        if (!Number.isFinite(year) || year < 1990 || year > 2100) return null;

        const dmy = calendarYmdValid(year, b, a) ? toIsoFromParts(year, b, a) : null;
        const mdy = calendarYmdValid(year, a, b) ? toIsoFromParts(year, a, b) : null;

        if (dmy && mdy && dmy !== mdy) return dmy;
        if (dmy) return dmy;
        if (mdy) return mdy;
        return null;
    }
    return null;
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
 * @param {string[][]} values — рядки з API, перший рядок = Excel-рядок 6
 * @param {Record<string, string>} smartColumns
 * @param {string} spreadsheetId
 */
function parseSheetGridToTrades(values, smartColumns, spreadsheetId) {
    const dateIdx = smartValueToColumnIndex(smartColumns.date || '');
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
        const excelRow = SHEET_DATA_FIRST_ROW + i;

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
        const qtyRaw =
            cQty >= 0 ? String(getCell(row, cQty)).replace(/\s/g, '').replace(/,/g, '') : '';
        const qtyNum = qtyRaw !== '' ? parseFloat(qtyRaw) : NaN;

        const sheet = {
            source: 'google',
            spreadsheetId,
            sheetRow: excelRow,
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
            consolidateCents: cellStr(row, cCons) || undefined,
            entryPrice: Number.isFinite(entryNum) && entryNum !== 0 ? entryNum : undefined,
            qtyShares: Number.isFinite(qtyNum) && qtyNum !== 0 ? qtyNum : undefined,
            qtySharesCalc: cellStr(row, cQtyCalc) || undefined,
        };

        const trade = {
            symbol,
            type: typeCell || 'Google Sheet',
            opened: `${activeDate} 09:30:00`,
            closed: `${activeDate} 16:00:00`,
            held: '',
            entry: Number.isFinite(entryNum) ? entryNum : 0,
            exit: 0,
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

function mergeGoogleSheetTradesIntoJournal(outByDay, spreadsheetId) {
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
        const kept = prev.filter(
            (t) =>
                !(
                    t.sheet &&
                    t.sheet.source === 'google' &&
                    String(t.sheet.spreadsheetId || '') === String(spreadsheetId)
                ),
        );
        state.appData.journal[dateStr].trades = [...kept, ...incoming];
        syncFondexxFromTradesForDay(dateStr);
        markJournalDayDirty(dateStr);
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
        const values = await mod.fetchSpreadsheetValuesRange(spreadsheetId, 'A6:ZZ2000');
        const { outByDay, dateAnchors, stats } = parseSheetGridToTrades(values, smart, spreadsheetId);

        if (!quiet) {
            console.group('[Google Sheets] Синхронізація');
            console.log('Таблиця:', cfg.selectedFileName || spreadsheetId);
            console.log('Якорі дат (перший рядок Excel з цією датою в колонці дати):', dateAnchors);
            console.groupEnd();
            logTradesImportConsole('Google Sheets → журнал', outByDay);
        }

        mergeGoogleSheetTradesIntoJournal(outByDay, spreadsheetId);
        await saveJournalData();
        try {
            clearStatsCache(state.USER_DOC_NAME);
        } catch (_) {
            /* ignore */
        }

        if (!quiet) {
            if (stats.tradeCount > 0) {
                console.log(
                    `[Google Sheets] Імпортовано у журнал: ${stats.tradeCount} угод у ${stats.dayCount} днях (рядки з ${SHEET_DATA_FIRST_ROW}).`,
                );
                showToast(`Синхронізовано: ${stats.tradeCount} угод у ${stats.dayCount} днях.`);
            } else {
                console.warn(
                    '[Google Sheets] Угод не знайдено: перевірте дати в колонці дати та тікери з рядка ' +
                        SHEET_DATA_FIRST_ROW +
                        ' (активна дата має бути вище рядка з тікером).',
                );
                showToast('Угод у діапазоні не знайдено — перевірте колонки та рядок 6+.');
            }
        }

        if (window.updateAutoFlags) window.updateAutoFlags();
        if (window.renderView) window.renderView();
        if (window.renderTradesDatagrid) window.renderTradesDatagrid();
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
    }

    if (cfg.autoSync && typeof cfg.autoSync === 'object') {
        const en = el('sheet-auto-sync-enabled');
        const iv = el('sheet-auto-sync-interval');
        if (en) en.checked = !!cfg.autoSync.enabled;
        if (iv) iv.value = String(clampSheetIntervalMin(cfg.autoSync.intervalMinutes));
    }

    if (cfg.smartColumns && typeof cfg.smartColumns === 'object') {
        return;
    }

    if (cfg.columns && typeof cfg.columns === 'object') {
        const c = cfg.columns;
        setSmartRowValue('date', c.date || '', true);
        setSmartRowValue('symbol', c.symbol || '', true);
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
        })
        .finally(() => {
            ensureSheetAutoSyncFromConfig();
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

    const autoSync = {
        enabled: !!el('sheet-auto-sync-enabled')?.checked,
        intervalMinutes: clampSheetIntervalMin(Number(el('sheet-auto-sync-interval')?.value) || 15),
    };

    return {
        version: 5,
        savedAt: new Date().toISOString(),
        spreadsheetId,
        selectedFileName: title,
        sheetHeaders: _dynamicHeaders,
        smartColumns,
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
window.renderMappingDropdowns = renderMappingDropdowns;
window.populateSheetMappingFromHeaders = populateSheetMappingFromHeaders;
window.stopSheetAutoSync = stopSheetAutoSync;
window.ensureSheetAutoSyncFromConfig = ensureSheetAutoSyncFromConfig;
