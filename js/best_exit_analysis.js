import { supabase, SUPABASE_URL } from './supabase.js';
import { attachBestExitResult, bestExitWindowNY, buildLowTimeFrequencySeries, calculateShortExitComparison, collectTimedShortTrades, summarizeBestExits } from './best_exit_core.js';
import { readPolygonResult, readPolygonTimePrice, writePolygonResults, writePolygonTimePrices } from './polygon_result_cache.js';

const resultCache = new Map();
let renderRequest = 0;
const AUTO_ANALYZE_LIMIT = 40;
const BATCH_SIZE = 5;
const MAX_ITEMS_PER_PRICE_REQUEST = 200;
let bestExitRowsExpanded = false;
let lowChartFromTen = false;
let silentRefreshTimer = null;
let activeAnalysisTrades = [];
let activeAnalysisRequestId = 0;
let analysisRunning = false;
let marketOpenStopsOnly = false;
let activeAnalysisContext = null;
let selectedExitMinute = 600;
const REFRESH_AFTER_PROGRESS_MS = 3000;
const REFRESH_WHEN_WAITING_MS = 65000;

function marketStopFilterControl() {
    return `<label class="best-exit-market-filter"><input type="checkbox" data-market-open-stops ${marketOpenStopsOnly ? 'checked' : ''}><span>Стопи на маркеті</span></label>`;
}

function attachMarketStopFilter(container) {
    container.querySelector('[data-market-open-stops]')?.addEventListener('change', (event) => {
        marketOpenStopsOnly = !!event.currentTarget.checked;
        if (activeAnalysisContext) void renderBestExitAnalysis(activeAnalysisContext);
    });
}

function cachedMarketResult(trade) {
    const key = `${trade.symbol}|${trade.date}|${trade.entryMinute}`;
    if (!resultCache.has(key)) {
        const stored = readPolygonResult(trade);
        if (stored && bestExitWindowNY(stored.lowTime)) resultCache.set(key, stored);
    }
    return resultCache.get(key) || null;
}

function cachedTimePrice(trade) {
    return readPolygonTimePrice({ symbol: trade.symbol, date: trade.date, targetMinute: selectedExitMinute });
}

function money(value) {
    return Number.isFinite(Number(value))
        ? `${Number(value).toLocaleString('uk-UA', { maximumFractionDigits: 0 })}$`
        : '—';
}

function minuteToClock(minute) {
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function bestWindowSummary(rows = []) {
    const counts = new Map();
    rows.forEach((row) => {
        const window = bestExitWindowNY(row?.lowTime);
        if (window) counts.set(window, (counts.get(window) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
}

function exitTimeChart(rows = []) {
    const series = buildLowTimeFrequencySeries(rows, { minMinute: lowChartFromTen ? 600 : 570 });
    const heading = `<div><strong>Коли акції найчастіше роблять low</strong><span>Частка low у кожному 10-хвилинному інтервалі, NY</span></div>`;
    const filter = `<div class="best-exit-time-chart__filters"><label class="best-exit-time-filter"><input type="checkbox" data-low-chart-from-ten ${lowChartFromTen ? 'checked' : ''}><span>З 10:00</span></label>${marketStopFilterControl()}</div>`;
    if (!series.length) return `<section class="best-exit-time-chart"><div class="best-exit-time-chart__head">${heading}${filter}</div><div class="stats-empty-note">Для цього діапазону ще немає часу low від Polygon.</div></section>`;
    const width = 680;
    const height = 190;
    const pad = { left: 42, right: 16, top: 18, bottom: 32 };
    const chartStart = lowChartFromTen ? 600 : 570;
    const x = (minute) => pad.left + ((minute - chartStart) / (710 - chartStart)) * (width - pad.left - pad.right);
    const maxPercent = Math.max(10, ...series.map((item) => item.percent));
    const chartMax = Math.ceil(maxPercent / 5) * 5;
    const y = (pct) => pad.top + (1 - Math.max(0, Math.min(chartMax, pct)) / chartMax) * (height - pad.top - pad.bottom);
    const points = series.map((item) => `${x(item.minute).toFixed(1)},${y(item.percent).toFixed(1)}`).join(' ');
    const best = series.reduce((winner, item) => item.percent > winner.percent ? item : winner, series[0]);
    const xTicks = lowChartFromTen ? [600, 630, 660, 690, 710] : [570, 600, 630, 660, 690, 710];
    return `<section class="best-exit-time-chart">
        <div class="best-exit-time-chart__head">${heading}${filter}<div class="best-exit-time-chart__best"><span>Найчастіший low</span><strong>${best.label} · ${best.percent.toFixed(1)}%</strong><small>${best.count} із ${best.total} угод</small></div></div>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Частота low акцій залежно від часу">
            ${[0, .25, .5, .75, 1].map((ratio) => { const pct = chartMax * ratio; return `<line x1="${pad.left}" y1="${y(pct)}" x2="${width - pad.right}" y2="${y(pct)}" class="best-exit-chart-grid"/><text x="${pad.left - 8}" y="${y(pct) + 4}" text-anchor="end">${pct.toFixed(0)}%</text>`; }).join('')}
            ${xTicks.map((minute) => `<text x="${x(minute)}" y="${height - 8}" text-anchor="middle">${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}</text>`).join('')}
            <polyline points="${points}" class="best-exit-chart-line"/>
            ${series.map((item) => `<circle cx="${x(item.minute)}" cy="${y(item.percent)}" r="4"><title>${item.label} NY: ${item.percent.toFixed(1)}% · ${item.count} із ${item.total} угод</title></circle>`).join('')}
        </svg>
    </section>`;
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
        body: JSON.stringify({ items, targetMinute: selectedExitMinute }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Market data: ${response.status}`);
    console.info('[Polygon analysis] server response', { requested: items.length, returned: payload?.results?.length || 0, queued: payload?.queued || 0, processed: payload?.processed || 0 });
    const returnedKeys = new Set((payload?.results || []).map((row) => `${row.symbol}|${row.date}|${row.entryMinute}`));
    (payload?.results || []).forEach((row) => console.info(`[Polygon] ${row.symbol} · ${row.date}: Low $${Number(row.low).toFixed(2)} · ${row.lowTime} · ${row.cached ? 'кеш' : 'отримано'}`));
    items.filter((item) => !returnedKeys.has(`${item.symbol}|${item.date}|${item.entryMinute}`)).forEach((item) => console.info(`[Polygon] ${item.symbol} · ${item.date}: очікує в черзі або дані недоступні`));
    const rows = Array.isArray(payload.results) ? payload.results : [];
    writePolygonTimePrices(rows);
    return rows;
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
        completed = trades.length - countMissingMarketResults(trades);
        onProgress?.(completed, trades.length);
    }
    const missingTimePrices = trades.filter((trade) => !cachedTimePrice(trade));
    if (missingTimePrices.length) {
        const priceItems = missingTimePrices.slice(0, MAX_ITEMS_PER_PRICE_REQUEST).map(({ symbol, date, entryMinute }) => ({ symbol, date, entryMinute }));
        const priceResults = await fetchBatch(priceItems);
        writePolygonResults(priceResults);
        completed = trades.length - countMissingMarketResults(trades);
        onProgress?.(completed, trades.length);
    }
    return trades.map((trade) => {
        const row = attachBestExitResult(trade, cachedMarketResult(trade));
        if (!row) return null;
        const timePrice = cachedTimePrice(trade);
        const selectedPrice = Number(timePrice?.priceAtTime);
        const comparison = calculateShortExitComparison({ entryPrice: row.entryPrice, actualExitPrice: row.actualExitPrice, selectedPrice, qty: row.qty });
        return { ...row, selectedPrice: selectedPrice > 0 ? selectedPrice : null, selectedPriceMinute: timePrice?.priceMinute ?? null, actualGross: comparison?.actualGross ?? null, selectedGross: comparison?.selectedGross ?? null, selectedGrossDiff: comparison?.difference ?? null };
    }).filter(Boolean);
}

function renderSummary(container, summary, unavailable = 0, logToConsole = true) {
    const previousScrollTop = container.querySelector('.best-exit-table-wrap')?.scrollTop || 0;
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
    const totalTrades = activeAnalysisTrades.length;
    const remainingTrades = countMissingMarketResults(activeAnalysisTrades);
    const completedTrades = Math.max(0, totalTrades - remainingTrades);
    const progressPercent = totalTrades ? Math.round(completedTrades / totalTrades * 100) : 100;
    if (logToConsole) {
        console.groupCollapsed(`[Polygon analysis] кращий вихід: ${summary.count} угод, забрано ${summary.avgCapturePct == null ? '—' : `${summary.avgCapturePct.toFixed(1)}%`} руху`);
        console.table(summary.rows.map((row) => ({ дата: row.date, тікер: row.symbol, вхід: row.entryPrice, фактичний_вихід: row.actualExitPrice, low: row.low, час_low: row.lowTime, причина_виходу: row.exitReason || 'не вказано', забрано_руху_pct: row.capturePct == null ? null : Number(row.capturePct.toFixed(1)), не_забрано_$: row.extraPnl == null ? null : Number(row.extraPnl.toFixed(2)) })));
        console.info({ analyzed: summary.count, unavailable, bestPnl: summary.bestPnl, extraPnl: summary.extraPnl, capturedMovementPct: summary.avgCapturePct, commonBestWindow: commonWindow?.[0] || null });
        console.groupEnd();
    }
    container.innerHTML = `
        <div class="best-exit-metrics">
            <div><span>Закритих угод без Stop/Take</span><strong>${summary.count}</strong></div>
            <div><span>Макс. результат на low</span><strong>${money(summary.bestPnl)}</strong></div>
            <div><span>Не забрано до low</span><strong>${money(summary.extraPnl)}</strong></div>
            <div><span>Забрано руху</span><strong>${summary.avgCapturePct == null ? '—' : `${summary.avgCapturePct.toFixed(0)}%`}</strong></div>
            <div><span>Найчастіший найкращий час</span><strong>${commonWindow ? `${commonWindow[0]} NY` : '—'}</strong></div>
        </div>
        ${unavailable ? `<p class="stats-chart-note">Без market data: ${unavailable}. Перевірте тариф Polygon для historical minute aggregates.</p>` : ''}
        <div class="best-exit-run-status">
            <div class="best-exit-run-status__head">
                <div><strong>Перевірка Polygon</strong><span>Пройдено ${completedTrades} із ${totalTrades} · залишилось ${remainingTrades}</span></div>
                <button type="button" class="btn-secondary best-exit-check-all" ${analysisRunning ? 'disabled' : ''}>${analysisRunning ? 'Перевіряємо…' : 'Старт / перевірити все'}</button>
            </div>
            <div class="best-exit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPercent}"><i style="width:${progressPercent}%"></i></div>
        </div>
        ${exitTimeChart(summary.rows)}
        <div class="best-exit-time-simulator">
            <div><strong>Результат при виході у вибраний час</strong><span>Gross через entry × shares, час NY</span></div>
            <label><span>Час виходу</span><input type="time" min="09:00" max="12:00" step="300" value="${minuteToClock(selectedExitMinute)}" data-best-exit-target-time></label>
        </div>
        <div class="best-exit-table-wrap${bestExitRowsExpanded ? ' is-expanded' : ''}">
            <table class="best-exit-table">
                <thead><tr><th>Дата</th><th>Тікер</th><th>Вихід</th><th>Low</th><th>Забрано руху</th><th>Найкращий 10-хв діапазон (NY)</th><th>Макс. P&amp;L</th><th>Не забрано</th><th>Ціна @ ${minuteToClock(selectedExitMinute)}</th><th>Gross @ час</th><th>Δ до факту</th></tr></thead>
                <tbody>${topRows.map((row) => `<tr>
                    <td>${row.date}</td><td><button type="button" class="best-exit-trade-link" data-best-exit-date="${escapeHtml(row.date)}" data-best-exit-index="${Number(row.tradeIndex)}" data-best-exit-identity="${escapeHtml(JSON.stringify(row.tradeIdentity || {}))}" title="Відкрити ${escapeHtml(row.symbol)} у журналі">${escapeHtml(row.symbol)}</button></td><td>${row.actualExitPrice.toFixed(2)}</td><td>${row.low.toFixed(2)}</td><td>${row.capturePct == null ? '—' : `${row.capturePct.toFixed(0)}%`}</td>
                    <td><strong>${bestExitWindowNY(row.lowTime) || '—'}</strong></td><td>${money(row.bestPnl)}</td><td>${money(row.extraPnl)}</td><td>${row.selectedPrice == null ? '…' : row.selectedPrice.toFixed(2)}</td><td>${money(row.selectedGross)}</td><td class="${Number(row.selectedGrossDiff) >= 0 ? 'positive' : 'negative'}">${row.selectedGrossDiff == null ? '—' : money(row.selectedGrossDiff)}</td>
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
    container.querySelector('[data-low-chart-from-ten]')?.addEventListener('change', (event) => {
        lowChartFromTen = !!event.currentTarget.checked;
        renderSummary(container, summary, unavailable, false);
    });
    container.querySelector('.best-exit-check-all')?.addEventListener('click', () => {
        if (analysisRunning || activeAnalysisRequestId !== renderRequest) return;
        void runAnalysis(container, activeAnalysisTrades, activeAnalysisRequestId);
    });
    attachMarketStopFilter(container);
    container.querySelector('[data-best-exit-target-time]')?.addEventListener('change', (event) => {
        const [hour, minute] = String(event.currentTarget.value || '').split(':').map(Number);
        const nextMinute = hour * 60 + minute;
        if (!Number.isInteger(nextMinute) || nextMinute < 540 || nextMinute > 720 || nextMinute % 5 !== 0) {
            event.currentTarget.value = minuteToClock(selectedExitMinute);
            return;
        }
        selectedExitMinute = nextMinute;
        if (activeAnalysisContext) void renderBestExitAnalysis(activeAnalysisContext);
    });
    const tableWrap = container.querySelector('.best-exit-table-wrap');
    if (tableWrap && bestExitRowsExpanded) tableWrap.scrollTop = previousScrollTop;
    container.querySelector('.best-exit-expand')?.addEventListener('click', () => {
        bestExitRowsExpanded = !bestExitRowsExpanded;
        renderSummary(container, summary, unavailable);
    });
}

function countMissingMarketResults(trades) {
    return trades.reduce((count, trade) => count + (cachedMarketResult(trade) && cachedTimePrice(trade) ? 0 : 1), 0);
}

function scheduleSilentRefresh(container, trades, requestId, delay = REFRESH_AFTER_PROGRESS_MS) {
    clearTimeout(silentRefreshTimer);
    if (requestId !== renderRequest || !container?.isConnected || !countMissingMarketResults(trades)) return;
    silentRefreshTimer = setTimeout(async () => {
        if (requestId !== renderRequest || !container?.isConnected) return;
        if (analysisRunning) {
            scheduleSilentRefresh(container, trades, requestId, REFRESH_AFTER_PROGRESS_MS);
            return;
        }
        const before = countMissingMarketResults(trades);
        try {
            const rows = await loadMarketResults(trades);
            if (requestId !== renderRequest || !container?.isConnected) return;
            const after = countMissingMarketResults(trades);
            if (after < before) {
                console.info(`[Polygon analysis] тихо додано ${before - after}; готово ${trades.length - after}/${trades.length}`);
                renderSummary(container, summarizeBestExits(rows), after, false);
            }
            scheduleSilentRefresh(container, trades, requestId, after < before ? REFRESH_AFTER_PROGRESS_MS : REFRESH_WHEN_WAITING_MS);
        } catch (error) {
            console.warn('[Polygon analysis] фонове оновлення відкладено:', error?.message || error);
            scheduleSilentRefresh(container, trades, requestId, REFRESH_WHEN_WAITING_MS);
        }
    }, delay);
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

async function runAnalysis(container, trades, requestId) {
    if (analysisRunning) return;
    analysisRunning = true;
    const updateProgress = (done, total) => {
        if (requestId !== renderRequest) return;
        const percent = total ? Math.round(done / total * 100) : 0;
        container.innerHTML = `
            <div class="best-exit-loading"><span></span> Оброблено ${done} із ${total} угод (${percent}%)</div>
            <div class="best-exit-loading-counts">Пройдено ${done} · залишилось ${Math.max(0, total - done)}</div>
            <div class="best-exit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>
            <p class="stats-chart-note">Можна перейти на іншу сторінку. Повторний запуск продовжить із кешованих результатів.</p>`;
    };
    try {
        const rows = await loadMarketResults(trades, updateProgress);
        if (requestId !== renderRequest) { analysisRunning = false; return; }
        analysisRunning = false;
        renderSummary(container, summarizeBestExits(rows), trades.length - rows.length);
        scheduleSilentRefresh(container, trades, requestId);
    } catch (error) {
        analysisRunning = false;
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
    clearTimeout(silentRefreshTimer);
    bestExitRowsExpanded = false;
    activeAnalysisContext = { journal, periodDates, sourceType };
    if (!['current', 'trader'].includes(sourceType)) {
        container.innerHTML = '<div class="stats-empty-note">Аналіз доступний для одного трейдера, а не для об’єднаного куща.</div>';
        return;
    }
    const trades = collectTimedShortTrades(journal, periodDates, { marketOpenStopsOnly });
    activeAnalysisTrades = trades;
    activeAnalysisRequestId = requestId;
    analysisRunning = false;
    if (!trades.length) {
        container.innerHTML = `${marketStopFilterControl()}<div class="stats-empty-note">${marketOpenStopsOnly ? 'У вибраному періоді немає мінусових позицій, перенесених через відкриття маркету 09:30 NY.' : 'У вибраному періоді немає закритих short-угод із коректними цінами входу/виходу після виключення Stop і Take.'}</div>`;
        attachMarketStopFilter(container);
        return;
    }
    const uncached = countMissingMarketResults(trades);
    if (uncached > AUTO_ANALYZE_LIMIT) {
        const completed = trades.length - uncached;
        const percent = trades.length ? Math.round(completed / trades.length * 100) : 0;
        container.innerHTML = `
            <div class="best-exit-start">
                <div><strong>${trades.length} угод у періоді</strong><span>${uncached} ще потребують market data</span></div>
                ${marketStopFilterControl()}
                <button type="button" class="btn-primary best-exit-start-btn">Старт / перевірити все</button>
            </div>
            <div class="best-exit-loading-counts">Пройдено ${completed} · залишилось ${uncached}</div>
            <div class="best-exit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>
            <p class="stats-chart-note">Дані завантажуються короткими пакетами по ${BATCH_SIZE} угод і зберігаються в Supabase. Повторний запуск не починається спочатку.</p>`;
        container.querySelector('.best-exit-start-btn')?.addEventListener('click', () => runAnalysis(container, trades, requestId));
        attachMarketStopFilter(container);
        return;
    }
    await runAnalysis(container, trades, requestId);
}
