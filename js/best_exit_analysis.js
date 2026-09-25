import { supabase } from './supabase.js';
import { attachBestExitResult, bestExitWindowNY, calculateShortExitComparison, collectTimedShortTrades } from './best_exit_core.js';
import { analyzePolygonDay, readPolygonDay } from './polygon_intraday_cache.js';
import { loadJournalPolygonDay } from './journal_polygon.js';

const barsByDay = new Map();
let selectedExitMinute = 600;
let marketOpenStopsOnly = false;
let downloadPaused = false;
let downloadRunning = false;
let activeTrades = [];
let activePeriodLabel = 'За весь час';
let activeAnalysisContext = null;
let analysisAbortController = null;
let statusNote = '';

function dayKey(symbol, date) {
    return `${symbol}|${date}`;
}

function money(value) {
    const number = Number(value);
    return value != null && Number.isFinite(number)
        ? `${number.toLocaleString('uk-UA', { maximumFractionDigits: 0 })}$`
        : '—';
}

function minuteToClock(minute) {
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function timeOptions() {
    const options = [];
    for (let minute = 540; minute <= 720; minute += 5) {
        options.push(`<option value="${minute}" ${minute === selectedExitMinute ? 'selected' : ''}>${minuteToClock(minute)}</option>`);
    }
    return options.join('');
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

function host() {
    return document.getElementById('stats-best-exit-content');
}

function uniqueDays(trades = activeTrades) {
    const days = new Map();
    trades.forEach((trade) => {
        const key = dayKey(trade.symbol, trade.date);
        if (!days.has(key)) days.set(key, { symbol: trade.symbol, date: trade.date, entryMinute: trade.entryMinute, stopEntryMinute: trade.stopEntryMinute, stopPrice: trade.stopPrice });
    });
    return [...days.entries()];
}

function missingDays(trades = activeTrades) {
    return uniqueDays(trades).filter(([key]) => !barsByDay.has(key)).map(([, item]) => item);
}

function actualGross(trade) {
    const shares = Number(trade.qty);
    if (!(trade.entryPrice > 0) || !(trade.actualExitPrice > 0) || !(shares > 0)) return null;
    return (trade.entryPrice - trade.actualExitPrice) * shares;
}

function rowFromTrade(trade) {
    const bars = barsByDay.get(dayKey(trade.symbol, trade.date));
    const fact = actualGross(trade);
    if (!bars) {
        return { ...trade, missingChart: true, low: null, actualGross: fact, selectedGross: null, selectedGrossDiff: null, bestPnl: null };
    }
    const analyzed = analyzePolygonDay(bars, trade, selectedExitMinute);
    const priced = analyzed ? attachBestExitResult(trade, analyzed) : null;
    if (!priced) {
        return { ...trade, missingChart: true, low: null, actualGross: fact, selectedGross: null, selectedGrossDiff: null, bestPnl: null, sessionEmpty: true };
    }
    const selectedPrice = analyzed.notOpened ? NaN : (analyzed.stopHit ? Number(analyzed.stopPrice) : Number(analyzed.priceAtTime));
    const comparison = calculateShortExitComparison({
        entryPrice: priced.entryPrice,
        actualExitPrice: priced.actualExitPrice,
        selectedPrice,
        qty: priced.qty,
    });
    return {
        ...priced,
        missingChart: false,
        selectedPrice: selectedPrice > 0 ? selectedPrice : null,
        notOpened: analyzed.notOpened === true,
        stopHit: analyzed.stopHit === true,
        stopMinute: analyzed.stopMinute ?? null,
        actualGross: comparison?.actualGross ?? fact,
        selectedGross: comparison?.selectedGross ?? null,
        selectedGrossDiff: comparison?.difference ?? null,
    };
}

function sortedRows() {
    return activeTrades.map(rowFromTrade).sort((a, b) => {
        if (a.missingChart !== b.missingChart) return a.missingChart ? 1 : -1;
        return (Number(b.selectedGrossDiff) || 0) - (Number(a.selectedGrossDiff) || 0) || a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol);
    });
}

function sum(rows, key) {
    const values = rows.map((row) => row[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function paint() {
    const container = host();
    if (!container?.isConnected) return;
    const rows = sortedRows();
    const pending = missingDays();
    const savedDays = uniqueDays().length - pending.length;
    const withMoney = rows.filter((row) => Number.isFinite(row.selectedGross));
    const clock = minuteToClock(selectedExitMinute);
    container.innerHTML = `
        <div class="best-exit-run-status">
            <div class="best-exit-run-status__head">
                <div>
                    <strong>${escapeHtml(activePeriodLabel)}</strong>
                    <span>${rows.length} по часу · графіки ${savedDays} із ${savedDays + pending.length} · залишилось ${pending.length}</span>
                </div>
                ${downloadRunning
                    ? '<button type="button" class="btn-secondary" data-best-exit-pause>Пауза</button>'
                    : (pending.length ? '<button type="button" class="btn-secondary" data-best-exit-download>Довантажити</button>' : '<span class="best-exit-auto-status">Усі дні в кеші</span>')}
            </div>
            ${statusNote ? `<p class="stats-chart-note">${escapeHtml(statusNote)}</p>` : ''}
        </div>
        <div class="best-exit-metrics">
            <div><span>Фактичний Gross</span><strong>${money(sum(rows, 'actualGross'))}</strong></div>
            <div><span>Gross · ${clock}</span><strong>${withMoney.length ? money(sum(rows, 'selectedGross')) : '—'}</strong></div>
            <div><span>Різниця</span><strong>${withMoney.length ? money(sum(rows, 'selectedGrossDiff')) : '—'}</strong></div>
            <div><span>Макс. на low</span><strong>${money(sum(rows, 'bestPnl'))}</strong></div>
        </div>
        <div class="best-exit-time-picker" aria-label="Час виходу від 09:00 до 12:00">
            <button type="button" data-best-exit-time-step="-5" aria-label="На 5 хвилин раніше" ${selectedExitMinute <= 540 ? 'disabled' : ''}>‹</button>
            <label><span>Час виходу</span><select data-best-exit-target-time>${timeOptions()}</select></label>
            <button type="button" data-best-exit-time-step="5" aria-label="На 5 хвилин пізніше" ${selectedExitMinute >= 720 ? 'disabled' : ''}>›</button>
            <label class="best-exit-market-filter"><input type="checkbox" data-market-open-stops ${marketOpenStopsOnly ? 'checked' : ''}><span>Стопи на маркеті</span></label>
        </div>
        <div class="best-exit-table-wrap is-expanded">
            <table class="best-exit-table">
                <thead><tr><th>Дата</th><th>Тікер</th><th>Факт</th><th>На ${clock}</th><th>Різниця</th><th>Low</th></tr></thead>
                <tbody>${rows.map((row) => `<tr>
                    <td>${row.date}</td>
                    <td><button type="button" class="best-exit-trade-link" data-best-exit-date="${escapeHtml(row.date)}" data-best-exit-index="${Number(row.tradeIndex)}" data-best-exit-identity="${escapeHtml(JSON.stringify(row.tradeIdentity || {}))}">${escapeHtml(row.symbol)}</button></td>
                    <td>${money(row.actualGross)}</td>
                    <td>${row.missingChart ? '—' : (row.notOpened ? 'ще не відкрито' : (row.stopHit ? `стоп ${row.stopMinute == null ? '' : minuteToClock(row.stopMinute)}` : money(row.selectedGross)))}</td>
                    <td class="${Number(row.selectedGrossDiff) > 0 ? 'positive' : (Number(row.selectedGrossDiff) < 0 ? 'negative' : '')}">${row.selectedGrossDiff == null ? '—' : money(row.selectedGrossDiff)}</td>
                    <td>${row.low > 0 ? `${row.low.toFixed(2)}${bestExitWindowNY(row.lowTime) ? ` · ${bestExitWindowNY(row.lowTime)}` : ''}` : (row.sessionEmpty ? 'немає low у сесії' : 'немає свічок')}</td>
                </tr>`).join('') || '<tr><td colspan="6">У цьому періоді немає short, закритих по часу.</td></tr>'}</tbody>
            </table>
        </div>`;
    bind(container);
}

function bind(container) {
    container.querySelectorAll('[data-best-exit-date]').forEach((button) => button.addEventListener('click', () => {
        const date = button.dataset.bestExitDate || '';
        const tradeIndex = Number(button.dataset.bestExitIndex);
        let identity = null;
        try { identity = JSON.parse(button.dataset.bestExitIdentity || 'null'); } catch { identity = null; }
        void window.openTradesAtDayIndex?.(date, tradeIndex, identity);
    }));
    container.querySelector('[data-best-exit-download]')?.addEventListener('click', () => { void downloadMissing(); });
    container.querySelector('[data-best-exit-pause]')?.addEventListener('click', () => {
        downloadPaused = true;
        analysisAbortController?.abort();
        statusNote = 'Пауза. Вже збережені дні лишаються, продовження візьме лише відсутні.';
        downloadRunning = false;
        paint();
    });
    container.querySelector('[data-market-open-stops]')?.addEventListener('change', (event) => {
        marketOpenStopsOnly = !!event.currentTarget.checked;
        if (!activeAnalysisContext) return;
        activeTrades = collectTimedShortTrades(activeAnalysisContext.journal, activeAnalysisContext.periodDates, {
            marketOpenStopsOnly,
            sheetRows: activeAnalysisContext.sheetRows,
        });
        paint();
    });
    const changeSelectedTime = (nextMinute) => {
        if (!Number.isInteger(nextMinute) || nextMinute < 540 || nextMinute > 720 || nextMinute % 5 !== 0 || nextMinute === selectedExitMinute) return;
        selectedExitMinute = nextMinute;
        paint();
    };
    container.querySelector('[data-best-exit-target-time]')?.addEventListener('change', (event) => {
        changeSelectedTime(Number(event.currentTarget.value));
    });
    container.querySelectorAll('[data-best-exit-time-step]').forEach((button) => button.addEventListener('click', () => {
        changeSelectedTime(selectedExitMinute + Number(button.getAttribute('data-best-exit-time-step') || 0));
    }));
}

async function hydrateCachedDays(trades) {
    const pending = uniqueDays(trades).filter(([key]) => !barsByDay.has(key));
    await Promise.all(pending.map(async ([key, item]) => {
        const bars = await readPolygonDay(item.symbol, item.date);
        if (bars?.length) barsByDay.set(key, bars);
    }));
}

async function downloadMissing() {
    if (downloadRunning) return;
    const queue = missingDays();
    if (!queue.length) {
        statusNote = 'Усі дні цього періоду вже збережені. Час виходу рахується локально.';
        paint();
        return;
    }
    let session = (await supabase.auth.getSession()).data?.session;
    if (!session?.access_token) {
        statusNote = 'Потрібно увійти в акаунт, щоб довантажити відсутні дні.';
        paint();
        return;
    }
    downloadPaused = false;
    downloadRunning = true;
    analysisAbortController?.abort();
    analysisAbortController = new AbortController();
    const signal = analysisAbortController.signal;
    statusNote = `Довантажую ${queue.length} днів по одному. Збережені графіки не запитуються знову.`;
    paint();
    for (const item of queue) {
        if (signal.aborted || downloadPaused) break;
        console.info(`[Polygon] переглядається ${item.symbol} · ${item.date} · від ${minuteToClock(item.entryMinute)} NY`);
        try {
            const loaded = await loadJournalPolygonDay(item.symbol, item.date, session.access_token, { signal });
            if (loaded?.bars?.length) barsByDay.set(dayKey(item.symbol, item.date), loaded.bars);
            else console.info(`[Polygon] ${item.symbol} · ${item.date}: очікує в черзі або дані недоступні`);
        } catch (error) {
            if (error?.name === 'AbortError' || signal.aborted) break;
            console.info(`[Polygon] ${item.symbol} · ${item.date}: очікує в черзі або дані недоступні`);
            statusNote = error?.message || 'Не вдалося довантажити день. Уже збережені графіки на місці.';
            if (/увійти|401|403/i.test(String(error?.message || ''))) break;
        }
        if (!signal.aborted && !downloadPaused) {
            statusNote = `Залишилось ${missingDays().length}. Час виходу можна міняти, Polygon для цього не потрібен.`;
            paint();
        }
    }
    downloadRunning = false;
    if (!signal.aborted && !downloadPaused) {
        const left = missingDays().length;
        statusNote = left ? `Залишилось ${left} днів. «Довантажити» продовжить із них.` : 'Усі дні збережені. Зміна часу рахується локально.';
    }
    paint();
}

export async function renderBestExitAnalysis({ journal = {}, sheetRows = null, periodDates = new Set(), sourceType = 'current', periodLabel = 'За весь час' } = {}) {
    const container = host();
    if (!container) return;
    analysisAbortController?.abort();
    analysisAbortController = new AbortController();
    downloadRunning = false;
    downloadPaused = false;
    statusNote = '';
    activePeriodLabel = String(periodLabel || 'За весь час');
    activeAnalysisContext = { journal, sheetRows, periodDates, sourceType, periodLabel: activePeriodLabel };
    if (!['current', 'trader'].includes(sourceType)) {
        container.innerHTML = '<div class="stats-empty-note">Аналіз доступний для одного трейдера.</div>';
        return;
    }
    activeTrades = collectTimedShortTrades(journal, periodDates, { marketOpenStopsOnly, sheetRows });
    if (!activeTrades.length) {
        container.innerHTML = `<label class="best-exit-market-filter"><input type="checkbox" data-market-open-stops ${marketOpenStopsOnly ? 'checked' : ''}><span>Стопи на маркеті</span></label><div class="stats-empty-note">${marketOpenStopsOnly ? 'У вибраному періоді немає мінусових позицій, перенесених через відкриття маркету 09:30 NY.' : 'У вибраному періоді немає short, закритих по часу.'}</div>`;
        container.querySelector('[data-market-open-stops]')?.addEventListener('change', (event) => {
            marketOpenStopsOnly = !!event.currentTarget.checked;
            void renderBestExitAnalysis(activeAnalysisContext);
        });
        return;
    }
    container.innerHTML = '<div class="stats-empty-note">Читаю збережені графіки…</div>';
    await hydrateCachedDays(activeTrades);
    if (analysisAbortController.signal.aborted) return;
    const pending = missingDays().length;
    statusNote = pending
        ? 'Суми взято зі збережених графіків. «Довантажити» качає лише дні без свічок, по одному.'
        : 'Усі дні вже в кеші. Зміна часу рахується локально.';
    paint();
}
