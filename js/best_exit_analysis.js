import { supabase, SUPABASE_URL } from './supabase.js';
import { attachBestExitResult, bestExitWindowNY, buildLowTimeFrequencySeries, calculateShortExitComparison, collectTimedShortTrades, summarizeBestExits } from './best_exit_core.js';
import { readPolygonResult, readPolygonTimePrice, writePolygonResults, writePolygonTimePrices } from './polygon_result_cache.js';

const resultCache = new Map();
let renderRequest = 0;
const BATCH_SIZE = 5;
const MAX_ITEMS_PER_PRICE_REQUEST = 20;
let bestExitRowsExpanded = false;
let lowChartFromTen = false;
let silentRefreshTimer = null;
let activeAnalysisTrades = [];
let activeAnalysisRequestId = 0;
let analysisRunning = false;
let marketOpenStopsOnly = false;
let activeAnalysisContext = null;
let activePeriodLabel = 'За весь час';
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
    return readPolygonTimePrice({ symbol: trade.symbol, date: trade.date, targetMinute: selectedExitMinute, stopEntryMinute: trade.stopEntryMinute, stopPrice: trade.stopPrice });
}

function money(value) {
    return Number.isFinite(Number(value))
        ? `${Number(value).toLocaleString('uk-UA', { maximumFractionDigits: 0 })}$`
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
    let { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
    items.forEach((item) => console.info(`[Polygon] переглядається ${item.symbol} · ${item.date} · від ${String(Math.floor(item.entryMinute / 60)).padStart(2, '0')}:${String(item.entryMinute % 60).padStart(2, '0')} NY`));
    const request = (accessToken) => fetch(`${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/market-best-exits`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ items, targetMinute: selectedExitMinute }),
    });
    let response = await request(session.access_token);
    if (response.status === 401) {
        const refreshed = await supabase.auth.refreshSession();
        session = refreshed.data?.session || null;
        if (session?.access_token) response = await request(session.access_token);
    }
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
        const results = await fetchBatch(chunk.map(({ symbol, date, entryMinute, stopEntryMinute, stopPrice }) => ({ symbol, date, entryMinute, stopEntryMinute, stopPrice })));
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
        const priceItems = missingTimePrices.slice(0, MAX_ITEMS_PER_PRICE_REQUEST).map(({ symbol, date, entryMinute, stopEntryMinute, stopPrice }) => ({ symbol, date, entryMinute, stopEntryMinute, stopPrice }));
        const priceResults = await fetchBatch(priceItems);
        writePolygonResults(priceResults);
        completed = trades.length - countMissingMarketResults(trades);
        onProgress?.(completed, trades.length);
    }
    return buildRowsFromCache(trades);
}

function buildRowsFromCache(trades = []) {
    return trades.map((trade) => {
        const row = attachBestExitResult(trade, cachedMarketResult(trade));
        if (!row) return null;
        const timePrice = cachedTimePrice(trade);
        const selectedPrice = timePrice?.notOpened ? NaN : (timePrice?.stopHit ? Number(timePrice.stopPrice) : Number(timePrice?.priceAtTime));
        const comparison = calculateShortExitComparison({ entryPrice: row.entryPrice, actualExitPrice: row.actualExitPrice, selectedPrice, qty: row.qty });
        return { ...row, selectedPrice: selectedPrice > 0 ? selectedPrice : null, selectedPriceMinute: timePrice?.priceMinute ?? null, notOpened: timePrice?.notOpened === true, stopHit: timePrice?.stopHit === true, stopMinute: timePrice?.stopMinute ?? null, stopTime: timePrice?.stopTime || '', actualGross: comparison?.actualGross ?? null, selectedGross: comparison?.selectedGross ?? null, selectedGrossDiff: comparison?.difference ?? null };
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
    const actualRows = summary.rows.filter((row) => Number.isFinite(Number(row.actualPnl)));
    const actualGrossTotal = actualRows.reduce((total, row) => total + Number(row.actualPnl), 0);
    const theoreticalRows = summary.rows.filter((row) => Number.isFinite(Number(row.selectedGross)));
    const theoreticalGrossTotal = theoreticalRows.reduce((total, row) => total + Number(row.selectedGross), 0);
    if (logToConsole) {
        console.groupCollapsed(`[Polygon analysis] кращий вихід: ${summary.count} угод, забрано ${summary.avgCapturePct == null ? '—' : `${summary.avgCapturePct.toFixed(1)}%`} руху`);
        console.table(summary.rows.map((row) => ({ дата: row.date, тікер: row.symbol, вхід: row.entryPrice, фактичний_вихід: row.actualExitPrice, low: row.low, час_low: row.lowTime, причина_виходу: row.exitReason || 'не вказано', забрано_руху_pct: row.capturePct == null ? null : Number(row.capturePct.toFixed(1)), не_забрано_$: row.extraPnl == null ? null : Number(row.extraPnl.toFixed(2)) })));
        console.info({ analyzed: summary.count, unavailable, bestPnl: summary.bestPnl, extraPnl: summary.extraPnl, capturedMovementPct: summary.avgCapturePct, commonBestWindow: commonWindow?.[0] || null });
        console.groupEnd();
    }
    container.innerHTML = `
        <button type="button" class="best-exit-period-control" data-best-exit-period-open>
            <span>Період</span><strong>${escapeHtml(activePeriodLabel)}</strong><em>${totalTrades} short-угод</em><b aria-hidden="true">▼</b>
        </button>
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
                <span class="best-exit-auto-status">${analysisRunning ? 'Оновлюється автоматично…' : 'Автоматичне оновлення'}</span>
            </div>
            <div class="best-exit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPercent}"><i style="width:${progressPercent}%"></i></div>
        </div>
        ${exitTimeChart(summary.rows)}
        <div class="best-exit-time-simulator">
            <div><strong>Результат при виході у вибраний час</strong><span>Gross через entry × shares, час NY</span></div>
            <div class="best-exit-time-totals">
                <div><span>Фактичний Gross</span><strong>${actualRows.length ? money(actualGrossTotal) : '—'}</strong></div>
                <div><span data-best-exit-theoretical-label>Теоретичний Gross · ${minuteToClock(selectedExitMinute)}</span><strong data-best-exit-theoretical-value>${theoreticalRows.length ? money(theoreticalGrossTotal) : '…'}</strong></div>
            </div>
            <div class="best-exit-time-picker" aria-label="Час виходу від 09:00 до 12:00">
                <button type="button" data-best-exit-time-step="-5" aria-label="На 5 хвилин раніше" ${selectedExitMinute <= 540 ? 'disabled' : ''}>‹</button>
                <label><span>Час виходу</span><select data-best-exit-target-time>${timeOptions()}</select></label>
                <button type="button" data-best-exit-time-step="5" aria-label="На 5 хвилин пізніше" ${selectedExitMinute >= 720 ? 'disabled' : ''}>›</button>
            </div>
        </div>
        <div class="best-exit-table-wrap${bestExitRowsExpanded ? ' is-expanded' : ''}">
            <table class="best-exit-table">
                <thead><tr><th>Дата</th><th>Тікер</th><th>Вихід</th><th>Low</th><th>Забрано руху</th><th>Найкращий 10-хв діапазон (NY)</th><th>Макс. P&amp;L</th><th>Не забрано</th><th>Сценарій</th><th data-best-exit-price-heading>Ціна @ ${minuteToClock(selectedExitMinute)}</th><th>Gross @ час</th><th>Δ до факту</th></tr></thead>
                <tbody>${topRows.map((row) => `<tr>
                    <td>${row.date}</td><td><button type="button" class="best-exit-trade-link" data-best-exit-date="${escapeHtml(row.date)}" data-best-exit-index="${Number(row.tradeIndex)}" data-best-exit-identity="${escapeHtml(JSON.stringify(row.tradeIdentity || {}))}" title="Відкрити ${escapeHtml(row.symbol)} у журналі">${escapeHtml(row.symbol)}</button></td><td>${row.actualExitPrice.toFixed(2)}</td><td>${row.low.toFixed(2)}</td><td>${row.capturePct == null ? '—' : `${row.capturePct.toFixed(0)}%`}</td>
                    <td><strong>${bestExitWindowNY(row.lowTime) || '—'}</strong></td><td>${money(row.bestPnl)}</td><td>${money(row.extraPnl)}</td>
                    <td>${row.notOpened ? '<span class="best-exit-not-opened">Ще не відкрито</span>' : (row.stopHit ? `<span class="best-exit-stop-hit">Стоп ${row.stopMinute == null ? '' : minuteToClock(row.stopMinute)} · $${Number(row.stopPrice).toFixed(2)}</span>` : (row.selectedPrice == null ? '…' : `<span class="best-exit-time-exit">Вихід ${minuteToClock(selectedExitMinute)}</span>`))}</td>
                    <td>${row.selectedPrice == null ? '…' : row.selectedPrice.toFixed(2)}</td><td>${money(row.selectedGross)}</td><td class="${Number(row.selectedGrossDiff) >= 0 ? 'positive' : 'negative'}">${row.selectedGrossDiff == null ? '—' : money(row.selectedGrossDiff)}</td>
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
    container.querySelector('[data-best-exit-period-open]')?.addEventListener('click', () => {
        const trigger = document.getElementById('stats-period-trigger');
        trigger?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => trigger?.click(), 220);
    });
    container.querySelector('[data-low-chart-from-ten]')?.addEventListener('change', (event) => {
        lowChartFromTen = !!event.currentTarget.checked;
        renderSummary(container, summary, unavailable, false);
    });
    attachMarketStopFilter(container);
    const timeSelect = container.querySelector('[data-best-exit-target-time]');
    const changeSelectedTime = (nextMinute) => {
        if (!Number.isInteger(nextMinute) || nextMinute < 540 || nextMinute > 720 || nextMinute % 5 !== 0 || nextMinute === selectedExitMinute) return;
        selectedExitMinute = nextMinute;
        const clock = minuteToClock(selectedExitMinute);
        if (timeSelect) timeSelect.value = String(selectedExitMinute);
        container.querySelectorAll('[data-best-exit-time-step]').forEach((button) => {
            const step = Number(button.getAttribute('data-best-exit-time-step') || 0);
            button.disabled = selectedExitMinute + step < 540 || selectedExitMinute + step > 720;
        });
        const theoreticalLabel = container.querySelector('[data-best-exit-theoretical-label]');
        const theoreticalValue = container.querySelector('[data-best-exit-theoretical-value]');
        const priceHeading = container.querySelector('[data-best-exit-price-heading]');
        if (theoreticalLabel) theoreticalLabel.textContent = `Теоретичний Gross · ${clock}`;
        if (theoreticalValue) theoreticalValue.textContent = 'Оновлюється…';
        if (priceHeading) priceHeading.textContent = `Ціна @ ${clock}`;
        console.info(`[Polygon analysis] вибрано час виходу ${clock} NY`);
        const requestId = ++renderRequest;
        activeAnalysisRequestId = requestId;
        analysisRunning = false;
        void runAnalysis(container, activeAnalysisTrades, requestId);
    };
    timeSelect?.addEventListener('change', (event) => {
        changeSelectedTime(Number(event.currentTarget.value));
    });
    container.querySelectorAll('[data-best-exit-time-step]').forEach((button) => button.addEventListener('click', () => {
        changeSelectedTime(selectedExitMinute + Number(button.getAttribute('data-best-exit-time-step') || 0));
    }));
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
        const status = container.querySelector('.best-exit-run-status');
        if (status) {
            const text = status.querySelector('.best-exit-run-status__head div span');
            const bar = status.querySelector('.best-exit-progress');
            if (text) text.textContent = `Пройдено ${done} із ${total} · залишилось ${Math.max(0, total - done)}`;
            if (bar) {
                bar.setAttribute('aria-valuenow', String(percent));
                const fill = bar.querySelector('i');
                if (fill) fill.style.width = `${percent}%`;
            }
            return;
        }
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

export async function renderBestExitAnalysis({ journal = {}, periodDates = new Set(), sourceType = 'current', periodLabel = 'За весь час' } = {}) {
    const container = document.getElementById('stats-best-exit-content');
    if (!container) return;
    const requestId = ++renderRequest;
    clearTimeout(silentRefreshTimer);
    bestExitRowsExpanded = false;
    activePeriodLabel = String(periodLabel || 'За весь час');
    activeAnalysisContext = { journal, periodDates, sourceType, periodLabel: activePeriodLabel };
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
    const initialRows = buildRowsFromCache(trades);
    renderSummary(container, summarizeBestExits(initialRows), countMissingMarketResults(trades), false);
    await runAnalysis(container, trades, requestId);
}
