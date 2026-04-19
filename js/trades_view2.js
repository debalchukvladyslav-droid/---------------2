// === js/trades_view2.js ===
import { state } from './state.js';
import { supabase, SUPABASE_URL } from './supabase.js';
import { buildTradeContext, analyzeTradeStory, renderStoryOverlay } from './trade_story.js';
import { sleep } from './ai.js';
import { saveJournalData, markJournalDayDirty, loadTradeDays } from './storage.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { findScreenshotsForTicker, openScreenshotForTrade } from './gallery.js';

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

let lwChart = null;
let candleSeries = null;
let lwChartsReady = null;
let _storyPanelOpen = false;
let _tradeDaysLoadPromise = null;
let _tradeDaysLoadUserId = null;

// Активна угода для поточного дня { symbol, dateStr, tradeIndex }
let _activeTrade = null;

function ensureLWCharts() {
    if (!lwChartsReady) {
        lwChartsReady = new Promise((resolve, reject) => {
            if (window.LightweightCharts?.createChart) return resolve();
            const s = document.createElement('script');
            s.src = '/lw-charts.js';
            s.onload = () => window.LightweightCharts?.createChart ? resolve() : reject(new Error('LW Charts не завантажився'));
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }
    return lwChartsReady;
}

export function initTradesView() {
    ensureLWCharts();
    // Ховаємо кнопки доки не вибрано жодної угоди
    const wrapper = document.getElementById('tv-widget-container');
    if (wrapper) {
        wrapper.querySelector('#ts-ai-btn')?.remove();
        wrapper.querySelector('#ts-show-btn')?.remove();
        wrapper.querySelector('#ts-fullscreen-btn')?.remove();
    }
}

async function ensureTradeDaysLoaded() {
    const userId = state.currentViewedUserId || state.myUserId || null;
    if (!userId) return;

    if (!_tradeDaysLoadPromise || _tradeDaysLoadUserId !== userId) {
        _tradeDaysLoadUserId = userId;
        showGlobalLoader('trade-days-load', 'Завантаження імпортованих угод...');
        _tradeDaysLoadPromise = loadTradeDays()
            .catch((e) => {
                _tradeDaysLoadPromise = null;
                _tradeDaysLoadUserId = null;
                throw e;
            })
            .finally(() => hideGlobalLoader('trade-days-load'));
    }
    return _tradeDaysLoadPromise;
}

export async function populateDateSelect() {
    const sel = document.getElementById('trades-date-select');
    if (!sel) return;

    await ensureTradeDaysLoaded();

    const dates = Object.keys(state.appData.journal)
        .filter(d => state.appData.journal[d].trades?.length > 0)
        .sort((a, b) => b.localeCompare(a));

    sel.innerHTML = '<option value="">— Оберіть день —</option>';
    dates.forEach(d => {
        const trades = state.appData.journal[d].trades;
        const net = trades.reduce((s, t) => s + t.net, 0);
        const sign = net >= 0 ? '+' : '';
        const opt = document.createElement('option');
        opt.value = sanitizeHTML(d);
        opt.textContent = `${d} (${sign}${net.toFixed(0)}$, ${trades.length} угод)`;
        sel.appendChild(opt);
    });

    const dateToSelect = state.selectedDateStr && state.appData.journal[state.selectedDateStr]?.trades?.length > 0
        ? state.selectedDateStr
        : dates[0];
    if (dateToSelect) {
        sel.value = dateToSelect;
        renderPillNav(dateToSelect);
    }
}

export function populateSymbolSelect(dateStr) {
    // Sync the date <select> to match the calendar selection
    const sel = document.getElementById('trades-date-select');
    if (sel && dateStr) {
        // Add the date as an option if it has trades and isn't already present
        const hasTrades = (state.appData.journal[dateStr]?.trades?.length > 0);
        if (hasTrades) {
            if (!sel.querySelector(`option[value="${dateStr}"]`)) {
                void populateDateSelect();
            }
            sel.value = dateStr;
        }
    }
    if (dateStr) renderPillNav(dateStr);
}

// ─── Pill Navigation ──────────────────────────────────────────────────────────

function renderPillNav(dateStr) {
    const nav = document.getElementById('trade-pill-nav');
    if (!nav) return;
    nav.innerHTML = '';

    const allTrades = (state.appData.journal[dateStr] || {}).trades || [];
    if (!allTrades.length) {
        // No trades for this date — clear the chart and info bar
        const placeholder = document.getElementById('tv-placeholder');
        const container   = document.getElementById('tradingview-widget');
        const bar         = document.getElementById('trade-info-bar');
        const wrapper     = document.getElementById('tv-widget-container');
        if (placeholder) placeholder.style.display = 'flex';
        if (container)   { container.style.display = 'none'; container.innerHTML = ''; }
        if (bar)         { bar.innerHTML = ''; bar.style.display = 'none'; }
        if (lwChart)     { lwChart.remove(); lwChart = null; candleSeries = null; }
        if (wrapper)     {
            wrapper.querySelector('#ts-ai-btn')?.remove();
            wrapper.querySelector('#ts-show-btn')?.remove();
            wrapper.querySelector('#ts-fullscreen-btn')?.remove();
        }
        return;
    }

    // Day summary label
    const dayNet = allTrades.reduce((s, t) => s + t.net, 0);
    const dayLabel = document.createElement('span');
    dayLabel.style.cssText = 'font-size:0.75rem;color:var(--text-muted);white-space:nowrap;margin-right:4px;flex-shrink:0;';
    dayLabel.textContent = `${dateStr} · ${dayNet >= 0 ? '+' : ''}${dayNet.toFixed(0)}$`;
    nav.appendChild(dayLabel);

    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 4px;';
    nav.appendChild(sep);

    allTrades.forEach((trade, idx) => {
        const isProfit = trade.net >= 0;
        const timeIn = trade.opened?.split(' ')[1] || trade.opened || '';
        const pill = document.createElement('button');
        pill.className = `trade-pill ${isProfit ? 'profit' : 'loss'}`;
        pill.dataset.idx = idx;
        pill.textContent = `${trade.symbol} ${trade.type === 'Short' ? '▼' : '▲'} ${timeIn} ${isProfit ? '+' : ''}${trade.net.toFixed(0)}$`;
        pill.addEventListener('click', () => _selectTrade(dateStr, idx));
        nav.appendChild(pill);
    });

    // Re-highlight existing active trade for this date, otherwise auto-select first
    if (_activeTrade?.dateStr === dateStr) {
        _highlightPill(_activeTrade.tradeIndex);
    } else {
        _selectTrade(dateStr, 0);
    }
}

function _highlightPill(idx) {
    const nav = document.getElementById('trade-pill-nav');
    if (!nav) return;
    nav.querySelectorAll('.trade-pill').forEach((p, i) => {
        p.classList.toggle('active', i === idx);
    });
}

function _selectTrade(dateStr, tradeIndex) {
    const allTrades = (state.appData.journal[dateStr] || {}).trades || [];
    if (!allTrades.length) return;

    const trade = allTrades[tradeIndex];
    if (!trade) return;

    _activeTrade = { dateStr, tradeIndex };
    _highlightPill(tradeIndex);

    // Очищаємо попередній стан аналізу
    _storyPanelOpen = false;

    const wrapper = document.getElementById('tv-widget-container');
    if (wrapper) {
        wrapper.querySelectorAll('.ts-pin').forEach(el => el.remove());
        wrapper.querySelector('#ts-summary-panel')?.remove();
        wrapper.querySelector('#ts-ai-btn')?.remove();
        wrapper.querySelector('#ts-show-btn')?.remove();
        wrapper.querySelector('#ts-fullscreen-btn')?.remove();
    }

    // Ховаємо кнопки поки йде завантаження графіку
    if (wrapper) {
        ['ts-ai-btn', 'ts-show-btn', 'ts-fullscreen-btn'].forEach(id => {
            const el = wrapper.querySelector(`#${id}`);
            if (el) el.style.display = 'none';
        });
    }

    // Destroy previous chart completely — wipes all series, markers, and HTML overlays
    if (lwChart) {
        try { lwChart.remove(); } catch (_) {}
        lwChart = null;
        candleSeries = null;
    }

    renderTradeInfoBar([trade]);
    buildLWChart(trade.symbol, dateStr, [trade]);
}

export function loadTradeChart(symbol, dateStr) {
    if (!dateStr) dateStr = document.getElementById('trades-date-select')?.value;
    if (!dateStr || !symbol) return;

    const allTrades = (state.appData.journal[dateStr] || {}).trades || [];
    const idx = allTrades.findIndex(t => t.symbol === symbol);
    if (idx === -1) return;

    _selectTrade(dateStr, idx);
}

/** Відкрити вкладку «Угоди» і конкретну угоду дня (після імпорту Fondexx). */
export async function openTradesAtDayIndex(dateStr, tradeIndex) {
    if (!dateStr || !state.appData?.journal?.[dateStr]?.trades?.length) return;
    const idx = Math.max(0, Math.min(parseInt(tradeIndex, 10) || 0, state.appData.journal[dateStr].trades.length - 1));
    if (window.switchMainTab) window.switchMainTab('trades');
    await populateDateSelect();
    const sel = document.getElementById('trades-date-select');
    if (sel) {
        if (!sel.querySelector(`option[value="${dateStr}"]`)) await populateDateSelect();
        sel.value = dateStr;
    }
    renderPillNav(dateStr);
    _selectTrade(dateStr, idx);
}

function renderTradeInfoBar(trades) {
    const bar = document.getElementById('trade-info-bar');
    if (!bar) return;
    const totalNet   = trades.reduce((s, t) => s + t.net, 0);
    const totalGross = trades.reduce((s, t) => s + t.gross, 0);
    const totalComm  = trades.reduce((s, t) => s + t.comm, 0);
    const isProfit   = totalNet >= 0;

    const trade = trades[0];
    const duration = (() => {
        if (!trade?.opened || !trade?.closed) return null;
        const a = parseTradeTs(trade.opened, _activeTrade?.dateStr || '');
        const b = parseTradeTs(trade.closed,  _activeTrade?.dateStr || '');
        const mins = Math.round(Math.abs(b - a) / 60);
        return mins >= 60 ? `${Math.floor(mins/60)}г ${mins%60}хв` : `${mins}хв`;
    })();

    const items = [
        { label: 'Net PnL',   value: `${isProfit ? '+' : ''}${totalNet.toFixed(2)}$`,          color: isProfit ? 'var(--profit)' : 'var(--loss)', big: true },
        { label: 'Gross',     value: `${totalGross >= 0 ? '+' : ''}${totalGross.toFixed(2)}$`,  color: 'var(--text-main)' },
        { label: 'Комісії',   value: `-${totalComm.toFixed(2)}$`,                                color: 'var(--loss)' },
        { label: 'Угод',      value: String(trades.length),                                      color: 'var(--text-muted)' },
        ...(duration ? [{ label: 'Час',  value: duration,                                                   color: 'var(--text-muted)' }] : []),
        ...(trade?.shares ? [{ label: 'Акцій', value: String(trade.shares),                                    color: 'var(--text-muted)' }] : []),
    ];

    bar.innerHTML = '';
    bar.style.display = 'flex';
    bar.style.cssText = 'display:flex;flex-shrink:0;gap:8px;padding:8px 15px;background:var(--bg-panel);border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;';

    items.forEach(({ label, value, color, big }) => {
        const card = document.createElement('div');
        card.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;padding:${big ? '6px 16px' : '5px 12px'};background:var(--bg-main);border:1px solid var(--border);border-radius:8px;min-width:${big ? '90px' : '70px'};gap:2px;`;
        if (big) card.style.borderColor = isProfit ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)';
        const val = document.createElement('span');
        val.style.cssText = `font-size:${big ? '1rem' : '0.85rem'};font-weight:${big ? '700' : '600'};color:${color};line-height:1.2;`;
        val.textContent = value;
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;';
        lbl.textContent = label;
        card.appendChild(val);
        card.appendChild(lbl);
        bar.appendChild(card);
    });

    if (trade) {
        const hasScreen = findScreenshotsForTicker(_activeTrade?.dateStr, trade.symbol).length > 0;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = `padding:6px 12px;background:${hasScreen ? 'rgba(59,130,246,0.12)' : 'var(--bg-main)'};border:1px solid ${hasScreen ? 'var(--accent)' : 'var(--border)'};border-radius:8px;color:${hasScreen ? 'var(--accent)' : 'var(--text-muted)'};font-weight:700;cursor:pointer;`;
        btn.textContent = hasScreen ? 'Відкрити скрін' : 'Скріна ще немає';
        btn.addEventListener('click', () => void openScreenshotForTrade(_activeTrade?.dateStr, trade));
        bar.appendChild(btn);
    }
}

// ─── VWAP ────────────────────────────────────────────────────────────────────
function calcVWAP(candles) {
    let cumPV = 0, cumV = 0;
    return candles
        .filter(c => (c.volume ?? 0) > 0)
        .map(c => {
            const tp = (c.high + c.low + c.close) / 3;
            cumPV += tp * c.volume;
            cumV  += c.volume;
            return { time: c.time, value: +(cumPV / cumV).toFixed(4) };
        });
}

async function buildLWChart(symbol, dateStr, trades) {
    const placeholder = document.getElementById('tv-placeholder');
    const container   = document.getElementById('tradingview-widget');
    if (!container) return;

    if (placeholder) placeholder.style.display = 'none';
    container.style.display = 'block';
    container.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">⏳ Завантаження даних...</div>';

    const old = document.getElementById('trade-overlay-list');
    if (old) old.remove();

    await ensureLWCharts();

    let candles = [];
    try {
        candles = await fetchYahooCandles(symbol, dateStr);
    } catch(e) {
        container.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'color:var(--loss);padding:20px;text-align:center;';
        errDiv.textContent = `❌ Не вдалось завантажити дані: ${e.message}`;
        container.appendChild(errDiv);
        return;
    }

    if (!candles.length) {
        container.textContent = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'color:var(--text-muted);padding:20px;text-align:center;';
        emptyDiv.textContent = `Немає даних для ${symbol} за ${dateStr}`;
        container.appendChild(emptyDiv);
        return;
    }

    container.innerHTML = '';

    if (lwChart) {
        lwChart.remove();
        lwChart = null;
        candleSeries = null;
    }

    const isDark = document.body.getAttribute('data-theme') !== 'light';

    lwChart = LightweightCharts.createChart(container, {
        width:  container.clientWidth,
        height: container.clientHeight || 500,
        layout: {
            background: { color: isDark ? '#0f172a' : '#ffffff' },
            textColor:  isDark ? '#94a3b8' : '#334155',
        },
        grid: {
            vertLines: { color: isDark ? '#1e293b' : '#e2e8f0' },
            horzLines: { color: isDark ? '#1e293b' : '#e2e8f0' },
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: isDark ? '#334155' : '#cbd5e1' },
        // FIX 5: wheel zoom enabled
        handleScroll: true,
        handleScale:  true,
        timeScale: {
            borderColor:     isDark ? '#334155' : '#cbd5e1',
            timeVisible:     true,
            secondsVisible:  false,
            // ZOOM FIX: вимикаємо autofit при відкритті
            rightOffset:     5,
            tickMarkFormatter: (time) => {
                const d = new Date(time * 1000);
                return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: false });
            },
        },
    });

    // ZOOM FIX: без autoscaleInfoProvider — стандартний масштаб 1:1
    candleSeries = lwChart.addCandlestickSeries({
        upColor:        '#10b981', downColor:        '#ef4444',
        borderUpColor:  '#10b981', borderDownColor:  '#ef4444',
        wickUpColor:    '#10b981', wickDownColor:    '#ef4444',
    });
    candleSeries.setData(candles);

    // VWAP — рахуємо тільки з 04:00 поточного дня
    const offset = getNYOffset(dateStr);
    const ts0400 = Math.floor(new Date(`${dateStr}T04:00:00${offset}`).getTime() / 1000);
    const vwapData = calcVWAP(candles.filter(c => c.time >= ts0400));
    if (vwapData.length) {
        const vwapSeries = lwChart.addLineSeries({
            color: 'rgba(251,191,36,0.85)', lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Solid,
            priceLineVisible: false, lastValueVisible: false,
            title: 'VWAP',
        });
        vwapSeries.setData(vwapData);
    }

    // Вертикальні лінії сесій (HTML overlay)
    const sessionMarkers = [
        { hour: 4,  min: 0,  label: 'Pre-market', color: 'rgba(148,163,184,0.5)' },
        { hour: 9,  min: 30, label: 'Open',        color: 'rgba(16,185,129,0.7)'  },
        { hour: 16, min: 0,  label: 'Close',       color: 'rgba(239,68,68,0.6)'   },
        { hour: 20, min: 0,  label: 'After-hours', color: 'rgba(148,163,184,0.35)'},
    ];

    function renderSessionLines() {
        container.querySelectorAll('.session-vline').forEach(el => el.remove());
        const timeScale = lwChart.timeScale();
        sessionMarkers.forEach(({ hour, min, label, color }) => {
            const ts = Math.floor(new Date(`${dateStr}T${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00${offset}`).getTime() / 1000);
            const x = timeScale.timeToCoordinate(ts);
            if (x === null || x < 0) return;
            const line = document.createElement('div');
            line.className = 'session-vline';
            line.style.cssText = `position:absolute;top:0;bottom:0;left:${Math.round(x)}px;width:1px;background:${color};z-index:5;pointer-events:none;`;
            const lbl = document.createElement('span');
            lbl.style.cssText = `position:absolute;top:4px;left:3px;font-size:0.65rem;color:${color};white-space:nowrap;font-weight:600;`;
            lbl.textContent = label;
            line.appendChild(lbl);
            container.appendChild(line);
        });
    }

    renderSessionLines();
    lwChart.timeScale().subscribeVisibleTimeRangeChange(renderSessionLines);

    // Лінії входу/виходу для угоди
    trades.forEach((trade, i) => {
        const isShort    = trade.type === 'Short';
        const isProfit   = trade.net >= 0;
        const entryColor = isShort  ? '#f97316' : '#3b82f6';
        const exitColor  = isProfit ? '#10b981' : '#ef4444';
        const timeIn     = trade.opened?.split(' ')[1] || trade.opened || '';
        const timeOut    = trade.closed?.split(' ')[1] || trade.closed || '';
        const label      = trades.length > 1 ? ` #${i + 1}` : '';

        const tsEntry = parseTradeTs(trade.opened, dateStr);
        const tsExit  = parseTradeTs(trade.closed, dateStr);

        const tEntry = snapToCandle(candles, tsEntry);
        const tExit  = snapToCandle(candles, tsExit);
        if (tEntry === null || tExit === null) return;

        const entrySeries = lwChart.addLineSeries({
            color: entryColor, lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            priceLineVisible: false, lastValueVisible: true,
            title: `${isShort ? '▼' : '▲'} ${trade.type}${label} ${timeIn}`,
        });
        entrySeries.setData([{ time: tEntry, value: trade.entry }, { time: tExit, value: trade.entry }]);

        const exitSeries = lwChart.addLineSeries({
            color: exitColor, lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: true,
            title: `✕ Exit${label} ${timeOut} (${isProfit ? '+' : ''}${trade.net.toFixed(0)}$)`,
        });
        exitSeries.setData([{ time: tEntry, value: trade.exit }, { time: tExit, value: trade.exit }]);

        const diagSeries = lwChart.addLineSeries({
            color: isProfit ? '#10b981' : '#ef4444', lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Solid,
            priceLineVisible: false, lastValueVisible: false,
        });
        diagSeries.setData([{ time: tEntry, value: trade.entry }, { time: tExit, value: trade.exit }]);
    });

    window._lwChart = lwChart;
    window._candleSeries = candleSeries;

    // Resize observer
    const ro = new ResizeObserver(() => {
        if (lwChart) lwChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    ro.observe(container);

    // ZOOM FIX: після setData — скидаємо до дефолтного масштабу без fitContent
    // Показуємо весь торговий день без автозуму на угоду
    lwChart.timeScale().scrollToPosition(0, false);

    const wrapper = document.getElementById('tv-widget-container');
    _ensureFullscreenButton(wrapper);
    _ensureStoryButton(container, trades, candles, dateStr);
}

// ─── Розраховує ідеальний вихід для шорту ────────────────────────────────────
export function calculateTradePerformance(candles, trade, dateStr) {
    if (!candles?.length || !trade) return null;

    const tsEntry  = parseTradeTs(trade.opened, dateStr);
    const tsExit   = parseTradeTs(trade.closed,  dateStr);

    const testDate  = new Date(`${dateStr}T12:00:00`);
    const nyStr     = testDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', timeZoneName: 'short' });
    const offsetStr = nyStr.includes('EDT') ? '-04:00' : '-05:00';
    const ts12pm    = Math.floor(new Date(`${dateStr}T12:00:00${offsetStr}`).getTime() / 1000);

    const windowEnd = Math.min(tsExit, ts12pm);

    let idealCandle = null;
    for (const c of candles) {
        if (c.time < tsEntry) continue;
        if (c.time > windowEnd) break;
        if (!idealCandle || c.low < idealCandle.low) idealCandle = c;
    }

    if (!idealCandle) return null;

    const ideal_exit_price = idealCandle.low;
    const ideal_exit_time  = idealCandle.time;
    const actual_profit    = trade.entry - trade.exit;
    const ideal_profit     = trade.entry - ideal_exit_price;
    const potential_extra_profit = trade.exit - ideal_exit_price;

    const performance_score = ideal_profit <= 0
        ? 0
        : Math.min(100, Math.round((actual_profit / ideal_profit) * 100));

    return { ideal_exit_price, ideal_exit_time, potential_extra_profit, performance_score };
}

// ─── Sanitize candles ─────────────────────────────────────────────────────────
function sanitizeCandles(candles) {
    if (candles.length < 2) return candles;
    return candles.map((c, i) => {
        const window = candles.slice(Math.max(0, i - 10), i);
        const atr = window.length
            ? window.reduce((sum, w) => sum + (w.high - w.low), 0) / window.length
            : (c.high - c.low) || 0.01;
        const body    = Math.abs(c.open - c.close);
        const bodyTop = Math.max(c.open, c.close);
        const bodyBot = Math.min(c.open, c.close);
        const maxWick = Math.max(body * 3, atr * 5, 0.01);
        const high = c.high > bodyTop + maxWick ? bodyTop + maxWick : c.high;
        const low  = c.low  < bodyBot - maxWick ? bodyBot - maxWick : c.low;
        return { ...c, high, low };
    });
}

// ─── Timestamp helpers ────────────────────────────────────────────────────────
function parseTradeTs(timeStr, dateStr) {
    if (!timeStr) return 0;
    const full = timeStr.includes('-') ? timeStr : `${dateStr} ${timeStr}`;
    const testDate = new Date(`${dateStr}T12:00:00`);
    const nyStr = testDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', timeZoneName: 'short' });
    const offsetStr = nyStr.includes('EDT') ? '-04:00' : '-05:00';
    return Math.floor(new Date(full.replace(' ', 'T') + offsetStr).getTime() / 1000);
}

function snapToCandle(candles, ts) {
    if (!candles.length) return null;
    let best = candles[0];
    let bestDiff = Math.abs(candles[0].time - ts);
    for (let i = 1; i < candles.length; i++) {
        const diff = Math.abs(candles[i].time - ts);
        if (diff < bestDiff) { bestDiff = diff; best = candles[i]; }
        else break;
    }
    return bestDiff <= 600 ? best.time : null;
}

// ─── Polygon.io fetch ─────────────────────────────────────────────────────────
function getNYOffset(dateStr) {
    const nyStr = new Date(`${dateStr}T12:00:00`).toLocaleString('en-US', {
        timeZone: 'America/New_York', hour12: false, hour: '2-digit', timeZoneName: 'short'
    });
    return nyStr.includes('EDT') ? '-04:00' : '-05:00';
}

function prevTradingDate(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() - 1);
    // пропускаємо вихідні
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

function mapPolygonResults(data) {
    if (!data?.results?.length) return [];
    return data.results.map((v) => ({
        time: Math.floor(v.t / 1000), open: v.o, high: v.h, low: v.l, close: v.c, volume: v.v,
    }));
}

async function fetchPolygon(symbol, fromMs, toMs) {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
        throw new Error(
            'Polygon: увійдіть у акаунт. Свічки завантажуються через Edge (секрет POLYGON_API_KEY у Supabase). Див. supabase/SECRETS-SETUP.txt',
        );
    }
    const edgeUrl = `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/polygon-aggs`;
    const res = await fetch(edgeUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ symbol, fromMs, toMs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 429) {
            throw new Error('Polygon: перевищено ліміт запитів для цього ключа. Спробуйте ще раз трохи пізніше.');
        }
        throw new Error(data?.message || `Polygon: помилка сервера ${res.status}. Перевірте POLYGON_API_KEY і деплой polygon-aggs.`);
    }
    return mapPolygonResults(data);
}

async function fetchYahooCandles(symbol, dateStr) {
    if (!/^[A-Z]{1,10}$/.test(symbol)) throw new Error('Невірний тікер');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Невірна дата');

    const cacheKey = `candles3_${symbol}_${dateStr}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);

    const offset  = getNYOffset(dateStr);
    const prevDay = prevTradingDate(dateStr);
    const prevOff = getNYOffset(prevDay);

    // Постмаркет попереднього дня: 16:00–23:59
    const prevFrom = Math.floor(new Date(`${prevDay}T16:00:00${prevOff}`).getTime() / 1000) * 1000;
    const prevTo   = Math.floor(new Date(`${prevDay}T23:59:00${prevOff}`).getTime() / 1000) * 1000;
    // Поточний день: 04:00–23:59
    const curFrom  = Math.floor(new Date(`${dateStr}T04:00:00${offset}`).getTime() / 1000) * 1000;
    const curTo    = Math.floor(new Date(`${dateStr}T23:59:00${offset}`).getTime() / 1000) * 1000;

    const curCandles = await fetchPolygon(symbol, curFrom, curTo);
    if (!curCandles.length) throw new Error('Немає даних від Polygon');

    let prevCandles = [];
    try {
        prevCandles = await fetchPolygon(symbol, prevFrom, prevTo);
    } catch (error) {
        console.warn('[Polygon] previous session candles skipped:', error);
    }

    // Об'єднуємо: постмаркет попереднього + поточний день, без дублів
    const seen = new Set();
    const merged = [...prevCandles, ...curCandles].filter(c => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
    }).sort((a, b) => a.time - b.time);

    const cleaned = sanitizeCandles(merged);
    try { sessionStorage.setItem(cacheKey, JSON.stringify(cleaned)); } catch(_) {}
    return cleaned;
}

// ─── Fullscreen button (Fullscreen API) ───────────────────────────────────────
// Single persistent listener — attached once, never duplicated
let _fsChangeHandler = null;

function _ensureFullscreenButton(wrapper) {
    if (!wrapper) return;
    const btn = document.createElement('button');
    btn.id = 'ts-fullscreen-btn';
    btn.textContent = '⛶';
    btn.title = 'На весь екран';
    btn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:25;background:rgba(30,41,59,0.7);border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:4px 9px;font-size:1rem;cursor:pointer;backdrop-filter:blur(4px);transition:background 0.2s;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(51,65,85,0.9)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(30,41,59,0.7)'; });

    btn.addEventListener('click', () => {
        if (wrapper.classList.contains('tv-fullscreen')) {
            // CSS fallback exit
            wrapper.classList.remove('tv-fullscreen');
            btn.textContent = '⛶';
            btn.title = 'На весь екран';
            if (lwChart) lwChart.applyOptions({ width: wrapper.clientWidth, height: wrapper.clientHeight });
            return;
        }
        if (!document.fullscreenElement) {
            wrapper.requestFullscreen?.().catch(() => {
                wrapper.classList.add('tv-fullscreen');
                btn.textContent = '✕';
                btn.title = 'Закрити';
                if (lwChart) lwChart.applyOptions({ width: wrapper.clientWidth, height: wrapper.clientHeight });
            });
        } else {
            document.exitFullscreen?.();
        }
    });

    // Remove previous listener before adding a new one
    if (_fsChangeHandler) document.removeEventListener('fullscreenchange', _fsChangeHandler);
    _fsChangeHandler = () => {
        const isFs = !!document.fullscreenElement;
        const activeBtn = document.getElementById('ts-fullscreen-btn');
        if (activeBtn) {
            activeBtn.textContent = isFs ? '✕' : '⛶';
            activeBtn.title = isFs ? 'Закрити' : 'На весь екран';
        }
        if (lwChart) {
            const w = document.getElementById('tv-widget-container');
            if (w) setTimeout(() => lwChart.applyOptions({ width: w.clientWidth, height: w.clientHeight }), 50);
        }
    };
    document.addEventListener('fullscreenchange', _fsChangeHandler);

    wrapper.appendChild(btn);
}

// ─── Firestore: зберегти analysisResult в документ угоди ────────────────────
async function saveAnalysisToJournal(dateStr, tradeIndex, result) {
    try {
        // Зберігаємо в місячний документ — оновлюємо конкретну угоду
        const dayData = state.appData.journal[dateStr] || {};
        // Читаємо поточний стан дня, щоб не перезаписати інші угоди
        const trades = [...(dayData.trades || [])];
        if (!trades[tradeIndex]) return;

        // Зберігаємо тільки серіалізовані поля (без _ctx з candles)
        const { _ctx, ...safeResult } = result;
        trades[tradeIndex] = { ...trades[tradeIndex], analysisResult: safeResult };

        state.appData.journal[dateStr] = { ...dayData, trades };
        markJournalDayDirty(dateStr);
        await saveJournalData();

        // Оновлюємо локальний state
        
    } catch (e) {
        console.error('[TradeStory] Save error:', e);
    }
}

// ─── Кеш результатів аналізу: ключ = `${symbol}_${dateStr}_${tradeIndex}` ────
const _storyCache = new Map();

function _ensureStoryButton(container, trades, candles, dateStr) {
    const wrapper = document.getElementById('tv-widget-container');
    if (!wrapper) return;

    const symbol     = trades[0]?.symbol || '';
    const tradeIndex = _activeTrade?.tradeIndex ?? 0;
    const cacheKey   = `${symbol}_${dateStr}_${tradeIndex}`;

    // Якщо є збережений результат в state — завантажуємо в кеш
    const savedResult = state.appData.journal[dateStr]?.trades?.[tradeIndex]?.analysisResult;
    if (savedResult && !_storyCache.has(cacheKey)) {
        _storyCache.set(cacheKey, savedResult);
    }

    const mkBtn = (id, text, isRight = false, rightOffsetPx = 50) => {
        const b = document.createElement('button');
        b.id = id;
        b.textContent = text;
        const pos = isRight
            ? `top:8px;right:${rightOffsetPx}px;`
            : 'top:8px;left:8px;';
        b.style.cssText = `position:absolute;${pos}z-index:20;background:rgba(139,92,246,0.15);border:1px solid #7c3aed;color:#a78bfa;border-radius:6px;padding:5px 12px;font-size:0.78rem;cursor:pointer;backdrop-filter:blur(4px);transition:background 0.2s;`;
        b.addEventListener('mouseenter', () => { b.style.background = 'rgba(139,92,246,0.3)'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'rgba(139,92,246,0.15)'; });
        return b;
    };

    const _syncShowBtn = () => {
        document.getElementById('ts-show-btn')?.remove();
        // Показуємо «Показати аналіз» зліва від кнопки fullscreen (справа)
        if (!_storyPanelOpen && _storyCache.has(cacheKey)) {
            const showBtn = mkBtn('ts-show-btn', '👁 Аналіз', true, 50);
            showBtn.addEventListener('click', () => {
                _storyPanelOpen = true;
                renderStoryOverlay(_storyCache.get(cacheKey), lwChart, wrapper, dateStr);
                _syncShowBtn();
            });
            wrapper.appendChild(showBtn);
        }
    };

    // Якщо вже є збережений аналіз — одразу показуємо «Показати аналіз» замість «AI Аналіз»
    if (_storyCache.has(cacheKey)) {
        _syncShowBtn();
    } else {
        const btn = mkBtn('ts-ai-btn', '🧠 AI Аналіз', false);
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '⏳ Аналізую...';
            try {
                const result = await analyzeTradeStory(trades[0], candles, dateStr);
                _storyCache.set(cacheKey, result);
                // Зберігаємо в Firestore асинхронно (не блокуємо UI)
                saveAnalysisToJournal(dateStr, tradeIndex, result);
                _storyPanelOpen = true;
                renderStoryOverlay(result, lwChart, wrapper, dateStr);
                // Замінюємо кнопку «AI Аналіз» на «Показати аналіз»
                btn.remove();
                _syncShowBtn();
            } catch(e) {
                const is429 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('exhausted');
                if (is429) {
                    let secs = 65;
                    await new Promise(resolve => {
                        const iv = setInterval(() => {
                            secs--;
                            btn.textContent = `⏳ Rate limit ${secs}s`;
                            if (secs <= 0) { clearInterval(iv); resolve(); }
                        }, 1000);
                    });
                    btn.click();
                    return;
                }
                console.error('[TradeStory]', e.message);
                btn.textContent = `⚠ ${e.message.slice(0, 28)}`;
                await sleep(3000);
                btn.textContent = '🧠 AI Аналіз';
                btn.disabled = false;
            }
        });
        wrapper.appendChild(btn);
    }

    // Слідкуємо за закриттям панелі (X кнопка в renderSummaryPanel)
    const mo = new MutationObserver(() => {
        const open = !!wrapper.querySelector('#ts-summary-panel');
        if (_storyPanelOpen !== open) {
            _storyPanelOpen = open;
            _syncShowBtn();
        }
    });
    mo.observe(wrapper, { childList: true });
}
