// === js/trades_datagrid.js — горизонтальна таблиця угод з групуванням по датах ===

import { state } from './state.js';

const DATAGRID_PAGE_SIZE = 250;

/**
 * Довідник типів трейду для майбутніх випадаючих списків у формах.
 * Порядок — як у вимогах; дублікати прибрані (перше входження зберігається).
 */
const TRADE_TYPES_RAW = [
    'шорт', 'не брав', 'виключення', 'виключення візуально', 'візуально',
    'виключення не брав', 'фіолетова', 'не брав', 'не брав візуально',
    'фіолетова', 'виключення-фіолетова', 'шортНСРП', 'шортРП', 'виключРП',
    'фіолетоваРП', 'візуально', 'Свій підхід', 'не брав свій підхід',
    'RV підхід', 'OLD-трейд', 'не брав OLD-трейд', 'виключення-OLD-трейд',
    'Виключення Інплей', 'ЛП з відкриття', 'не брав візуально', 'тренд-шорт',
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
    return `📅 ${day} ${monthName} ${y}`;
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
        const dc = b.dateStr.localeCompare(a.dateStr);
        if (dc !== 0) return dc;
        const ta = timeFromOpened(a.trade?.opened);
        const tb = timeFromOpened(b.trade?.opened);
        return String(ta).localeCompare(String(tb));
    });
    return flat;
}

function ensureRowsCache() {
    if (!_datagridDirty) return _datagridRowsCache;
    _datagridRowsCache = collectRows();
    _datagridDirty = false;
    return _datagridRowsCache;
}

function badge(htmlClass, text) {
    const t = text == null || text === '' ? '—' : String(text);
    return `<span class="badge ${htmlClass}">${esc(t)}</span>`;
}

function buildTradeRowHtml(dateStr, trade, tradeIndex) {
    const sh = sheetOf(trade);
    const net = Number(trade.net);
    const profitClass = Number.isFinite(net) && net < 0 ? 'datagrid-profit datagrid-profit--loss' : 'datagrid-profit';
    let profitCell = '<td>—</td>';
    if (Number.isFinite(net)) {
        let inner = formatMoney(net);
        if (sh.altPv != null && String(sh.altPv).trim() !== '') {
            inner += ` <span class="datagrid-profit-sep">/</span> ${esc(String(sh.altPv).trim())}`;
        }
        profitCell = `<td class="${profitClass}">${inner}</td>`;
    }

    const typeLabel = sh.tradeType || trade.type || '';
    const pvVal = sh.pv != null && sh.pv !== '' ? sh.pv : '—';
    const exc = Array.isArray(sh.exceptions) ? sh.exceptions.join(', ') : (sh.exception || '');
    const comment = sh.traderComment || '';
    const exitV = sh.exit || '';
    const team = sh.teamLeadComment || '';
    const paper = sh.paperType || '';
    const period = sh.period || '';
    const growth = sh.growthPct != null && sh.growthPct !== '' ? sh.growthPct : '—';
    const risk = sh.riskUsd != null && sh.riskUsd !== '' ? sh.riskUsd : '—';
    const cons = sh.consolidateCents != null && sh.consolidateCents !== '' ? sh.consolidateCents : '—';
    const entry = trade.entry != null && trade.entry !== '' ? trade.entry : (sh.entryPrice ?? '—');
    const stop = trade.stop != null && trade.stop !== '' ? trade.stop : (sh.stopPrice ?? '—');
    const shares = trade.qty != null && trade.qty !== '' ? trade.qty : (sh.qtyShares ?? '—');
    const calc = sh.qtySharesCalc != null && sh.qtySharesCalc !== '' ? sh.qtySharesCalc : shares;

    return `<tr class="trade-data-row" data-date="${esc(dateStr)}" data-trade-index="${tradeIndex}" title="Відкрити цю угоду в журналі">
        <td>${esc(timeFromOpened(trade.opened))}</td>
        <td class="datagrid-ticker">${esc((trade.symbol || '?').toString().toUpperCase())}</td>
        <td>${typeLabel ? badge('datagrid-badge datagrid-badge--type', typeLabel) : '—'}</td>
        ${profitCell}
        <td>${esc(String(pvVal))}</td>
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

function updateDatagridToolbar(total, visible) {
    const summary = document.getElementById('datagrid-summary');
    const moreBtn = document.getElementById('datagrid-load-more');
    if (summary) {
        summary.textContent = total > 0
            ? `Показано ${Math.min(visible, total)} з ${total} угод`
            : 'Немає угод у журналі';
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

        const btn = event.target?.closest?.('#datagrid-load-more');
        if (!btn) return;
        _datagridVisibleCount += DATAGRID_PAGE_SIZE;
        renderTradesDatagrid();
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

    const tbody = document.getElementById('datagrid-body');
    if (!tbody) return;

    const rows = ensureRowsCache();
    if (rows.length === 0) {
        tbody.innerHTML =
            '<tr><td class="datagrid-empty" colspan="18">Немає угод у журналі. Імпортуйте Fondexx або додайте дані.</td></tr>';
        updateDatagridToolbar(0, 0);
        return;
    }

    const visibleLimit = Math.min(_datagridVisibleCount, rows.length);
    let html = '';
    let prevDate = null;

    for (let i = 0; i < visibleLimit; i++) {
        const { dateStr, trade } = rows[i];
        if (dateStr !== prevDate) {
            html += `<tr class="date-group-row"><td colspan="18">${esc(formatDateHeader(dateStr))}</td></tr>`;
            prevDate = dateStr;
        }
        html += buildTradeRowHtml(dateStr, trade, rows[i].tradeIndex);
    }

    tbody.innerHTML = html;
    updateDatagridToolbar(rows.length, visibleLimit);
}

window.renderTradesDatagrid = renderTradesDatagrid;
window.requestTradesDatagridRefresh = requestTradesDatagridRefresh;
