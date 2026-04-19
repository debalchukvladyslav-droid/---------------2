// === js/trades_datagrid.js — горизонтальна таблиця угод з групуванням по датах ===

import { state } from './state.js';

/**
 * Довідник типів трейду для майбутніх випадаючих списків у формах.
 * Порядок — як у вимогах; дублікати прибрані (перше входження зберігається).
 */
/** Повний перелік з ТЗ; для випадаючих списків використовується унікалізована копія нижче. */
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

/**
 * Логіка групування по датах при рендері tbody:
 * 1) Збираємо пари (tradeDate, trade) з журналу, сортуємо за датою (новіші зверху),
 *    всередині дня — за часом відкриття, якщо є.
 * 2) Ітеруємо послідовно: якщо tradeDate відрізняється від попереднього рядка,
 *    спочатку вставляємо <tr class="date-group-row"> з підписом дня (📅 …),
 *    потім <tr class="trade-data-row"> з комірками угоди.
 * Так читач бачить чіткі секції по календарних днях без злиття різних дат в один блок.
 */

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

/** Час з рядка Fondexx "YYYY-MM-DD HH:MM:SS" або повертаємо "—". */
function timeFromOpened(opened, dateStr) {
    if (!opened || typeof opened !== 'string') return '—';
    const t = opened.trim();
    const space = t.indexOf(' ');
    if (space > 0) return t.slice(space + 1).trim().split('.')[0] || '—';
    return t || '—';
}

function formatMoney(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    const sign = x >= 0 ? '+' : '';
    return `${sign}$${Math.abs(x).toFixed(0)}`;
}

function sheetOf(trade) {
    return trade && typeof trade.sheet === 'object' ? trade.sheet : {};
}

function collectRows() {
    const journal = state.appData?.journal && typeof state.appData.journal === 'object' ? state.appData.journal : {};
    const flat = [];
    Object.keys(journal).forEach((dateStr) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
        const trades = Array.isArray(journal[dateStr]?.trades) ? journal[dateStr].trades : [];
        trades.forEach((t) => {
            flat.push({ dateStr, trade: t });
        });
    });
    flat.sort((a, b) => {
        const dc = b.dateStr.localeCompare(a.dateStr);
        if (dc !== 0) return dc;
        const ta = timeFromOpened(a.trade?.opened, a.dateStr);
        const tb = timeFromOpened(b.trade?.opened, b.dateStr);
        return String(ta).localeCompare(String(tb));
    });
    return flat;
}

function badge(htmlClass, text) {
    const t = (text == null || text === '') ? '—' : String(text);
    return `<span class="badge ${htmlClass}">${esc(t)}</span>`;
}

export function renderTradesDatagrid() {
    const tbody = document.getElementById('datagrid-body');
    if (!tbody) return;

    const rows = collectRows();
    if (rows.length === 0) {
        tbody.innerHTML =
            '<tr><td class="datagrid-empty" colspan="17">Немає угод у журналі. Імпортуйте Fondexx або додайте дані.</td></tr>';
        return;
    }

    let html = '';
    let prevDate = null;

    for (const { dateStr, trade } of rows) {
        if (dateStr !== prevDate) {
            html += `<tr class="date-group-row"><td colspan="17">${esc(formatDateHeader(dateStr))}</td></tr>`;
            prevDate = dateStr;
        }

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
        const shares = trade.qty != null && trade.qty !== '' ? trade.qty : (sh.qtyShares ?? '—');
        const calc = sh.qtySharesCalc != null && sh.qtySharesCalc !== '' ? sh.qtySharesCalc : shares;

        html += `<tr class="trade-data-row">
            <td>${esc(timeFromOpened(trade.opened, dateStr))}</td>
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
            <td>${esc(String(shares))}</td>
            <td>${esc(String(calc))}</td>
        </tr>`;
    }

    tbody.innerHTML = html;
}
