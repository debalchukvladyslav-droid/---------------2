import { parseSheetDateCellsToIsoSequence } from './parser_utils.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { calculateEntryCriteria, hasExactEntryTime, parseEntryInstant, presentSnapshot, snapshotIsFrozen, zonedDateTimeToUtcMs } from '../lib/massive_criteria.js';
import {
    CRITERIA_COLUMNS,
    buildCellUpdates,
    carrySheetDates,
    cellCanAccept,
    columnIndex,
    composeCriteriaValues,
    deriveSheetMarket,
    detectHeaderColumns,
    isEligibleCriteriaDate,
    selectExportRows,
    shiftIsoDate,
} from '../lib/sheet_criteria_export.js';

const SETTINGS_KEY = 'tj_sheet_criteria_export_settings_v1';
const CACHE_KEY = 'tj_sheet_criteria_market_v1';
const FETCH_FIELDS = new Set(['volPre', 'vol', 'atr', 'avgVol', 'volPlay', 'potential', 'vwap', 'dayPos', 'activePost', 'activeEarly']);
const get = (host, id) => host?.querySelector?.(`[data-criteria="${id}"]`);

let busy = false;
let loadedGrid = { spreadsheetId: '', sheetTitle: '', values: null };

function readSettings() {
    try {
        const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch (_) {
        return {};
    }
}

function saveSettings(host) {
    const columns = {};
    CRITERIA_COLUMNS.forEach((field) => { columns[field.id] = get(host, field.id)?.value || ''; });
    const settings = {
        source: get(host, 'source')?.value || '',
        tab: get(host, 'tab')?.value || '',
        columns,
        limitEnabled: get(host, 'limit-enabled')?.checked === true,
        limit: get(host, 'limit')?.value || '5',
        auto: get(host, 'auto')?.checked === true,
    };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
        /* The panel still works for this visit. */
    }
    return settings;
}

function readCache() {
    try {
        const value = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch (_) {
        return {};
    }
}

function writeCache(cache) {
    const entries = Object.entries(cache).slice(-400);
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (_) {
        /* A failed cache write only means the next row may ask Massive again. */
    }
}

function columnLetter(index) {
    let value = index + 1;
    let result = '';
    while (value > 0) {
        value -= 1;
        result = String.fromCharCode(65 + (value % 26)) + result;
        value = Math.floor(value / 26);
    }
    return result;
}

function fillColumnSelects(host, rows) {
    const width = Math.max(0, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)));
    host.querySelectorAll('[data-criteria-column]').forEach((select) => {
        const previous = select.value;
        select.replaceChildren(new Option('Не записувати', ''));
        for (let index = 0; index < width; index += 1) {
            const samples = rows.slice(0, 8).map((row) => String(row?.[index] ?? '').trim()).filter(Boolean).slice(0, 2);
            const letter = columnLetter(index);
            select.append(new Option(samples.length ? `${letter} — ${samples.join(' / ')}` : letter, letter));
        }
        if ([...select.options].some((option) => option.value === previous)) select.value = previous;
        select.disabled = false;
    });
}

function applyDetectedColumns(host, detected, saved = {}) {
    CRITERIA_COLUMNS.forEach((field) => {
        const select = get(host, field.id);
        if (!select) return;
        const chosen = saved[field.id] || detected[field.id] || '';
        if ([...select.options].some((option) => option.value === chosen)) select.value = chosen;
    });
}

function isTicker(value) {
    const text = String(value || '').trim().toUpperCase();
    return /^[A-Z][A-Z0-9.-]{0,14}$/.test(text) && text !== 'TICKER';
}

function cell(row, letter) {
    const index = columnIndex(letter);
    if (index < 0) return '';
    return row?.[index] ?? '';
}

function entryPriceOf(raw, trade) {
    const parsed = Number(String(raw ?? '').replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const fallback = Number(trade?.entry ?? trade?.sheet?.entryPrice);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

function matchTrade(date, ticker, excelRow) {
    const trades = state.appData?.journal?.[date]?.trades;
    if (!Array.isArray(trades)) return null;
    const same = trades.filter((trade) => String(trade?.symbol || trade?.ticker || '').trim().toUpperCase() === ticker);
    return same.find((trade) => Number(trade?.sheet?.sheetRow) === excelRow)
        || same.find((trade) => hasExactEntryTime(trade?.opened || trade?.entryTime || trade?.time))
        || null;
}

function localNumbers(trade) {
    const view = trade?.criteriaSnapshot ? presentSnapshot(trade.criteriaSnapshot) : null;
    return {
        frozen: view ? snapshotIsFrozen(view) : false,
        atr14: view?.atr14,
        avgVol14: view?.avgVol14,
        dayVolume: view?.dayVolume,
        volPlay14: view?.volPlay14,
        high: view?.high,
        low: view?.low,
        floatShares: trade?.marketCriteria?.shs_float,
    };
}

function mergeMarket(local, fetched) {
    if (!fetched) return local;
    const numbers = local.frozen ? local : {
        ...local,
        atr14: fetched.atr14 ?? local.atr14,
        avgVol14: fetched.avgVol14 ?? local.avgVol14,
        dayVolume: fetched.dayVolume ?? local.dayVolume,
        volPlay14: fetched.volPlay14 ?? local.volPlay14,
    };
    return {
        ...numbers,
        previousClose: fetched.previousClose,
        vwap: fetched.vwap,
        high: numbers.high ?? fetched.high,
        low: numbers.low ?? fetched.low,
        postVolume: fetched.postVolume,
        earlyVolume: fetched.earlyVolume,
    };
}

function needsFetch(columns, row, formulaRow, values) {
    return Object.entries(columns).some(([field, letter]) => {
        if (!FETCH_FIELDS.has(field) || !letter) return false;
        if (values?.[field] != null && values[field] !== '') return false;
        const index = columnIndex(letter);
        const kind = field === 'activePost' || field === 'activeEarly' ? 'checkbox' : 'value';
        return cellCanAccept(row?.[index], Boolean(formulaRow?.[index]), kind);
    });
}

async function polygonBars(accessToken, body) {
    const { SUPABASE_URL } = await import('./supabase.js');
    const response = await fetch(`${SUPABASE_URL}/functions/v1/polygon-aggs`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Polygon: HTTP ${response.status}`);
    return Array.isArray(payload?.results) ? payload.results : [];
}

async function fetchSheetMarket({ ticker, tradeDate, opened }) {
    const entry = parseEntryInstant({ tradeDate, opened });
    if (!entry || !isEligibleCriteriaDate(entry.tradeDate)) return null;
    const { supabase } = await import('./supabase.js');
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
    const minuteFrom = zonedDateTimeToUtcMs(shiftIsoDate(entry.tradeDate, -5), '16:00:00');
    const [dailyBars, minuteBars] = await Promise.all([
        polygonBars(session.access_token, {
            mode: 'daily',
            symbol: ticker,
            from: shiftIsoDate(entry.tradeDate, -70),
            to: shiftIsoDate(entry.tradeDate, -1),
        }),
        polygonBars(session.access_token, {
            symbol: ticker,
            fromMs: minuteFrom,
            toMs: entry.entryMs,
        }),
    ]);
    const criteria = calculateEntryCriteria({
        dailyBars,
        minuteBars,
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
        adjusted: true,
    });
    const market = deriveSheetMarket({
        dailyBars,
        minuteBars,
        tradeDate: entry.tradeDate,
        entryMs: entry.entryMs,
    });
    return {
        ...market,
        atr14: criteria.atr14,
        avgVol14: criteria.avgVol14,
        dayVolume: criteria.dayVolume,
        volPlay14: criteria.volPlay14,
        high: market.high ?? criteria.high,
        low: market.low ?? criteria.low,
    };
}

async function preferredSheetTitle(sheets) {
    const nick = String(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '').replace(/_stats$/, '').trim();
    let lastName = '';
    if (nick) {
        try {
            const { supabase } = await import('./supabase.js');
            const { data } = await supabase.from('profiles').select('last_name').eq('nick', nick).maybeSingle();
            lastName = String(data?.last_name || '').trim();
        } catch (_) {
            lastName = '';
        }
    }
    const wanted = lastName.toLocaleLowerCase('uk-UA');
    if (!wanted) return sheets[0]?.title || '';
    const titles = sheets.map((sheet) => String(sheet?.title || '').trim()).filter(Boolean);
    return titles.find((title) => title.toLocaleLowerCase('uk-UA') === wanted)
        || titles.find((title) => title.toLocaleLowerCase('uk-UA').includes(wanted))
        || titles[0]
        || '';
}

async function ensureGrid(spreadsheetId, sheetTitle) {
    if (loadedGrid.spreadsheetId === spreadsheetId && loadedGrid.sheetTitle === sheetTitle && loadedGrid.values) {
        return loadedGrid.values;
    }
    const connector = await import('./google_sheet_connector.js');
    const values = await connector.fetchSpreadsheetValuesRange(spreadsheetId, 'A1:ZZ', sheetTitle);
    loadedGrid = { spreadsheetId, sheetTitle, values };
    return values;
}

function currentSettings(host) {
    const settings = readSettings();
    if (!host) return settings;
    const source = get(host, 'source')?.value;
    if (source) settings.source = source;
    const tab = get(host, 'tab')?.value;
    if (tab) settings.tab = tab;
    if (get(host, 'limit-enabled')) settings.limitEnabled = get(host, 'limit-enabled').checked === true;
    if (get(host, 'limit')?.value) settings.limit = get(host, 'limit').value;
    if (get(host, 'auto')) settings.auto = get(host, 'auto').checked === true;
    const columns = { ...(settings.columns || {}) };
    CRITERIA_COLUMNS.forEach((field) => {
        const value = get(host, field.id)?.value;
        if (value) columns[field.id] = value;
    });
    settings.columns = columns;
    return settings;
}

export async function runCriteriaExport({ automatic = false, host = null } = {}) {
    const panel = host || document.querySelector('[data-testing-criteria-sheet-host]');
    const settings = currentSettings(panel);
    const status = get(panel, 'status');
    if (automatic && settings.auto !== true) return { ok: true, skipped: true };
    if (automatic && state.myRole !== 'admin') return { ok: true, skipped: true };
    if (busy) return { ok: false, reason: 'busy' };

    const setStatus = (text) => { if (status) status.textContent = text; };
    busy = true;
    const writeButton = get(panel, 'write');
    if (writeButton) writeButton.disabled = true;
    try {
        const connector = await import('./google_sheet_connector.js');
        const spreadsheetId = connector.extractSpreadsheetId(settings.source || '');
        const sheetTitle = String(settings.tab || '').trim();
        const columns = settings.columns || {};
        if (!spreadsheetId || !sheetTitle) {
            if (!automatic) setStatus('Вкажіть посилання на статистику і лист.');
            return { ok: false, reason: 'missing-sheet' };
        }
        if (!Object.values(columns).some(Boolean)) {
            const text = 'Оберіть хоча б одну колонку для запису.';
            setStatus(text);
            if (!automatic) showToast(text);
            return { ok: false, reason: 'columns' };
        }
        setStatus('Читаємо таблицю…');
        const values = await ensureGrid(spreadsheetId, sheetTitle);
        const detected = detectHeaderColumns(values);
        if (!detected.date || !detected.ticker) {
            setStatus('На листі не знайдено колонки Дата і Ticker.');
            return { ok: false, reason: 'headers' };
        }
        const parsedDates = carrySheetDates(parseSheetDateCellsToIsoSequence(
            values.map((row) => cell(row, detected.date)),
        ));
        const cache = readCache();
        const candidates = [];
        let skippedRecent = 0;
        let skippedWithoutTime = 0;
        values.forEach((row, index) => {
            const date = parsedDates[index];
            const ticker = String(cell(row, detected.ticker) || '').trim().toUpperCase();
            if (!date || !isTicker(ticker)) return;
            const formulaRow = values.formulas?.[index] || [];
            const writableCount = Object.entries(columns).filter(([field, letter]) => {
                if (!letter) return false;
                const kind = field === 'activePost' || field === 'activeEarly' ? 'checkbox' : 'value';
                return cellCanAccept(row?.[columnIndex(letter)], Boolean(formulaRow[columnIndex(letter)]), kind);
            }).length;
            if (!writableCount) return;
            if (!isEligibleCriteriaDate(date)) {
                skippedRecent += 1;
                return;
            }
            const trade = matchTrade(date, ticker, index + 1);
            const opened = trade?.opened || trade?.entryTime || trade?.time || '';
            if (!hasExactEntryTime(opened)) {
                skippedWithoutTime += 1;
                return;
            }
            const entry = parseEntryInstant({ tradeDate: date, opened });
            if (!entry) {
                skippedWithoutTime += 1;
                return;
            }
            candidates.push({
                eligible: true,
                date,
                ticker,
                writableCount,
                excelRow: index + 1,
                row,
                formulaRow,
                trade,
                opened,
                entry,
                entryPrice: entryPriceOf(cell(row, detected.entry), trade),
            });
        });
        const eligible = candidates;
        const selected = selectExportRows(eligible, {
            limitEnabled: settings.limitEnabled === true,
            limit: settings.limit,
        });
        if (!selected.length) {
            const text = `Немає порожніх рядків старіших за вчора. Пропущено сьогодні і вчора: ${skippedRecent}. Без часу входу: ${skippedWithoutTime}.`;
            setStatus(text);
            if (!automatic) showToast(text);
            return { ok: true, written: 0 };
        }
        const updates = [];
        let errors = 0;
        for (let index = 0; index < selected.length; index += 1) {
            const item = selected[index];
            setStatus(`Рахуємо ${index + 1} із ${selected.length}: ${item.date} ${item.ticker}`);
            const cacheKey = `${item.ticker}|${item.entry.tradeDate}|${item.entry.entryAt}`;
            let market = mergeMarket(localNumbers(item.trade), cache[cacheKey]);
            let composed = composeCriteriaValues({ ...market, entryMs: item.entry.entryMs, entryPrice: item.entryPrice });
            if (needsFetch(columns, item.row, item.formulaRow, composed) && !cache[cacheKey]) {
                try {
                    const fetched = await fetchSheetMarket({
                        ticker: item.ticker,
                        tradeDate: item.entry.tradeDate,
                        opened: item.opened,
                    });
                    if (fetched) {
                        cache[cacheKey] = fetched;
                        writeCache(cache);
                        market = mergeMarket(localNumbers(item.trade), fetched);
                        composed = composeCriteriaValues({ ...market, entryMs: item.entry.entryMs, entryPrice: item.entryPrice });
                    }
                } catch (error) {
                    errors += 1;
                    console.warn('[Criteria sheet]', item.ticker, error?.message || error);
                }
            }
            updates.push(...buildCellUpdates({
                excelRow: item.excelRow,
                columns,
                row: item.row,
                formulaRow: item.formulaRow,
                values: composed,
            }));
        }
        let written = 0;
        for (let index = 0; index < updates.length; index += 400) {
            const part = updates.slice(index, index + 400);
            const result = await connector.updateSpreadsheetCells(spreadsheetId, sheetTitle, part);
            written += Number(result?.updatedCells) || part.length;
        }
        const text = `Записано клітинок: ${written}. Рядків: ${selected.length}. Пропущено сьогодні і вчора: ${skippedRecent}. Без часу входу: ${skippedWithoutTime}. Помилок: ${errors}.`;
        setStatus(text);
        if (!automatic || written || errors) showToast(text);
        return { ok: true, written, rows: selected.length, errors };
    } catch (error) {
        const text = `Помилка: ${error?.message || error}`;
        setStatus(text);
        if (!automatic) showToast(text);
        return { ok: false, error: text };
    } finally {
        busy = false;
        if (writeButton) writeButton.disabled = false;
    }
}

export function runAutomaticCriteriaExport() {
    return runCriteriaExport({ automatic: true });
}

export function initCriteriaSheetExport(host) {
    if (!host || host.dataset.ready === 'true') return;
    host.dataset.ready = 'true';
    const saved = readSettings();
    const columnLabels = CRITERIA_COLUMNS.map((field) => (
        `<label><span>${field.label}</span><select data-criteria-column data-criteria="${field.id}" disabled></select></label>`
    )).join('');
    host.innerHTML = `
        <div class="admin-service-bots-head">
            <div>
                <h4 class="admin-section-title">Критерії в статистику</h4>
                <p class="admin-section-subtitle">Порожні колонки існуючого рядка дата + тікер. Сьогодні й учора не записуються і Polygon для них не викликається.</p>
            </div>
            <span class="admin-polygon-state is-active">Лише адмін</span>
        </div>
        <div class="testing-sheet-service-account"><span>Сервісна пошта для доступу «Редактор»:</span><strong data-criteria="service-email">Завантаження…</strong><button type="button" class="btn-secondary sheet-btn-compact" data-criteria="copy-email" disabled>Копіювати</button></div>
        <div class="testing-sheet-source">
            <input class="sheet-service-input" type="text" data-criteria="source" placeholder="Посилання на статистику або spreadsheet ID">
            <button type="button" class="btn-admin-action" data-criteria="connect">Підключити</button>
            <label><span>Лист</span><select data-criteria="tab" disabled><option value="">Спочатку підключіть таблицю</option></select></label>
        </div>
        <p class="admin-polygon-result" data-criteria="status">Оберіть таблицю статистики і колонки.</p>
        <div class="testing-sheet-mapping">${columnLabels}</div>
        <div class="testing-sheet-mapping">
            <label><span>Завантажити кількість</span><input type="checkbox" data-criteria="limit-enabled"></label>
            <label><span>Скільки тікерів</span><input type="number" min="1" step="1" value="5" data-criteria="limit" disabled></label>
            <button type="button" class="btn-admin-action" data-criteria="write">Завантажити</button>
            <label><span>Автоматичне завантаження</span><input type="checkbox" data-criteria="auto"></label>
        </div>
        <p class="admin-section-subtitle">Без галочки кількості записуються всі порожні рядки. Автозапуск стартує після того, як синхронізація таблиці повністю завершилась.</p>`;

    if (saved.source) get(host, 'source').value = saved.source;
    if (saved.limit) get(host, 'limit').value = saved.limit;
    get(host, 'limit-enabled').checked = saved.limitEnabled === true;
    get(host, 'limit').disabled = saved.limitEnabled !== true;
    get(host, 'auto').checked = saved.auto === true;

    const persist = () => saveSettings(host);
    host.querySelectorAll('[data-criteria]').forEach((element) => {
        if (element.dataset.criteria === 'status' || element.dataset.criteria === 'service-email') return;
        element.addEventListener(element.type === 'checkbox' || element.tagName === 'SELECT' ? 'change' : 'input', persist);
    });
    get(host, 'limit-enabled').addEventListener('change', () => {
        get(host, 'limit').disabled = !get(host, 'limit-enabled').checked;
    });

    import('./google_sheet_connector.js').then(async (connector) => {
        const response = await connector.fetchSheetServiceAccount();
        const email = String(response?.email || '').trim();
        const emailElement = get(host, 'service-email');
        const copyButton = get(host, 'copy-email');
        emailElement.textContent = email || 'Не налаштована на сервері';
        copyButton.disabled = !email;
        copyButton.addEventListener('click', async () => {
            await navigator.clipboard.writeText(email);
            copyButton.textContent = 'Скопійовано';
            setTimeout(() => { copyButton.textContent = 'Копіювати'; }, 1400);
        });
    }).catch(() => { get(host, 'service-email').textContent = 'Не вдалося завантажити'; });

    const status = get(host, 'status');
    const tab = get(host, 'tab');
    get(host, 'connect').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const connector = await import('./google_sheet_connector.js');
            const spreadsheetId = connector.extractSpreadsheetId(get(host, 'source').value);
            if (!spreadsheetId) throw new Error('Введіть коректне посилання на статистику.');
            status.textContent = 'Завантажуємо список листів…';
            const metadata = await connector.fetchSpreadsheetMetadata(spreadsheetId);
            const sheets = metadata.sheets || [];
            if (!sheets.length) throw new Error('У таблиці не знайдено листів.');
            tab.replaceChildren();
            sheets.forEach((sheet) => tab.append(new Option(sheet.title, sheet.title)));
            const storedTab = readSettings().tab;
            const preferred = storedTab && [...tab.options].some((option) => option.value === storedTab)
                ? storedTab
                : await preferredSheetTitle(sheets);
            if (preferred) tab.value = preferred;
            tab.disabled = false;
            status.textContent = 'Читаємо заголовки…';
            const values = await ensureGrid(spreadsheetId, tab.value);
            fillColumnSelects(host, values);
            applyDetectedColumns(host, detectHeaderColumns(values), readSettings().columns || {});
            persist();
            const detected = detectHeaderColumns(values);
            status.textContent = `Лист «${tab.value}». Дата ${detected.date || '—'}, тікер ${detected.ticker || '—'}. Оберіть колонки і натисніть «Завантажити».`;
        } catch (error) {
            status.textContent = `Помилка: ${error?.message || error}`;
        } finally {
            button.disabled = false;
        }
    });
    tab.addEventListener('change', async () => {
        try {
            const connector = await import('./google_sheet_connector.js');
            const spreadsheetId = connector.extractSpreadsheetId(get(host, 'source').value);
            if (!spreadsheetId || !tab.value) return;
            status.textContent = 'Читаємо заголовки…';
            const values = await ensureGrid(spreadsheetId, tab.value);
            fillColumnSelects(host, values);
            applyDetectedColumns(host, detectHeaderColumns(values), {});
            persist();
            status.textContent = `Лист «${tab.value}» підключено.`;
        } catch (error) {
            status.textContent = `Помилка: ${error?.message || error}`;
        }
    });
    get(host, 'write').addEventListener('click', () => {
        runCriteriaExport({ host }).catch((error) => {
            status.textContent = `Помилка: ${error?.message || error}`;
        });
    });
}
