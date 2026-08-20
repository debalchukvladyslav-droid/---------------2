import { supabase, SUPABASE_URL } from './supabase.js';
import { attachBestExitResult, bestExitWindowNY, collectTimedShortTrades, summarizeBestExits } from './best_exit_core.js';
import { readPolygonResult, writePolygonResults } from './polygon_result_cache.js';

const resultCache = new Map();
let renderRequest = 0;
const AUTO_ANALYZE_LIMIT = 40;
const BATCH_SIZE = 5;
let bestExitRowsExpanded = false;

function cachedMarketResult(trade) {
    const key = `${trade.symbol}|${trade.date}|${trade.entryMinute}`;
    if (!resultCache.has(key)) {
        const stored = readPolygonResult(trade);
        if (stored && bestExitWindowNY(stored.lowTime)) resultCache.set(key, stored);
    }
    return resultCache.get(key) || null;
}

function money(value) {
    return Number.isFinite(Number(value))
        ? `${Number(value).toLocaleString('uk-UA', { maximumFractionDigits: 0 })}$`
        : '—';
}

function bestWindowSummary(rows = []) {
    const counts = new Map();
    rows.forEach((row) => {
        const window = bestExitWindowNY(row?.lowTime);
        if (window) counts.set(window, (counts.get(window) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
}

async function fetchBatch(items) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
    items.forEach((item) => console.info(`[Polygon] переглядається ${item.symbol} · ${item.date} · від ${String(Math.floor(item.entryMinute / 60)).padStart(2, '0')}:${String(item.entryMinute % 60).padStart(2, '0')} NY`));
    const response = await fetch(`${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/market-best-exits`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ items }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Market data: ${response.status}`);
    console.info('[Polygon analysis] server response', { requested: items.length, returned: payload?.results?.length || 0, queued: payload?.queued || 0, processed: payload?.processed || 0 });
    const returnedKeys = new Set((payload?.results || []).map((row) => `${row.symbol}|${row.date}|${row.entryMinute}`));
    (payload?.results || []).forEach((row) => console.info(`[Polygon] ${row.symbol} · ${row.date}: Low $${Number(row.low).toFixed(2)} · ${row.lowTime} · ${row.cached ? 'кеш' : 'отримано'}`));
    items.filter((item) => !returnedKeys.has(`${item.symbol}|${item.date}|${item.entryMinute}`)).forEach((item) => console.info(`[Polygon] ${item.symbol} · ${item.date}: очікує в черзі або дані недоступні`));
    return Array.isArray(payload.results) ? payload.results : [];
}

async function loadMarketResults(trades, onProgress = null) {
    const missing = [];
    trades.forEach((trade) => {
        const key = `${trade.symbol}|${trade.date}|${trade.entryMinute}`;
        if (!cachedMarketResult(trade)) missing.push(trade);
    });
    let completed = trades.length - missing.length;
    onProgress?.(completed, trades.length);
    if (missing.length) {
        const chunk = missing.slice(0, BATCH_SIZE);
        const results = await fetchBatch(chunk.map(({ symbol, date, entryMinute }) => ({ symbol, date, entryMinute })));
        writePolygonResults(results);
        results.forEach((row) => {
            if (!bestExitWindowNY(row?.lowTime)) return;
            resultCache.set(`${row.symbol}|${row.date}|${row.entryMinute}`, row);
        });
        completed += chunk.length;
        onProgress?.(completed, trades.length);
    }
    return trades.map((trade) => attachBestExitResult(
        trade,
        cachedMarketResult(trade),
    )).filter(Boolean);
}

function renderSummary(container, summary, unavailable = 0) {
    const sortedRows = [...(summary.rows || [])].sort((a, b) => {
        const aCapture = Number.isFinite(Number(a.capturePct)) ? Number(a.capturePct) : -Infinity;
        const bCapture = Number.isFinite(Number(b.capturePct)) ? Number(b.capturePct) : -Infinity;
        return bCapture - aCapture || (Number(a.extraPnl) || 0) - (Number(b.extraPnl) || 0);
    });
    const compactRows = sortedRows.length <= 6
        ? sortedRows
        : [...sortedRows.slice(0, 3), ...sortedRows.slice(-3)];
    const topRows = bestExitRowsExpanded ? sortedRows : compactRows;
    const commonWindow = bestWindowSummary(summary.rows);
    console.groupCollapsed(`[Polygon analysis] кращий вихід: ${summary.count} угод, забрано ${summary.avgCapturePct == null ? '—' : `${summary.avgCapturePct.toFixed(1)}%`} руху`);
    console.table(summary.rows.map((row) => ({ дата: row.date, тікер: row.symbol, вхід: row.entryPrice, фактичний_вихід: row.actualExitPrice, low: row.low, час_low: row.lowTime, причина_виходу: row.exitReason || 'не вказано', забрано_руху_pct: row.capturePct == null ? null : Number(row.capturePct.toFixed(1)), не_забрано_$: row.extraPnl == null ? null : Number(row.extraPnl.toFixed(2)) })));
    console.info({ analyzed: summary.count, unavailable, bestPnl: summary.bestPnl, extraPnl: summary.extraPnl, capturedMovementPct: summary.avgCapturePct, commonBestWindow: commonWindow?.[0] || null });
    console.groupEnd();
    container.innerHTML = `
        <div class="best-exit-metrics">
            <div><span>Закритих угод без Stop/Take</span><strong>${summary.count}</strong></div>
            <div><span>Макс. результат на low</span><strong>${money(summary.bestPnl)}</strong></div>
            <div><span>Не забрано до low</span><strong>${money(summary.extraPnl)}</strong></div>
            <div><span>Забрано руху</span><strong>${summary.avgCapturePct == null ? '—' : `${summary.avgCapturePct.toFixed(0)}%`}</strong></div>
            <div><span>Найчастіший найкращий час</span><strong>${commonWindow ? `${commonWindow[0]} NY` : '—'}</strong></div>
        </div>
        ${unavailable ? `<p class="stats-chart-note">Без market data: ${unavailable}. Перевірте тариф Polygon для historical minute aggregates.</p>` : ''}
        <div class="best-exit-table-wrap">
            <table class="best-exit-table">
                <thead><tr><th>Дата</th><th>Тікер</th><th>Вихід</th><th>Low</th><th>Забрано руху</th><th>Найкращий 10-хв діапазон (NY)</th><th>Макс. P&amp;L</th><th>Не забрано</th></tr></thead>
                <tbody>${topRows.map((row) => `<tr>
                    <td>${row.date}</td><td><button type="button" class="best-exit-trade-link" data-best-exit-date="${escapeHtml(row.date)}" data-best-exit-index="${Number(row.tradeIndex)}" data-best-exit-identity="${escapeHtml(JSON.stringify(row.tradeIdentity || {}))}" title="Відкрити ${escapeHtml(row.symbol)} у журналі">${escapeHtml(row.symbol)}</button></td><td>${row.actualExitPrice.toFixed(2)}</td><td>${row.low.toFixed(2)}</td><td>${row.capturePct == null ? '—' : `${row.capturePct.toFixed(0)}%`}</td>
                    <td><strong>${bestExitWindowNY(row.lowTime) || '—'}</strong></td><td>${money(row.bestPnl)}</td><td>${money(row.extraPnl)}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>
        ${sortedRows.length > 6 ? `<button type="button" class="stats-chart-expand best-exit-expand" aria-expanded="${bestExitRowsExpanded}">
            <span aria-hidden="true">${bestExitRowsExpanded ? '⌃' : '⌄'}</span>
            ${bestExitRowsExpanded ? 'Згорнути' : `Показати всі (${sortedRows.length})`}
        </button>` : ''}`;
    container.querySelectorAll('[data-best-exit-date]').forEach((button) => button.addEventListener('click', () => {
        const date = button.dataset.bestExitDate || '';
        const tradeIndex = Number(button.dataset.bestExitIndex);
        console.info(`[Polygon analysis] відкриваю трейд ${button.textContent?.trim() || ''} · ${date} · index ${tradeIndex}`);
        let identity = null;
        try { identity = JSON.parse(button.dataset.bestExitIdentity || 'null'); } catch (_) { identity = null; }
        void window.openTradesAtDayIndex?.(date, tradeIndex, identity);
    }));
    container.querySelector('.best-exit-expand')?.addEventListener('click', () => {
        bestExitRowsExpanded = !bestExitRowsExpanded;
        renderSummary(container, summary, unavailable);
    });
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

async function runAnalysis(container, trades, requestId) {
    const updateProgress = (done, total) => {
        if (requestId !== renderRequest) return;
        const percent = total ? Math.round(done / total * 100) : 0;
        container.innerHTML = `
            <div class="best-exit-loading"><span></span> Оброблено ${done} із ${total} угод (${percent}%)</div>
            <div class="best-exit-progress"><i style="width:${percent}%"></i></div>
            <p class="stats-chart-note">Можна перейти на іншу сторінку. Повторний запуск продовжить із кешованих результатів.</p>`;
    };
    try {
        const rows = await loadMarketResults(trades, updateProgress);
        if (requestId !== renderRequest) return;
        renderSummary(container, summarizeBestExits(rows), trades.length - rows.length);
    } catch (error) {
        if (requestId !== renderRequest) return;
        container.innerHTML = `
            <div class="stats-empty-note">Завантаження зупинилося: ${escapeHtml(error?.message || error)}</div>
            <button type="button" class="btn-secondary best-exit-retry">Продовжити</button>`;
        container.querySelector('.best-exit-retry')?.addEventListener('click', () => runAnalysis(container, trades, requestId));
    }
}

export async function renderBestExitAnalysis({ journal = {}, periodDates = new Set(), sourceType = 'current' } = {}) {
    const container = document.getElementById('stats-best-exit-content');
    if (!container) return;
    const requestId = ++renderRequest;
    bestExitRowsExpanded = false;
    if (!['current', 'trader'].includes(sourceType)) {
        container.innerHTML = '<div class="stats-empty-note">Аналіз доступний для одного трейдера, а не для об’єднаного куща.</div>';
        return;
    }
    const trades = collectTimedShortTrades(journal, periodDates);
    if (!trades.length) {
        container.innerHTML = '<div class="stats-empty-note">У вибраному періоді немає закритих short-угод із коректними цінами входу/виходу після виключення Stop і Take.</div>';
        return;
    }
    const uncached = trades.filter((trade) => !cachedMarketResult(trade)).length;
    if (uncached > AUTO_ANALYZE_LIMIT) {
        container.innerHTML = `
            <div class="best-exit-start">
                <div><strong>${trades.length} угод у періоді</strong><span>${uncached} ще потребують market data</span></div>
                <button type="button" class="btn-primary best-exit-start-btn">Запустити пакетний аналіз</button>
            </div>
            <p class="stats-chart-note">Дані завантажуються короткими пакетами по ${BATCH_SIZE} угод і зберігаються в Supabase. Повторний запуск не починається спочатку.</p>`;
        container.querySelector('.best-exit-start-btn')?.addEventListener('click', () => runAnalysis(container, trades, requestId));
        return;
    }
    await runAnalysis(container, trades, requestId);
}
