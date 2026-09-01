import { state } from './state.js';
import { saveSettings } from './storage.js';
import { getEffectiveSpreadsheetId } from './sheet_table.js';
import { SHEET_MODE_MAIN } from './sheet_import_modes.js';
import { calculateCumulativeWeek, collectWeekStarts, getWeekRange, resolveMonthlyDayloss } from './cumulative_weekly.js';
import { showToast } from './utils.js';

let selectedWeek = '';
let eventsBound = false;

function element(id) {
    return document.getElementById(id);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${dateStr}T00:00:00Z`));
}

function formatMoney(value) {
    const number = Number(value) || 0;
    return `${number < 0 ? '−' : number > 0 ? '+' : ''}$${Math.abs(number).toFixed(2)}`;
}

function activeRows() {
    const spreadsheetId = getEffectiveSpreadsheetId(SHEET_MODE_MAIN);
    const store = state.appData?.sheetRows && typeof state.appData.sheetRows === 'object' ? state.appData.sheetRows : {};
    return { spreadsheetId, rowsByDay: spreadsheetId && store[spreadsheetId] ? store[spreadsheetId] : {} };
}

function monthlyLimits() {
    const settings = state.appData.settings || (state.appData.settings = {});
    return settings.cumulativeMonthlyDayloss && typeof settings.cumulativeMonthlyDayloss === 'object'
        ? settings.cumulativeMonthlyDayloss
        : (settings.cumulativeMonthlyDayloss = {});
}

function includeDemoDays() {
    return state.appData?.settings?.cumulativeIncludeDemo !== false;
}

function renderWeekOptions(rowsByDay) {
    const select = element('cumulative-week-select');
    if (!select) return;
    const weeks = collectWeekStarts(state.appData?.journal || {}, rowsByDay);
    if (!selectedWeek || !weeks.includes(selectedWeek)) selectedWeek = weeks[0];
    select.innerHTML = weeks.map((weekStart) => {
        const range = getWeekRange(weekStart);
        const label = `${formatDate(range.start)} — ${formatDate(range.end)}`;
        return `<option value="${weekStart}"${weekStart === selectedWeek ? ' selected' : ''}>${label}</option>`;
    }).join('');
}

function setMetric(id, value, money = true) {
    const target = element(id);
    if (target) target.textContent = money ? formatMoney(value) : value;
}

function setTradeTypeMetric(id, pnl, kf, kfCount) {
    const target = element(id);
    if (!target) return;
    target.textContent = `${formatMoney(pnl)}${kfCount ? ` · КФ ${Number(kf).toFixed(2)}` : ''}`;
}

function setResultWithKf(id, value, kf, kfCount) {
    const target = element(id);
    if (!target) return;
    target.textContent = `${value}${kfCount ? ` · КФ ${Number(kf).toFixed(2)}` : ''}`;
}

export function renderCumulativeWeekly() {
    const { spreadsheetId, rowsByDay } = activeRows();
    renderWeekOptions(rowsByDay);
    const monthKey = selectedWeek.slice(0, 7);
    const storedDayloss = resolveMonthlyDayloss(monthlyLimits(), monthKey);
    const result = calculateCumulativeWeek({
        weekStart: selectedWeek,
        journal: state.appData?.journal || {},
        rowsByDay,
        dayloss: storedDayloss,
        includeDemo: includeDemoDays(),
    });

    const range = element('cumulative-week-range');
    if (range) range.textContent = `${formatDate(result.start)} — ${formatDate(result.end)}`;
    setMetric('cumulative-table-profit', result.tableProfit);
    setMetric('cumulative-metro-result', result.metroResult);
    setMetric('cumulative-pv-result', result.pvResult, false);
    setResultWithKf('cumulative-not-taken', result.notTakenResult, result.notTakenKf, result.notTakenKfCount);
    setTradeTypeMetric('cumulative-blue', result.blue, result.blueKf, result.blueKfCount);
    setTradeTypeMetric('cumulative-green', result.green, result.greenKf, result.greenKfCount);
    setTradeTypeMetric('cumulative-purple', result.purple, result.purpleKf, result.purpleKfCount);
    setTradeTypeMetric('cumulative-visual', result.visual, result.visualKf, result.visualKfCount);
    setMetric('cumulative-effectiveness', result.effectiveness === null ? '—' : result.effectiveness.toFixed(4), false);

    const hint = element('cumulative-week-hint');
    if (hint) {
        hint.textContent = !spreadsheetId
            ? 'Основна Google-таблиця не підключена.'
            : result.rowCount === 0
                ? 'За цей тиждень у основній таблиці немає рядків.'
                : `Рядків з основної таблиці: ${result.rowCount}.`;
    }
    const input = element('cumulative-dayloss-input');
    if (input) input.value = storedDayloss ?? '';
    const month = element('cumulative-dayloss-month');
    if (month) month.textContent = monthKey;
    const includeDemo = element('cumulative-include-demo');
    if (includeDemo) includeDemo.checked = includeDemoDays();
}

function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    element('cumulative-week-select')?.addEventListener('change', (event) => {
        selectedWeek = event.target.value;
        renderCumulativeWeekly();
    });
    element('cumulative-include-demo')?.addEventListener('change', async (event) => {
        const settings = state.appData.settings || (state.appData.settings = {});
        settings.cumulativeIncludeDemo = event.target.checked === true;
        renderCumulativeWeekly();
        try {
            await saveSettings();
        } catch (error) {
            console.error('[Накопичувальна] Не вдалося зберегти налаштування демо:', error);
            showToast('Не вдалося зберегти налаштування демо.');
        }
    });
}

export function openCumulativeWeekly() {
    const modal = element('cumulative-weekly-modal');
    if (!modal) return;
    selectedWeek = '';
    bindEvents();
    renderCumulativeWeekly();
    modal.style.display = 'flex';
}

export function closeCumulativeWeekly() {
    const modal = element('cumulative-weekly-modal');
    if (modal) modal.style.display = 'none';
}

export function toggleCumulativeDayloss() {
    element('cumulative-dayloss-editor')?.classList.toggle('initially-hidden');
    element('cumulative-dayloss-input')?.focus();
}

export async function saveCumulativeDayloss() {
    const input = element('cumulative-dayloss-input');
    const value = Number(String(input?.value || '').replace(',', '.'));
    if (!Number.isFinite(value) || value === 0) {
        showToast('Введіть дейлос, відмінний від нуля.');
        return;
    }
    monthlyLimits()[selectedWeek.slice(0, 7)] = Math.abs(value);
    await saveSettings();
    element('cumulative-dayloss-editor')?.classList.add('initially-hidden');
    renderCumulativeWeekly();
    showToast('Дейлос для місяця збережено.');
}
