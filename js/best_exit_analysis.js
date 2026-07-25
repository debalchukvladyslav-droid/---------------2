import { supabase, SUPABASE_URL } from './supabase.js';
import { attachBestExitResult, bestExitWindowNY, collectTimedShortTrades, summarizeBestExits } from './best_exit_core.js';

const resultCache = new Map();
let renderRequest = 0;
const AUTO_ANALYZE_LIMIT = 40;
const BATCH_SIZE = 5;

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
    return Array.isArray(payload.results) ? payload.results : [];
}

async function loadMarketResults(trades, onProgress = null) {
    const missing = [];
    trades.forEach((trade) => {
        const key = `${trade.symbol}|${trade.date}|${trade.entryMinute}`;
        if (!resultCache.has(key)) missing.push(trade);
    });
    let completed = trades.length - missing.length;
    onProgress?.(completed, trades.length);
    for (let index = 0; index < missing.length; index += BATCH_SIZE) {
        const chunk = missing.slice(index, index + BATCH_SIZE);
        const results = await fetchBatch(chunk.map(({ symbol, date, entryMinute }) => ({ symbol, date, entryMinute })));
        results.forEach((row) => {
            if (!bestExitWindowNY(row?.lowTime)) return;
            resultCache.set(`${row.symbol}|${row.date}|${row.entryMinute}`, row);
        });
        completed += chunk.length;
        onProgress?.(completed, trades.length);
    }
    return trades.map((trade) => attachBestExitResult(
        trade,
        resultCache.get(`${trade.symbol}|${trade.date}|${trade.entryMinute}`),
    )).filter(Boolean);
}

function renderSummary(container, summary, unavailable = 0) {
    const topRows = summary.rows.slice(0, 8);
    const commonWindow = bestWindowSummary(summary.rows);
    container.innerHTML = `
        <div class="best-exit-metrics">
            <div><span>Угод по часу</span><strong>${summary.count}</strong></div>
            <div><span>Макс. результат на low</span><strong>${money(summary.bestPnl)}</strong></div>
            <div><span>Не забрано до low</span><strong>${money(summary.extraPnl)}</strong></div>
            <div><span>Забрано руху</span><strong>${summary.avgCapturePct == null ? '—' : `${summary.avgCapturePct.toFixed(0)}%`}</strong></div>
            <div><span>Найчастіший найкращий час</span><strong>${commonWindow ? `${commonWindow[0]} NY` : '—'}</strong></div>
        </div>
        ${unavailable ? `<p class="stats-chart-note">Без market data: ${unavailable}. Перевірте тариф Polygon для historical minute aggregates.</p>` : ''}
        <div class="best-exit-table-wrap">
            <table class="best-exit-table">
                <thead><tr><th>Дата</th><th>Тікер</th><th>Найкраща ціна виходу</th><th>Найкращий 10-хв діапазон (NY)</th><th>Макс. P&amp;L</th><th>Не забрано</th></tr></thead>
                <tbody>${topRows.map((row) => `<tr>
                    <td>${row.date}</td><td>${row.symbol}</td><td>${row.low.toFixed(2)}</td>
                    <td><strong>${bestExitWindowNY(row.lowTime) || '—'}</strong></td><td>${money(row.bestPnl)}</td><td>${money(row.extraPnl)}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>`;
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
    if (!['current', 'trader'].includes(sourceType)) {
        container.innerHTML = '<div class="stats-empty-note">Аналіз доступний для одного трейдера, а не для об’єднаного куща.</div>';
        return;
    }
    const trades = collectTimedShortTrades(journal, periodDates);
    if (!trades.length) {
        container.innerHTML = '<div class="stats-empty-note">У вибраному періоді немає short-угод із виходом «по часу» та коректною ціною входу.</div>';
        return;
    }
    const uncached = trades.filter((trade) => !resultCache.has(`${trade.symbol}|${trade.date}|${trade.entryMinute}`)).length;
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
