// === js/trades_view2.js ===
import { state } from './state.js';
import { supabase, SUPABASE_URL } from './supabase.js';
import { buildTradeContext, analyzeTradeStory, renderStoryOverlay } from './trade_story.js';
import { sleep } from './ai.js';
import { saveJournalData, markJournalDayDirty, loadTradeDays, loadDayDetails } from './storage.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { findScreenshotsForTicker, openScreenshotForTrade } from './gallery.js';
import { ensureLightweightCharts } from './vendor_loader.js';
import { findTradeIndexByIdentity, isPureGoogleSheetTrade, visibleTradeRowsForDate } from './trade_filters.js';
import { isMarketOpenStopTrade } from './best_exit_core.js';
import { getOrLoadPolygonDay } from './polygon_intraday_cache.js';

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

function visibleTradeRows(dateStr) {
    return visibleTradeRowsForDate(state.appData?.journal || {}, dateStr);
}

let lwChart = null;
let candleSeries = null;
let lwChartsReady = null;
let _storyPanelOpen = false;
let _tradeDaysLoadPromise = null;
let _tradeDaysLoadUserId = null;
let _resizeObserver = null;
let _chartBuildToken = 0;
let _tradeDateCalendarMonth = null;
let _tradeDates = [];
let _tradeDateCalendarGlobalBound = false;
const _storyObservers = new Set();
const marketSessionLowCache = new Map();
const POLYGON_DISABLED = false;

async function loadMarketSessionLow(symbol, dateStr) {
    if (POLYGON_DISABLED) return null;
    const normalizedSymbol = String(symbol || '').toUpperCase();
    if (!/^[A-Z]{1,10}$/.test(normalizedSymbol) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
    const key = `${normalizedSymbol}|${dateStr}`;
    if (marketSessionLowCache.has(key)) return marketSessionLowCache.get(key);
    const request = (async () => {
        const offset = getNYOffset(dateStr);
        const fromMs = new Date(`${dateStr}T04:00:00${offset}`).getTime();
        const toMs = new Date(`${dateStr}T20:00:00${offset}`).getTime();
        const candles = await fetchPolygon(normalizedSymbol, fromMs, toMs, dateStr);
        const lows = candles.filter((candle) => {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(candle.time * 1000));
            const minute = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
            return minute >= 570 && minute < 720 && Number(candle.low) > 0;
        }).map((candle) => Number(candle.low));
        return lows.length ? Math.min(...lows) : null;
    })().catch(() => null);
    marketSessionLowCache.set(key, request);
    const result = await request;
    if (result == null) marketSessionLowCache.delete(key);
    return result;
}

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
    // Ховаємо кнопки доки не вибрано жодної угоди
    const wrapper = document.getElementById('tv-widget-container');
    if (wrapper) {
        wrapper.querySelector('#ts-ai-btn')?.remove();
        wrapper.querySelector('#ts-show-btn')?.remove();
        wrapper.querySelector('#ts-fullscreen-btn')?.remove();
    }
    bindTradeDateCalendar();
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
    bindTradeDateCalendar();
    const sel = document.getElementById('trades-date-select');
    if (!sel) return;

    await ensureTradeDaysLoaded();

    const dates = Object.keys(state.appData.journal)
        .filter(d => visibleTradeRows(d).length > 0)
        .sort((a, b) => b.localeCompare(a));
    _tradeDates = dates;

    sel.innerHTML = '<option value="">— Оберіть день —</option>';
    dates.forEach(d => {
        const rows = visibleTradeRows(d);
        const net = rows.reduce((s, row) => s + (Number(row.trade.net) || 0), 0);
        const sign = net >= 0 ? '+' : '';
        const opt = document.createElement('option');
        opt.value = sanitizeHTML(d);
        opt.textContent = `${d} (${sign}${net.toFixed(0)}$, ${rows.length} угод)`;
        sel.appendChild(opt);
    });

    const dateToSelect = state.selectedDateStr && visibleTradeRows(state.selectedDateStr).length > 0
        ? state.selectedDateStr
        : dates[0];
    if (dateToSelect) {
        sel.value = dateToSelect;
        setTradeDateCalendarMonth(dateToSelect);
        renderTradeDateCalendar(dateToSelect);
        renderPillNav(dateToSelect);
    } else {
        renderTradeDateCalendar('');
        renderPillNav('');
    }
}

export function populateSymbolSelect(dateStr) {
    // Sync the date <select> to match the calendar selection
    const sel = document.getElementById('trades-date-select');
    if (sel && dateStr) {
        // Add the date as an option if it has trades and isn't already present
        const hasTrades = visibleTradeRows(dateStr).length > 0;
        if (hasTrades) {
            if (!sel.querySelector(`option[value="${dateStr}"]`)) {
                void populateDateSelect();
            }
            sel.value = dateStr;
            setTradeDateCalendarMonth(dateStr);
            renderTradeDateCalendar(dateStr);
        }
    }
    if (dateStr) renderPillNav(dateStr);
}

function parseDateParts(dateStr) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
    return { year: parts[0], month: parts[1] - 1, day: parts[2] };
}

function formatDateKey(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function setTradeDateCalendarMonth(dateStr) {
    const parsed = parseDateParts(dateStr);
    if (parsed) {
        _tradeDateCalendarMonth = { year: parsed.year, month: parsed.month };
        return;
    }
    if (!_tradeDateCalendarMonth) {
        const now = new Date();
        _tradeDateCalendarMonth = { year: now.getFullYear(), month: now.getMonth() };
    }
}

function getTradeDaySummary(dateStr) {
    const rows = visibleTradeRows(dateStr);
    const net = rows.reduce((sum, row) => sum + (Number(row.trade.net) || 0), 0);
    return { count: rows.length, net };
}

function renderTradeDateCalendar(activeDate = '') {
    const grid = document.getElementById('trades-date-grid');
    const label = document.getElementById('trades-date-month');
    if (!grid || !label) return;
    updateTradeDateTrigger(activeDate);

    if (!_tradeDateCalendarMonth) setTradeDateCalendarMonth(activeDate || _tradeDates[0]);
    const { year, month } = _tradeDateCalendarMonth;
    const monthName = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));
    label.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const firstDay = new Date(year, month, 1);
    const firstWeekday = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < firstWeekday; i++) cells.push('<span class="trades-date-day is-empty"></span>');

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = formatDateKey(year, month, day);
        const summary = getTradeDaySummary(dateStr);
        const hasTrades = summary.count > 0;
        const active = dateStr === activeDate;
        const tone = hasTrades ? (summary.net >= 0 ? 'is-profit' : 'is-loss') : '';
        const classes = [
            'trades-date-day',
            hasTrades ? 'has-trades' : 'is-disabled',
            tone,
            active ? 'is-active' : '',
        ].filter(Boolean).join(' ');
        const title = hasTrades
            ? `${dateStr}: ${summary.net >= 0 ? '+' : ''}${summary.net.toFixed(0)}$, ${summary.count} угод`
            : `${dateStr}: немає угод`;
        cells.push(`<button type="button" class="${classes}" data-trades-calendar-date="${dateStr}" ${hasTrades ? '' : 'disabled'} title="${sanitizeHTML(title)}">${day}</button>`);
    }

    grid.innerHTML = cells.join('');
}

function shiftTradeDateCalendarMonth(delta) {
    if (!_tradeDateCalendarMonth) setTradeDateCalendarMonth(document.getElementById('trades-date-select')?.value || _tradeDates[0]);
    const next = new Date(_tradeDateCalendarMonth.year, _tradeDateCalendarMonth.month + delta, 1);
    _tradeDateCalendarMonth = { year: next.getFullYear(), month: next.getMonth() };
    renderTradeDateCalendar(document.getElementById('trades-date-select')?.value || '');
}

function selectTradeCalendarDate(dateStr) {
    const sel = document.getElementById('trades-date-select');
    if (sel) sel.value = dateStr;
    state.selectedDateStr = dateStr;
    setTradeDateCalendarMonth(dateStr);
    renderTradeDateCalendar(dateStr);
    setTradeDateCalendarOpen(false);
    populateSymbolSelect(dateStr);
}

function bindTradeDateCalendar() {
    if (!_tradeDateCalendarGlobalBound) {
        _tradeDateCalendarGlobalBound = true;
        document.addEventListener('click', (event) => {
            const trigger = event.target?.closest?.('#trades-date-trigger');
            if (trigger) {
                event.preventDefault();
                event.stopPropagation();
                const calendar = document.getElementById('trades-date-calendar');
                setTradeDateCalendarOpen(!!calendar?.hidden);
                return;
            }

            const prev = event.target?.closest?.('#trades-date-prev');
            if (prev) {
                event.preventDefault();
                event.stopPropagation();
                shiftTradeDateCalendarMonth(-1);
                return;
            }

            const next = event.target?.closest?.('#trades-date-next');
            if (next) {
                event.preventDefault();
                event.stopPropagation();
                shiftTradeDateCalendarMonth(1);
                return;
            }

            const dayButton = event.target?.closest?.('[data-trades-calendar-date]');
            if (dayButton) {
                event.preventDefault();
                event.stopPropagation();
                if (!dayButton.disabled) selectTradeCalendarDate(dayButton.dataset.tradesCalendarDate);
                return;
            }

            const picker = document.getElementById('trades-date-picker');
            if (picker && !picker.contains(event.target)) setTradeDateCalendarOpen(false);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') setTradeDateCalendarOpen(false);
        });
    }

    const calendar = document.getElementById('trades-date-calendar');
    if (!calendar || calendar.dataset.bound === 'true') return;
    calendar.dataset.bound = 'true';
}

function setTradeDateCalendarOpen(open) {
    const calendar = document.getElementById('trades-date-calendar');
    const trigger = document.getElementById('trades-date-trigger');
    if (!calendar || !trigger) return;
    calendar.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderTradeDateCalendar(document.getElementById('trades-date-select')?.value || '');
}

function updateTradeDateTrigger(dateStr = '') {
    const valueEl = document.getElementById('trades-date-trigger-value');
    if (!valueEl) return;
    if (!dateStr) {
        valueEl.textContent = 'Оберіть день';
        return;
    }
    const summary = getTradeDaySummary(dateStr);
    const parsed = parseDateParts(dateStr);
    const dateLabel = parsed
        ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(parsed.year, parsed.month, parsed.day))
        : dateStr;
    valueEl.textContent = summary.count
        ? `${dateLabel} · ${summary.net >= 0 ? '+' : ''}${summary.net.toFixed(0)}$`
        : dateLabel;
}

// ─── Pill Navigation ──────────────────────────────────────────────────────────

function renderPillNav(dateStr) {
    const nav = document.getElementById('trade-pill-nav');
    if (!nav) return;
    nav.innerHTML = '';

    const tradeRows = visibleTradeRows(dateStr);
    if (!tradeRows.length) {
        // No trades for this date — clear the chart and info bar
        const placeholder = document.getElementById('tv-placeholder');
        const container   = document.getElementById('tradingview-widget');
        const bar         = document.getElementById('trade-info-bar');
        const wrapper     = document.getElementById('tv-widget-container');
        if (placeholder) {
            placeholder.style.display = 'flex';
            placeholder.innerHTML = `
                <div class="app-empty-state app-empty-state--chart">
                    <div class="app-empty-state-title">Журнал угод порожній</div>
                    <div class="app-empty-state-copy">Імпортуйте угоди з таблиці або заповніть день у календарі. Після цього тут зʼявиться графік конкретної угоди.</div>
                    <div class="app-empty-state-actions">
                        <button type="button" class="btn-secondary recent-trades-link" data-tab="calendar">Календар</button>
                        <button type="button" class="btn-primary recent-trades-link" data-tab="table">Імпорт</button>
                    </div>
                </div>`;
        }
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
    const dayNet = tradeRows.reduce((s, row) => s + (Number(row.trade.net) || 0), 0);
    const dayLabel = document.createElement('span');
    dayLabel.style.cssText = 'font-size:0.75rem;color:var(--text-muted);white-space:nowrap;margin-right:4px;flex-shrink:0;';
    dayLabel.textContent = `${dateStr} · ${dayNet >= 0 ? '+' : ''}${dayNet.toFixed(0)}$`;
    nav.appendChild(dayLabel);

    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 4px;';
    nav.appendChild(sep);

    tradeRows.forEach(({ trade, index }) => {
        const isProfit = trade.net >= 0;
        const timeIn = trade.opened?.split(' ')[1] || trade.opened || '';
        const pill = document.createElement('button');
        pill.className = `trade-pill ${isProfit ? 'profit' : 'loss'}`;
        pill.dataset.idx = index;
        pill.textContent = `${trade.symbol} ${trade.type === 'Short' ? '▼' : '▲'} ${timeIn} ${isProfit ? '+' : ''}${trade.net.toFixed(0)}$`;
        pill.addEventListener('click', () => _selectTrade(dateStr, index));
        nav.appendChild(pill);
    });

    // Re-highlight existing active trade for this date, otherwise auto-select first
    if (_activeTrade?.dateStr === dateStr) {
        _highlightPill(_activeTrade.tradeIndex);
    } else {
        _selectTrade(dateStr, tradeRows[0].index);
    }
}

function _highlightPill(idx) {
    const nav = document.getElementById('trade-pill-nav');
    if (!nav) return;
    nav.querySelectorAll('.trade-pill').forEach((p) => {
        p.classList.toggle('active', Number(p.dataset.idx) === idx);
    });
}

function _selectTrade(dateStr, tradeIndex) {
    const allTrades = (state.appData.journal[dateStr] || {}).trades || [];
    if (!allTrades.length) return;

    let trade = allTrades[tradeIndex];
    if (isPureGoogleSheetTrade(trade)) {
        const firstVisible = visibleTradeRows(dateStr)[0];
        if (!firstVisible) return;
        tradeIndex = firstVisible.index;
        trade = firstVisible.trade;
    }
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

    disposeTradesView({ keepActiveTrade: true, keepContainer: true });

    renderTradeInfoBar([trade]);
    buildLWChart(trade.symbol, dateStr, [trade]);
}

export function disposeTradesView(options = {}) {
    _chartBuildToken++;
    if (_resizeObserver) {
        try { _resizeObserver.disconnect(); } catch (_) {}
        _resizeObserver = null;
    }
    for (const observer of _storyObservers) {
        try { observer.disconnect(); } catch (_) {}
    }
    _storyObservers.clear();
    if (_fsChangeHandler) {
        document.removeEventListener('fullscreenchange', _fsChangeHandler);
        _fsChangeHandler = null;
    }
    if (lwChart) {
        try { lwChart.remove(); } catch (_) {}
        lwChart = null;
        candleSeries = null;
    }
    _storyPanelOpen = false;
    if (!options.keepActiveTrade) _activeTrade = null;

    const wrapper = document.getElementById('tv-widget-container');
    if (wrapper) {
        wrapper.classList.remove('tv-fullscreen');
        wrapper.querySelectorAll('#ts-ai-btn, #ts-show-btn, #ts-fullscreen-btn, #ts-summary-panel, .ts-pin').forEach(el => el.remove());
    }

    if (!options.keepContainer) {
        const container = document.getElementById('tradingview-widget');
        if (container) {
            container.innerHTML = '';
            container.style.display = 'none';
        }
        const bar = document.getElementById('trade-info-bar');
        if (bar) {
            bar.innerHTML = '';
            bar.style.display = 'none';
        }
        const placeholder = document.getElementById('tv-placeholder');
        if (placeholder) placeholder.style.display = 'flex';
    }
}

export function loadTradeChart(symbol, dateStr) {
    if (!dateStr) dateStr = document.getElementById('trades-date-select')?.value;
    if (!dateStr || !symbol) return;

    const rows = visibleTradeRows(dateStr);
    const match = rows.find(row => row.trade.symbol === symbol);
    const idx = match?.index ?? -1;
    if (idx === -1) return;

    _selectTrade(dateStr, idx);
}

/** Відкрити вкладку «Угоди» і конкретну угоду дня (після імпорту Fondexx). */
export async function openTradesAtDayIndex(dateStr, tradeIndex, identity = null) {
    if (!dateStr) return;
    if (window.switchMainTab) await window.switchMainTab('trades');
    await populateDateSelect();
    const currentRows = visibleTradeRows(dateStr);
    if (!currentRows.length) return;
    const identityIdx = identity ? findTradeIndexByIdentity(state.appData.journal?.[dateStr]?.trades || [], identity) : -1;
    const rawIdx = identityIdx >= 0 ? identityIdx : (parseInt(tradeIndex, 10) || 0);
    const idx = currentRows.some(row => row.index === rawIdx) ? rawIdx : currentRows[Math.max(0, Math.min(rawIdx, currentRows.length - 1))].index;
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
    const polygonCriteria = trade?.marketCriteria
        || state.appData.journal?.[_activeTrade?.dateStr || '']?.tradePolygons?.[String(trade?.symbol || '').toUpperCase()]
        || null;
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
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const sheetException = Array.isArray(sheet.exceptions) ? sheet.exceptions.join(', ') : (sheet.exception || '');
    const sheetComment = sheet.traderComment || '';
    const stopPrice = trade?.stop ?? sheet.stopPrice;
    if (stopPrice != null && stopPrice !== '') items.push({ label: 'Стоп', value: String(stopPrice), color: 'var(--gold)' });
    if (sheet.exit) items.push({ label: 'Вихід', value: String(sheet.exit), color: 'var(--text-main)' });
    if (sheetException) items.push({ label: 'Виключення', value: sheetException, color: 'var(--loss)' });
    if (polygonCriteria) {
        const compact = (value) => {
            if (value === null || value === undefined || value === '') return '—';
            const number = Number(value);
            if (!Number.isFinite(number)) return '—';
            if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
            if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
            if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
            return String(Math.round(number));
        };
        const openedMatch = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(String(trade?.opened || trade?.entryTime || trade?.time || ''));
        const openedMinute = openedMatch ? Number(openedMatch[1]) * 60 + Number(openedMatch[2]) : null;
        const volPre = openedMinute == null ? null : polygonCriteria.vol_pre_by_minute?.[String(openedMinute)];
        items.push(
            { label: 'ATR 14 · до входу', value: Number(polygonCriteria.atr).toFixed(2), color: 'var(--accent)' },
            { label: 'Avg Vol 14 · до входу', value: compact(polygonCriteria.avg_vol), color: 'var(--text-main)' },
            { label: 'Vol · попер. день', value: compact(polygonCriteria.vol), color: 'var(--text-main)' },
            { label: 'VolPlay · попер. день', value: `${Number(polygonCriteria.vol_play).toFixed(2)}x`, color: 'var(--gold)' },
            { label: 'Float', value: polygonCriteria.shs_float_display || polygonCriteria.shs_float_raw || compact(polygonCriteria.shs_float), color: 'var(--text-main)' },
            ...(Number.isFinite(Number(volPre)) ? [{ label: 'VolPre · на момент входу', value: compact(volPre), color: 'var(--accent)' }] : []),
            ...(polygonCriteria.as_of_date ? [{ label: 'Дані станом на', value: polygonCriteria.as_of_date, color: 'var(--text-muted)' }] : []),
        );
    }
    if (trade?.symbol && _activeTrade?.dateStr) {
        items.push({
            label: 'Критерії паперу',
            value: polygonCriteria ? 'Оновити' : 'Завантажити',
            color: 'var(--accent)',
            action: 'load-market-criteria',
        });
    }

    if (trades.some((item) => isMarketOpenStopTrade(item, _activeTrade?.dateStr || ''))) {
        items.push({ label: 'Група', value: 'Стопи на маркеті', color: 'var(--loss)' });
    }

    bar.innerHTML = '';
    bar.style.display = 'flex';
    bar.style.cssText = 'display:flex;flex-shrink:0;gap:8px;padding:8px 15px;background:var(--bg-panel);border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;';

    items.forEach(({ label, value, color, big, action }) => {
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
        if (action === 'load-market-criteria') {
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.title = 'Отримати ATR, об’єми та Float для цього тікера і дня';
            card.style.cursor = 'pointer';
            card.style.borderColor = 'color-mix(in srgb, var(--accent) 45%, var(--border))';
            const activate = async () => {
                if (card.getAttribute('aria-busy') === 'true') return;
                card.setAttribute('aria-busy', 'true');
                const original = val.textContent;
                val.textContent = 'Завантаження…';
                try {
                    const { data: { session } = {} } = await supabase.auth.getSession();
                    if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
                    const response = await fetch('/api/trade-polygons', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${session.access_token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            ticker: trade.symbol,
                            date: _activeTrade.dateStr,
                            volPreByMinute: polygonCriteria?.vol_pre_by_minute || {},
                        }),
                    });
                    const result = await response.json().catch(() => ({}));
                    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

                    const dateStr = _activeTrade.dateStr;
                    const tradeIndex = _activeTrade.tradeIndex;
                    const day = await loadDayDetails(dateStr, state.myUserId, { force: true });
                    const refreshedTrade = day?.trades?.[tradeIndex];
                    if (refreshedTrade) renderTradeInfoBar([refreshedTrade]);
                } catch (error) {
                    console.error('[Trade criteria]', error);
                    val.textContent = 'Повторити';
                    card.title = error?.message || String(error);
                } finally {
                    card.removeAttribute('aria-busy');
                    if (val.textContent === 'Завантаження…') val.textContent = original;
                }
            };
            card.addEventListener('click', activate);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                }
            });
        }
        bar.appendChild(card);
    });

    if (sheetComment) {
        const note = document.createElement('div');
        note.style.cssText = 'flex:1 1 260px;min-width:220px;padding:7px 12px;background:var(--bg-main);border:1px solid var(--border);border-radius:8px;color:var(--text-main);font-size:0.82rem;line-height:1.35;';
        note.textContent = sheetComment;
        note.title = sheetComment;
        bar.appendChild(note);
    }

    if (trade) {
        const marketLow = document.createElement('div');
        marketLow.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:5px 12px;background:var(--bg-main);border:1px solid var(--border);border-radius:8px;min-width:112px;gap:2px;';
        const marketLowValue = document.createElement('span');
        marketLowValue.style.cssText = 'font-size:.85rem;font-weight:700;color:var(--text-main);line-height:1.2;';
        marketLowValue.textContent = '…';
        const marketLowLabel = document.createElement('span');
        marketLowLabel.style.cssText = 'font-size:.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;';
        marketLowLabel.textContent = 'Low 09:30–12:00';
        marketLow.append(marketLowValue, marketLowLabel);
        bar.appendChild(marketLow);
        const lowSymbol = String(trade.symbol || '').toUpperCase();
        const lowDate = _activeTrade?.dateStr || '';
        void loadMarketSessionLow(lowSymbol, lowDate).then((low) => {
            if (!marketLowValue.isConnected) return;
            marketLowValue.textContent = low == null ? 'Немає даних' : `$${low.toFixed(2)}`;
            marketLow.title = low == null ? 'Ринкові дані за цей день недоступні' : `Мінімальна ціна ${lowSymbol} від 09:30 до 12:00 NY`;
        });
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
    const buildToken = ++_chartBuildToken;
    const placeholder = document.getElementById('tv-placeholder');
    const container   = document.getElementById('tradingview-widget');
    if (!container) return;

    if (placeholder) placeholder.style.display = 'none';
    container.style.display = 'block';
    container.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">⏳ Завантаження даних...</div>';

    const old = document.getElementById('trade-overlay-list');
    if (old) old.remove();

    await ensureLightweightCharts();
    if (buildToken !== _chartBuildToken || !document.getElementById('view-trades')?.classList.contains('active')) return;

    let candles = [];
    try {
        candles = await fetchYahooCandles(symbol, dateStr);
    } catch(e) {
        if (buildToken !== _chartBuildToken || !document.getElementById('view-trades')?.classList.contains('active')) return;
        container.textContent = '';
        const errDiv = document.createElement('div');
        const isPlanLimit = e?.code === 'POLYGON_PLAN_TIMEFRAME' || /plan doesn't include this data timeframe|тариф Polygon/i.test(String(e?.message || ''));
        errDiv.style.cssText = `color:${isPlanLimit ? 'var(--text-muted)' : 'var(--loss)'};padding:20px;text-align:center;line-height:1.45;`;
        errDiv.textContent = isPlanLimit
            ? `Свічки для ${symbol} за ${dateStr} недоступні на поточному тарифі Polygon. Журнал і дані угоди працюють, але для графіка потрібен Polygon-план з хвилинними historical aggregates за цей період.`
            : `❌ Не вдалось завантажити дані: ${e.message}`;
        container.appendChild(errDiv);
        return;
    }
    if (buildToken !== _chartBuildToken || !document.getElementById('view-trades')?.classList.contains('active')) return;

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
    if (_resizeObserver) {
        try { _resizeObserver.disconnect(); } catch (_) {}
    }
    _resizeObserver = new ResizeObserver(() => {
        if (lwChart) lwChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    _resizeObserver.observe(container);

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

async function fetchPolygon(symbol, fromMs, toMs, cacheDate = '') {
    if (POLYGON_DISABLED) throw new Error('Polygon тимчасово вимкнено адміністратором.');
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
        throw new Error(
            'Polygon: увійдіть у акаунт. Свічки завантажуються через Edge (секрет POLYGON_API_KEY у Supabase). Див. supabase/SECRETS-SETUP.txt',
        );
    }
    const edgeUrl = `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/polygon-aggs`;
    const load = async () => {
        const res = await fetch(edgeUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ symbol, fromMs, toMs }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const message = data?.message || '';
            if (res.status === 403 && (data?.code === 'POLYGON_PLAN_TIMEFRAME' || /plan doesn't include this data timeframe/i.test(message))) {
                const error = new Error('Поточний тариф Polygon не включає хвилинні дані за цей період.'); error.code = 'POLYGON_PLAN_TIMEFRAME'; throw error;
            }
            if (res.status === 429) throw new Error('Polygon: перевищено ліміт запитів для цього ключа. Спробуйте ще раз трохи пізніше.');
            throw new Error(message || `Polygon: помилка сервера ${res.status}. Перевірте POLYGON_API_KEY і деплой polygon-aggs.`);
        }
        return Array.isArray(data?.results) ? data.results : [];
    };
    const raw = cacheDate ? (await getOrLoadPolygonDay(symbol, cacheDate, load)).bars : await load();
    return mapPolygonResults({ results: raw });
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

    // Повний день кешуємо один раз; для графіка нижче залишаємо лише постмаркет.
    const prevFrom = Math.floor(new Date(`${prevDay}T04:00:00${prevOff}`).getTime() / 1000) * 1000;
    const prevTo   = Math.floor(new Date(`${prevDay}T23:59:00${prevOff}`).getTime() / 1000) * 1000;
    // Поточний день: 04:00–23:59
    const curFrom  = Math.floor(new Date(`${dateStr}T04:00:00${offset}`).getTime() / 1000) * 1000;
    const curTo    = Math.floor(new Date(`${dateStr}T23:59:00${offset}`).getTime() / 1000) * 1000;

    const curCandles = await fetchPolygon(symbol, curFrom, curTo, dateStr);
    if (!curCandles.length) throw new Error('Немає даних від Polygon');

    let prevCandles = [];
    try {
        const fullPrevDay = await fetchPolygon(symbol, prevFrom, prevTo, prevDay);
        const postmarketStart = Math.floor(new Date(`${prevDay}T16:00:00${prevOff}`).getTime() / 1000);
        prevCandles = fullPrevDay.filter((candle) => candle.time >= postmarketStart);
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
    _storyObservers.add(mo);
}
