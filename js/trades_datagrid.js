// === js/trades_datagrid.js — horizontal trades table grouped by date ===

import { state } from './state.js';

const DATAGRID_PAGE_SIZE = 250;
const DATAGRID_COLSPAN = 20;

const TRADE_TYPES_RAW = [
    'шорт', 'не брав', 'виключення', 'виключення візуально', 'візуально',
    'виключення не брав', 'фіолетова', 'не брав візуально',
    'виключення-фіолетова', 'шортНСРП', 'шортРП', 'виключРП',
    'фіолетоваРП', 'Свій підхід', 'не брав свій підхід',
    'RV підхід', 'OLD-трейд', 'не брав OLD-трейд', 'виключення-OLD-трейд',
    'Виключення Інплей', 'ЛП з відкриття', 'тренд-шорт',
    'Візуально Потенціал', 'памп-тренд', 'Не брав памп-тренд',
    'фіолетова не брав', 'візуально-маркет', 'СИСТ-виключення',
    'СИСТ-виключення не брав', 'памп-лонг',
];

export const TRADE_TYPES = [...new Set(TRADE_TYPES_RAW)];

const UK_MONTHS_GEN = [
    'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];

let _datagridRowsCache = [];
let _datagridVisibleCount = DATAGRID_PAGE_SIZE;
let _datagridDirty = true;
let _datagridBindingsReady = false;
let _datagridPeriod = { mode: 'month', from: '', to: '' };

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function formatDateHeader(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) return dateStr;
    const day = parseInt(m[3], 10);
    const mo = parseInt(m[2], 10) - 1;
    const y = m[1];
    const monthName = UK_MONTHS_GEN[mo] ?? m[2];
    return `${day} ${monthName} ${y}`;
}

function formatDateLabel(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return dateStr || '';
    const day = parseInt(m[3], 10);
    const monthName = UK_MONTHS_GEN[parseInt(m[2], 10) - 1] ?? m[2];
    return `${day} ${monthName} ${m[1]}`;
}

function formatMonthLabel(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    if (!m) return monthKey || '';
    const monthName = UK_MONTHS_GEN[parseInt(m[2], 10) - 1] ?? m[2];
    return `${monthName} ${m[1]}`;
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function toDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthKeyFromDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function getCurrentMonthDate() {
    const base = state.todayObj instanceof Date ? state.todayObj : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
}

function getMonthRange(date) {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { from: toDateKey(first), to: toDateKey(last) };
}

function shiftMonthKey(monthKey, offset) {
    const match = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    const base = match
        ? new Date(Number(match[1]), Number(match[2]) - 1 + offset, 1)
        : getCurrentMonthDate();
    return monthKeyFromDate(base);
}

function getDatagridMonthKey() {
    if (_datagridPeriod.mode === 'month' && _datagridPeriod.from) return _datagridPeriod.from.slice(0, 7);
    return monthKeyFromDate(getCurrentMonthDate());
}

function setDatagridMonth(monthKey) {
    const match = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    const base = match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : getCurrentMonthDate();
    _datagridPeriod = { mode: 'month', ...getMonthRange(base) };
    _datagridVisibleCount = DATAGRID_PAGE_SIZE;
    syncDatagridPeriodControls();
}

function setDatagridRange(from, to, mode = 'custom') {
    let cleanFrom = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : '';
    let cleanTo = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : '';
    if (cleanFrom && cleanTo && cleanFrom > cleanTo) {
        const tmp = cleanFrom;
        cleanFrom = cleanTo;
        cleanTo = tmp;
    }
    _datagridPeriod = { mode, from: cleanFrom, to: cleanTo };
    _datagridVisibleCount = DATAGRID_PAGE_SIZE;
    syncDatagridPeriodControls();
}

function getDatagridPeriodLabel() {
    if (_datagridPeriod.mode === 'all') return 'за весь період';
    if (_datagridPeriod.mode === 'month' && _datagridPeriod.from) return `за ${formatMonthLabel(_datagridPeriod.from.slice(0, 7))}`;
    if (_datagridPeriod.from && _datagridPeriod.to) return `з ${formatDateLabel(_datagridPeriod.from)} по ${formatDateLabel(_datagridPeriod.to)}`;
    if (_datagridPeriod.from) return `з ${formatDateLabel(_datagridPeriod.from)}`;
    if (_datagridPeriod.to) return `до ${formatDateLabel(_datagridPeriod.to)}`;
    return 'за обраний період';
}

function syncDatagridPeriodControls() {
    const monthInput = document.getElementById('datagrid-month');
    const fromInput = document.getElementById('datagrid-date-from');
    const toInput = document.getElementById('datagrid-date-to');
    if (monthInput) monthInput.value = getDatagridMonthKey();
    if (fromInput) fromInput.value = _datagridPeriod.from || '';
    if (toInput) toInput.value = _datagridPeriod.to || '';

    document.querySelectorAll('.datagrid-period-chip[data-datagrid-period]').forEach((btn) => {
        const action = btn.getAttribute('data-datagrid-period');
        const active =
            (action === 'current-month' && _datagridPeriod.mode === 'month' && getDatagridMonthKey() === monthKeyFromDate(getCurrentMonthDate())) ||
            (action === 'prev-30' && _datagridPeriod.mode === 'prev-30') ||
            (action === 'all' && _datagridPeriod.mode === 'all');
        btn.classList.toggle('active', active);
    });
}

function ensureDatagridPeriodReady() {
    if (_datagridPeriod.mode === 'month' && !_datagridPeriod.from && !_datagridPeriod.to) {
        const range = getMonthRange(getCurrentMonthDate());
        _datagridPeriod = { mode: 'month', ...range };
    }
}

function timeFromOpened(opened) {
    if (!opened || typeof opened !== 'string') return '—';
    const t = opened.trim();
    const space = t.indexOf(' ');
    if (space > 0) return t.slice(space + 1).trim().split('.')[0] || '—';
    return t || '—';
}

function formatMoney(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    const sign = x >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(x).toFixed(0)}`;
}

function sheetOf(trade) {
    return trade && typeof trade.sheet === 'object' ? trade.sheet : {};
}

function nonEmpty(value, fallback = '—') {
    return value != null && value !== '' ? value : fallback;
}

function isDatagridViewActive() {
    return !!document.getElementById('view-datagrid')?.classList.contains('active');
}

function collectRows() {
    const journal = state.appData?.journal && typeof state.appData.journal === 'object' ? state.appData.journal : {};
    const flat = [];
    Object.keys(journal).forEach((dateStr) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
        const trades = Array.isArray(journal[dateStr]?.trades) ? journal[dateStr].trades : [];
        trades.forEach((t, tradeIndex) => {
            flat.push({ dateStr, trade: t, tradeIndex });
        });
    });
    flat.sort((a, b) => {
        const dc = a.dateStr.localeCompare(b.dateStr);
        if (dc !== 0) return dc;
        return String(timeFromOpened(a.trade?.opened)).localeCompare(String(timeFromOpened(b.trade?.opened)));
    });
    return flat;
}

function ensureRowsCache() {
    if (!_datagridDirty) return _datagridRowsCache;
    _datagridRowsCache = collectRows();
    _datagridDirty = false;
    return _datagridRowsCache;
}

function filterRowsByPeriod(rows) {
    if (_datagridPeriod.mode === 'all') return rows;
    const from = _datagridPeriod.from || '';
    const to = _datagridPeriod.to || '';
    return rows.filter(({ dateStr }) => {
        if (from && dateStr < from) return false;
        if (to && dateStr > to) return false;
        return true;
    });
}

function badge(htmlClass, text) {
    const t = text == null || text === '' ? '—' : String(text);
    return `<span class="badge ${htmlClass}">${esc(t)}</span>`;
}

function buildTradeRowHtml(dateStr, trade, tradeIndex) {
    const sh = sheetOf(trade);
    const net = Number(trade.net);
    const profitClass = Number.isFinite(net) && net < 0 ? 'datagrid-profit datagrid-profit--loss' : 'datagrid-profit';
    const profitCell = Number.isFinite(net)
        ? `<td class="${profitClass}">${formatMoney(net)}</td>`
        : '<td>—</td>';

    const typeLabel = sh.tradeType || trade.type || '';
    const profitRisk = nonEmpty(sh.profitRisk);
    const pvVal = nonEmpty(sh.pv);
    const altPv = nonEmpty(sh.altPv);
    const exc = Array.isArray(sh.exceptions) ? sh.exceptions.join(', ') : (sh.exception || '');
    const comment = sh.traderComment || '';
    const exitV = sh.exit || '';
    const team = sh.teamLeadComment || '';
    const paper = sh.paperType || '';
    const period = sh.period || '';
    const growth = nonEmpty(sh.growthPct);
    const risk = nonEmpty(sh.riskUsd);
    const cons = nonEmpty(sh.consolidateCents);
    const entry = nonEmpty(trade.entry, nonEmpty(sh.entryPrice));
    const stop = nonEmpty(trade.stop, nonEmpty(sh.stopPrice));
    const shares = nonEmpty(trade.qty, nonEmpty(sh.qtyShares));
    const calc = nonEmpty(sh.qtySharesCalc, shares);

    return `<tr class="trade-data-row" data-date="${esc(dateStr)}" data-trade-index="${tradeIndex}" title="Відкрити цю угоду в журналі">
        <td>${esc(timeFromOpened(trade.opened))}</td>
        <td class="datagrid-ticker">${esc((trade.symbol || '?').toString().toUpperCase())}</td>
        <td>${typeLabel ? badge('datagrid-badge datagrid-badge--type', typeLabel) : '—'}</td>
        ${profitCell}
        <td>${esc(String(profitRisk))}</td>
        <td>${esc(String(pvVal))}</td>
        <td>${esc(String(altPv))}</td>
        <td>${exc ? badge('datagrid-badge datagrid-badge--exception', exc) : '—'}</td>
        <td class="datagrid-truncate" title="${esc(comment)}">${esc(comment) || '—'}</td>
        <td>${exitV ? badge('datagrid-badge datagrid-badge--exit', exitV) : '—'}</td>
        <td class="${team ? 'datagrid-cell-soft-ok' : ''}">${esc(team) || '—'}</td>
        <td>${esc(String(paper || '—'))}</td>
        <td>${esc(String(period || '—'))}</td>
        <td>${esc(String(growth))}</td>
        <td>${esc(String(risk))}</td>
        <td>${esc(String(cons))}</td>
        <td>${esc(String(entry))}</td>
        <td>${esc(String(stop))}</td>
        <td>${esc(String(shares))}</td>
        <td>${esc(String(calc))}</td>
    </tr>`;
}

function updateDatagridToolbar(total, visible, allTotal = total) {
    const summary = document.getElementById('datagrid-summary');
    const moreBtn = document.getElementById('datagrid-load-more');
    if (summary) {
        summary.textContent = total > 0
            ? `Показано ${Math.min(visible, total)} з ${total} угод ${getDatagridPeriodLabel()}${allTotal > total ? ` · всього ${allTotal}` : ''}`
            : `Немає угод ${getDatagridPeriodLabel()}`;
    }
    if (moreBtn) {
        const canLoadMore = visible < total;
        moreBtn.hidden = !canLoadMore;
        moreBtn.textContent = canLoadMore
            ? `Показати ще ${Math.min(DATAGRID_PAGE_SIZE, total - visible)}`
            : 'Усі угоди завантажено';
    }
}

function bindDatagridControls() {
    if (_datagridBindingsReady) return;
    _datagridBindingsReady = true;
    document.addEventListener('click', (event) => {
        const row = event.target?.closest?.('.trade-data-row[data-date][data-trade-index]');
        if (row) {
            const dateStr = row.getAttribute('data-date') || '';
            const tradeIndex = Number(row.getAttribute('data-trade-index') || 0);
            window.openTradesAtDayIndex?.(dateStr, tradeIndex);
            return;
        }

        const periodBtn = event.target?.closest?.('[data-datagrid-period]');
        if (periodBtn) {
            const action = periodBtn.getAttribute('data-datagrid-period');
            if (action === 'prev-month') {
                setDatagridMonth(shiftMonthKey(getDatagridMonthKey(), -1));
            } else if (action === 'next-month') {
                setDatagridMonth(shiftMonthKey(getDatagridMonthKey(), 1));
            } else if (action === 'current-month') {
                setDatagridMonth(monthKeyFromDate(getCurrentMonthDate()));
            } else if (action === 'prev-30') {
                const end = state.todayObj instanceof Date ? state.todayObj : new Date();
                const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29);
                setDatagridRange(toDateKey(start), toDateKey(end), 'prev-30');
            } else if (action === 'all') {
                setDatagridRange('', '', 'all');
            }
            renderTradesDatagrid();
            return;
        }

        const btn = event.target?.closest?.('#datagrid-load-more');
        if (!btn) return;
        _datagridVisibleCount += DATAGRID_PAGE_SIZE;
        renderTradesDatagrid();
    });

    document.addEventListener('change', (event) => {
        const target = event.target;
        if (target?.id === 'datagrid-month') {
            setDatagridMonth(target.value);
            renderTradesDatagrid();
            return;
        }
        if (target?.id === 'datagrid-date-from' || target?.id === 'datagrid-date-to') {
            const from = document.getElementById('datagrid-date-from')?.value || '';
            const to = document.getElementById('datagrid-date-to')?.value || '';
            setDatagridRange(from, to, 'custom');
            renderTradesDatagrid();
        }
    });
}

export function invalidateTradesDatagridCache(options = {}) {
    _datagridDirty = true;
    if (!options.preserveVisibleCount) {
        _datagridVisibleCount = DATAGRID_PAGE_SIZE;
    }
}

export function requestTradesDatagridRefresh() {
    invalidateTradesDatagridCache();
    if (isDatagridViewActive()) renderTradesDatagrid();
}

export function renderTradesDatagrid() {
    bindDatagridControls();
    ensureDatagridPeriodReady();
    syncDatagridPeriodControls();

    const tbody = document.getElementById('datagrid-body');
    if (!tbody) return;

    const allRows = ensureRowsCache();
    const rows = filterRowsByPeriod(allRows);
    if (rows.length === 0) {
        tbody.innerHTML =
            `<tr><td class="datagrid-empty" colspan="${DATAGRID_COLSPAN}">Немає угод ${esc(getDatagridPeriodLabel())}. Змініть місяць або виберіть ширший діапазон.</td></tr>`;
        updateDatagridToolbar(0, 0, allRows.length);
        return;
    }

    const visibleLimit = Math.min(_datagridVisibleCount, rows.length);
    const startIndex = Math.max(0, rows.length - visibleLimit);
    const visibleRows = rows.slice(startIndex);
    let html = '';
    let prevDate = null;

    for (let i = 0; i < visibleRows.length; i++) {
        const { dateStr, trade } = visibleRows[i];
        if (dateStr !== prevDate) {
            html += `<tr class="date-group-row"><td colspan="${DATAGRID_COLSPAN}">${esc(formatDateHeader(dateStr))}</td></tr>`;
            prevDate = dateStr;
        }
        html += buildTradeRowHtml(dateStr, trade, visibleRows[i].tradeIndex);
    }

    tbody.innerHTML = html;
    updateDatagridToolbar(rows.length, visibleLimit, allRows.length);
    requestAnimationFrame(() => {
        const container = document.querySelector('.datagrid-container');
        if (container) container.scrollTop = container.scrollHeight;
    });
}

export function disposeTradesDatagrid() {
    const tbody = document.getElementById('datagrid-body');
    if (tbody) tbody.innerHTML = '';

    const summary = document.getElementById('datagrid-summary');
    if (summary) summary.textContent = 'Завантаження...';

    const moreBtn = document.getElementById('datagrid-load-more');
    if (moreBtn) moreBtn.hidden = true;
}

window.renderTradesDatagrid = renderTradesDatagrid;
window.requestTradesDatagridRefresh = requestTradesDatagridRefresh;
window.disposeTradesDatagrid = disposeTradesDatagrid;
