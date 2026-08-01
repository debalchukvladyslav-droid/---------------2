import { state } from './state.js';
import { saveSettings } from './storage.js';
import { getEffectiveDayPnl, visibleTradeRows } from './trade_filters.js';
import { deriveDayKfFromTrades } from './data_utils.js';
import { supabase } from './supabase.js';
import { buildExceptionKfRows, buildHourlyKfBuckets, combineStatsSheetRows } from './stats_sheet_metrics.js';
import { escapeHtml } from './utils.js';

const VERSION = 6;
const GRID_COLUMNS = 24;
const CATEGORIES = { overview: 'Огляд', analytics: 'Аналітика', routine: 'Сесія', tools: 'Інструменти' };
const MICRO_WIDGETS = new Set(['month-pnl', 'month-winrate', 'month-trades', 'month-pf', 'today', 'daily-kf', 'week-compare', 'streak', 'current-hour', 'last-session', 'sync-status', 'missing-data']);
const COMPLEX_WIDGETS = new Set(['equity', 'ai-mentor', 'recent-trades', 'market-mood', 'checklist', 'criteria-best', 'criteria-warning', 'quick-actions']);
const COMPLEX_LIMITS = {
    equity: [5, 3], 'ai-mentor': [4, 3], 'recent-trades': [4, 3], 'market-mood': [3, 2],
    checklist: [3, 2], 'criteria-best': [3, 2], 'criteria-warning': [3, 2], 'quick-actions': [3, 2],
};
const WIDGETS = [
    ['month-pnl', 'P&L за місяць', 'overview', 2, 1], ['month-winrate', 'Вінрейт', 'overview', 2, 1],
    ['month-trades', 'Угоди за місяць', 'overview', 2, 1], ['month-pf', 'Profit Factor', 'overview', 2, 1],
    ['today', 'Стан сьогодні', 'overview', 4, 2], ['daily-kf', 'КФ сьогодні', 'overview', 3, 2],
    ['equity', 'Крива P&L', 'analytics', 8, 4], ['week-compare', 'Тиждень проти тижня', 'analytics', 4, 2],
    ['streak', 'Поточна серія', 'analytics', 3, 2], ['criteria-best', 'Найкращий і найгірший критерій', 'analytics', 4, 2],
    ['criteria-warning', 'Ризикові критерії', 'analytics', 4, 2], ['current-hour', 'Поточна година входу', 'analytics', 4, 2],
    ['last-session', 'Остання сесія', 'routine', 5, 2], ['checklist', 'Передсесійний чекліст', 'routine', 4, 2],
    ['daily-focus', 'Фокус дня', 'routine', 4, 2], ['ai-mentor', 'AI-наставник', 'routine', 4, 4],
    ['recent-trades', 'Останні угоди', 'analytics', 4, 4], ['market-mood', 'Настрій ринку', 'overview', 4, 2],
    ['sync-status', 'Синхронізація', 'tools', 4, 2], ['missing-data', 'Незаповнені дані', 'tools', 4, 2],
    ['earnings', 'Майбутні звіти тикерів', 'tools', 4, 2], ['quick-actions', 'Швидкі дії', 'tools', 4, 2],
    ['news', 'Стрічка новин', 'tools', 12, 1],
].map(([id, title, category, w, h]) => ({ id, title, category, w: w * 2, h, minW: COMPLEX_LIMITS[id]?.[0] ? COMPLEX_LIMITS[id][0] * 2 : (MICRO_WIDGETS.has(id) ? 3 : Math.min(w * 2, 6)), maxW: GRID_COLUMNS, minH: COMPLEX_LIMITS[id]?.[1] || (MICRO_WIDGETS.has(id) || id === 'news' ? 1 : 2), maxH: 6 }));

const DEFAULT_IDS = ['news', 'month-pnl', 'month-winrate', 'month-trades', 'month-pf', 'market-mood', 'equity', 'recent-trades'];
let editing = false;
let initialized = false;
let saveTimer = 0;
let layout = [];
let drag = null;
const sourceNodes = new Map();
let densityObserver = null;
let gridStack = null;
let responsiveTimer = 0;

const byId = (id) => document.getElementById(id);
const ownProfile = () => state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
const def = (id) => WIDGETS.find((item) => item.id === id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const money = (value) => `${Number(value) >= 0 ? '+' : '−'}$${Math.abs(Number(value) || 0).toFixed(2)}`;
const kfText = (value) => `${Number(value) >= 0 ? '+' : ''}${(Number(value) || 0).toFixed(2)} КФ`;
const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function defaultLayout() {
    let x = 0; let y = 0; let rowHeight = 1;
    return DEFAULT_IDS.map((id, index) => {
        const meta = def(id);
        if (x + meta.w > GRID_COLUMNS) { x = 0; y += rowHeight; rowHeight = 1; }
        const item = { id, type: id, order: index, w: meta.w, h: meta.h, x, y, config: {} };
        x += meta.w; rowHeight = Math.max(rowHeight, meta.h);
        if (x === GRID_COLUMNS) { x = 0; y += rowHeight; rowHeight = 1; }
        return item;
    });
}

function normalizeLayout(raw) {
    const items = raw?.version === VERSION && Array.isArray(raw.widgets) ? raw.widgets : defaultLayout();
    const seen = new Set();
    const normalized = items.filter((item) => {
        const meta = def(item?.type || item?.id);
        if (!meta || seen.has(meta.id)) return false;
        seen.add(meta.id);
        return true;
    }).map((item, order) => {
        const meta = def(item.type || item.id);
        const w = clamp(Number(item.w) || meta.w, meta.minW, meta.maxW);
        return { id: meta.id, type: meta.id, order, w, h: clamp(Number(item.h) || meta.h, meta.minH, meta.maxH), x: clamp(Number(item.x) || 0, 0, GRID_COLUMNS - w), y: clamp(Number(item.y) || 0, 0, 80), config: item.config || {} };
    });
    // Reject overlapping/corrupt persisted layouts instead of letting the grid
    // push panels into large empty rows on every subsequent save.
    const overlaps = normalized.some((item, index) => normalized.slice(index + 1).some((other) => !(
        item.x + item.w <= other.x || other.x + other.w <= item.x ||
        item.y + item.h <= other.y || other.y + other.h <= item.y
    )));
    return overlaps ? defaultLayout() : normalized;
}

function persist() {
    if (!ownProfile()) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        if (gridStack) {
            const saved = gridStack.save(false, false, undefined, GRID_COLUMNS) || [];
            layout = saved.map((item, order) => ({ id: item.id, type: item.id, order, x: item.x || 0, y: item.y || 0, w: item.w || def(item.id)?.w || 1, h: item.h || def(item.id)?.h || 1, minW: def(item.id)?.minW, minH: def(item.id)?.minH, maxW: def(item.id)?.maxW, maxH: def(item.id)?.maxH, config: layout.find((old) => old.id === item.id)?.config || {} }));
        }
        state.appData.settings.dashboardLayout = { version: VERSION, updatedAt: new Date().toISOString(), widgets: layout };
        void saveSettings();
    }, 450);
}

function allDays() {
    return Object.entries(state.appData?.journal || {}).filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && day).sort((a, b) => a[0].localeCompare(b[0]));
}

function dayStats(date) {
    const day = state.appData?.journal?.[date];
    if (!day) return null;
    const trades = visibleTradeRows(day.trades).map((row) => row.trade);
    const pnl = getEffectiveDayPnl(day);
    const kf = Number.isFinite(Number(day.kf)) ? Number(day.kf) : deriveDayKfFromTrades(trades);
    return { day, trades, pnl: Number.isFinite(pnl) ? pnl : null, kf: Number.isFinite(kf) ? kf : null };
}

function metricMarkup(title, value, subtitle = '', tone = '') {
    return `<div class="dashboard-generated-head"><span>${escapeHtml(title)}</span></div><div class="dashboard-generated-value ${tone}">${escapeHtml(value)}</div>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}`;
}

function renderGenerated(id, host) {
    const today = dayStats(dateKey());
    const days = allDays();
    const latest = [...days].reverse().find(([date]) => dayStats(date)?.pnl !== null);
    const latestStats = latest ? dayStats(latest[0]) : null;
    if (id === 'today') {
        const limit = Math.abs(Number(state.appData?.settings?.monthlyDayloss?.[dateKey().slice(0, 7)] ?? state.appData?.settings?.defaultDayloss) || 0);
        host.innerHTML = metricMarkup('Стан сьогодні', today?.pnl == null ? 'Ще немає запису' : money(today.pnl), today ? `${today.trades.length} угод · ${today.kf == null ? 'КФ не записано' : kfText(today.kf)} · ліміт $${limit.toFixed(0)}` : 'Запишіть результат після сесії', today?.pnl < 0 ? 'is-loss' : 'is-profit');
    } else if (id === 'daily-kf') {
        host.innerHTML = metricMarkup('КФ сьогодні', today?.kf == null ? 'Немає даних' : kfText(today.kf), today?.kf == null ? 'Додайте КФ до угод або підсумку дня' : 'Результат у ризиках', today?.kf < 0 ? 'is-loss' : 'is-profit');
    } else if (id === 'streak') {
        let streak = 0; let direction = 0;
        [...days].reverse().some(([date]) => { const pnl = dayStats(date)?.pnl; if (!pnl) return false; const sign = Math.sign(pnl); if (!direction) direction = sign; if (sign !== direction) return true; streak++; return false; });
        host.innerHTML = metricMarkup('Поточна серія', streak ? `${streak} ${streak === 1 ? 'день' : 'дні'}` : 'Немає серії', streak ? (direction > 0 ? 'Прибуткові сесії поспіль' : 'Збиткові сесії поспіль') : 'Потрібно щонайменше два результати', direction < 0 ? 'is-loss' : 'is-profit');
    } else if (id === 'week-compare') {
        const now = new Date(); const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
        const sum = (from, to) => days.reduce((total, [date]) => { const d = new Date(`${date}T12:00:00`); const pnl = dayStats(date)?.pnl; return d >= from && d < to && pnl != null ? total + pnl : total; }, 0);
        const previous = new Date(monday); previous.setDate(previous.getDate() - 7); const next = new Date(monday); next.setDate(next.getDate() + 7);
        const currentValue = sum(monday, next); const previousValue = sum(previous, monday);
        host.innerHTML = metricMarkup('Цей тиждень', money(currentValue), `Попередній: ${money(previousValue)} · різниця ${money(currentValue - previousValue)}`, currentValue < 0 ? 'is-loss' : 'is-profit');
    } else if (id === 'last-session') {
        const count = latestStats ? Object.values(latestStats.day.screenshots || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) : 0;
        host.innerHTML = metricMarkup('Остання завершена сесія', latest ? money(latestStats.pnl) : 'Немає сесій', latest ? `${latest[0]} · ${latestStats.kf == null ? 'без КФ' : kfText(latestStats.kf)} · ${count} скрінів` : 'Завершіть першу сесію', latestStats?.pnl < 0 ? 'is-loss' : 'is-profit');
    } else if (id === 'checklist') {
        const items = Array.isArray(state.appData?.settings?.checklist) ? state.appData.settings.checklist : [];
        host.innerHTML = `<div class="dashboard-generated-head"><span>Передсесійний чекліст</span></div>${items.length ? `<ul class="dashboard-mini-list">${items.slice(0, 5).map((item) => `<li>○ ${escapeHtml(item)}</li>`).join('')}</ul>` : '<div class="dashboard-empty">Додайте пункти чекліста в налаштуваннях</div>'}`;
    } else if (id === 'daily-focus') {
        const text = latestStats?.day?.nextSessionImprovement || latestStats?.day?.notes || '';
        host.innerHTML = metricMarkup('Фокус дня', text ? String(text).slice(0, 110) : 'Визначте одну дію', text ? 'З останньої сесії' : 'Запишіть покращення під час завершення сесії');
    } else if (id === 'sync-status') {
        const sheet = Object.keys(state.appData?.sheetRows || {}).length > 0; const screens = allDays().some(([, day]) => Object.values(day.screenshots || {}).some((list) => Array.isArray(list) && list.length));
        host.innerHTML = `<div class="dashboard-generated-head"><span>Синхронізація</span></div><div class="dashboard-status-row"><span>${sheet ? '✓' : '○'} Таблиця</span><span>${screens ? '✓' : '○'} Скріншоти</span></div><p>${sheet || screens ? 'Дані доступні у профілі' : 'Підключіть джерела в налаштуваннях'}</p>`;
    } else if (id === 'missing-data') {
        const missing = days.filter(([date]) => { const s = dayStats(date); return s?.trades.length && (s.pnl == null || s.kf == null); }).slice(-30);
        host.innerHTML = metricMarkup('Незаповнені дані', missing.length ? `${missing.length} днів` : 'Усе заповнено', missing.length ? 'Є угоди без P&L або КФ за останні 30 записів' : 'P&L і КФ присутні для торгових днів', missing.length ? 'is-warn' : 'is-profit');
    } else if (id === 'quick-actions') {
        host.innerHTML = '<div class="dashboard-generated-head"><span>Швидкі дії</span></div><div class="dashboard-quick-actions"><button data-tab="calendar">Завершити сесію</button><button data-dashboard-action="sync">Синхронізувати</button><button data-tab="trades">Угоди</button><button data-tab="stats">Аналітика</button></div>';
    } else if (id === 'earnings') {
        host.innerHTML = metricMarkup('Майбутні звіти тикерів', 'Немає підключених звітів', 'Панель заповниться, коли для тикерів буде доступне джерело earnings');
    } else if (id === 'current-hour') {
        const hour = new Date().getHours();
        const sheetRows = combineStatsSheetRows(state.appData?.sheetRows, state.appData?.cumulativeSheetRows);
        const bucket = buildHourlyKfBuckets([], null, { sheetRows }).find((row) => row.hour === hour);
        host.innerHTML = metricMarkup(`Входи о ${String(hour).padStart(2, '0')}:00`, bucket?.trades ? kfText(bucket.kf) : 'Немає вибірки', bucket?.trades ? `${bucket.trades} угод · ${money(bucket.pnl)}` : 'У таблицях ще немає входів у цю годину', bucket?.kf < 0 ? 'is-loss' : 'is-profit');
    } else if (id === 'criteria-best' || id === 'criteria-warning') {
        const sheetRows = combineStatsSheetRows(state.appData?.sheetRows, state.appData?.cumulativeSheetRows);
        const rows = buildExceptionKfRows([], null, { sheetRows });
        const best = rows[0]; const worst = rows.length ? rows[rows.length - 1] : null;
        if (id === 'criteria-best') host.innerHTML = metricMarkup('Найкращий критерій', best ? `${best.criterion} · ${kfText(best.kf)}` : 'Немає вибірки', worst && worst !== best ? `Найгірший: ${worst.criterion} · ${kfText(worst.kf)}` : 'Дані беруться з основної й накопичувальної таблиць', best?.kf < 0 ? 'is-loss' : 'is-profit');
        else host.innerHTML = metricMarkup('Ризикові критерії', worst?.kf < 0 ? `${worst.criterion} · ${kfText(worst.kf)}` : 'Немає збиткового сигналу', worst?.kf < 0 ? `${worst.trades} угод — варто переглянути` : 'У записаних критеріях немає від’ємного КФ', worst?.kf < 0 ? 'is-loss' : 'is-profit');
    }
}

function sourceFor(id) { return sourceNodes.get(id) || document.querySelector(`[data-dashboard-widget="${id}"]`); }

function controls(item) {
    const bar = document.createElement('div'); bar.className = 'dashboard-widget-controls';
    bar.innerHTML = `<button type="button" class="dashboard-widget-drag" aria-label="Перетягнути ${def(item.id).title}">⠿</button><div class="dashboard-size-controls"><button type="button" data-size="down" aria-label="Зменшити">−</button><button type="button" data-size="up" aria-label="Збільшити">＋</button></div><button type="button" data-remove aria-label="Прибрати ${def(item.id).title}">×</button>`;
    return bar;
}

function makeWidget(item) {
    const article = document.createElement('article'); article.className = 'grid-stack-item dashboard-widget'; article.dataset.widgetId = item.id;
    article.setAttribute('gs-id', item.id); article.setAttribute('gs-x', item.x); article.setAttribute('gs-y', item.y); article.setAttribute('gs-w', item.w); article.setAttribute('gs-h', item.h);
    article.setAttribute('gs-min-w', def(item.id).minW); article.setAttribute('gs-min-h', def(item.id).minH); article.setAttribute('gs-max-w', def(item.id).maxW); article.setAttribute('gs-max-h', def(item.id).maxH);
    article.dataset.mobileSize = item.w <= 6 ? 'small' : item.w >= GRID_COLUMNS ? 'full' : 'medium';
    article.dataset.widgetH = String(item.h);
    article.classList.toggle('is-micro-widget', MICRO_WIDGETS.has(item.id));
    // Apply geometry before GridStack boots so widgets never flash in one pile.
    article.style.setProperty('--widget-w', item.w); article.style.setProperty('--widget-h', item.h);
    article.style.setProperty('--gs-x', item.x); article.style.setProperty('--gs-y', item.y);
    article.style.setProperty('--gs-w', item.w); article.style.setProperty('--gs-h', item.h);
    article.appendChild(controls(item));
    const content = document.createElement('div'); content.className = 'grid-stack-item-content dashboard-widget-content';
    const source = sourceFor(item.id);
    if (source) { source.hidden = false; content.appendChild(source); } else renderGenerated(item.id, content);
    article.appendChild(content); return article;
}

function renderGrid() {
    const grid = byId('dashboard-widget-grid'); if (!grid) return;
    const parking = byId('dashboard-widget-sources');
    gridStack?.destroy(false); gridStack = null;
    sourceNodes.forEach((node) => { if (node.isConnected && node.closest('.dashboard-widget')) parking?.appendChild(node); });
    const fragment = document.createDocumentFragment(); layout.forEach((item) => fragment.appendChild(makeWidget(item)));
    grid.replaceChildren(fragment); grid.classList.add('grid-stack'); grid.classList.toggle('is-editing', editing);
    if (!window.GridStack) throw new Error('GridStack is not loaded');
    gridStack = window.GridStack.init({ column: GRID_COLUMNS, cellHeight: 58, margin: 7, animate: true, float: false, handle: '.dashboard-widget-drag', disableDrag: !editing, disableResize: !editing, alwaysShowResizeHandle: false }, grid);
    gridStack.on('change added removed', () => { syncLayoutFromGrid(); renderCatalog(byId('dashboard-widget-search')?.value || ''); persist(); window.setTimeout(() => window.dispatchEvent(new Event('resize')), 40); });
    observeWidgetDensity();
    applyResponsiveGrid();
    renderCatalog(); window.setTimeout(() => window.dispatchEvent(new Event('resize')), 20);
}

function applyResponsiveGrid() {
    if (!gridStack) return;
    const mobile = window.innerWidth <= 700;
    const columns = mobile ? 12 : GRID_COLUMNS;
    if (gridStack.getColumn() !== columns) gridStack.column(columns, 'moveScale');
    gridStack.cellHeight(mobile ? 54 : 58);
}

function syncLayoutFromGrid() {
    if (!gridStack) return;
    const saved = gridStack.save(false, false, undefined, GRID_COLUMNS) || [];
    layout = saved.map((item, order) => ({ id: item.id, type: item.id, order, x: item.x || 0, y: item.y || 0, w: item.w || 1, h: item.h || 1, minW: def(item.id)?.minW, minH: def(item.id)?.minH, maxW: def(item.id)?.maxW, maxH: def(item.id)?.maxH, config: layout.find((old) => old.id === item.id)?.config || {} }));
}

function observeWidgetDensity() {
    if (typeof ResizeObserver === 'undefined') return;
    densityObserver?.disconnect();
    densityObserver = new ResizeObserver((entries) => entries.forEach(({ target, contentRect }) => {
        const complex = COMPLEX_WIDGETS.has(target.dataset.widgetId);
        const density = contentRect.height <= 82 || (!complex && contentRect.width <= 190)
            ? 'micro'
            : contentRect.height <= 170 || contentRect.width <= 320 ? 'compact' : 'normal';
        target.dataset.density = density;
    }));
    document.querySelectorAll('#dashboard-widget-grid .dashboard-widget').forEach((node) => densityObserver.observe(node));
}

function renderCatalog(query = '') {
    const list = byId('dashboard-widget-list'); if (!list) return;
    const added = new Set(layout.map((item) => item.id)); const needle = query.trim().toLocaleLowerCase('uk');
    list.replaceChildren();
    Object.entries(CATEGORIES).forEach(([category, label]) => {
        const matches = WIDGETS.filter((item) => item.category === category && (!needle || item.title.toLocaleLowerCase('uk').includes(needle)));
        if (!matches.length) return;
        const section = document.createElement('section'); section.innerHTML = `<h3>${label}</h3>`;
        matches.forEach((item) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'dashboard-catalog-card'; button.dataset.addWidget = item.id; button.disabled = added.has(item.id);
            button.innerHTML = `<span class="dashboard-catalog-preview"><i></i><b>${item.title}</b><small>${item.w >= 7 ? '▁▂▅▃▆' : '●  24.6'}</small></span><span>${added.has(item.id) ? '✓ Додано' : '+ Додати'}</span>`;
            section.appendChild(button);
        }); list.appendChild(section);
    });
}

function setEditing(value) {
    editing = Boolean(value) && ownProfile();
    byId('dashboard-builder')?.classList.toggle('is-editing', editing);
    byId('dashboard-widget-grid')?.classList.toggle('is-editing', editing);
    const catalog = byId('dashboard-widget-catalog'); if (catalog) { catalog.setAttribute('aria-hidden', String(!editing)); }
    const toggle = byId('dashboard-edit-toggle'); if (toggle) { toggle.textContent = editing ? 'Готово' : 'Редагувати'; toggle.setAttribute('aria-pressed', String(editing)); }
    if (byId('dashboard-reset-layout')) byId('dashboard-reset-layout').hidden = !editing;
    gridStack?.enableMove(editing);
    gridStack?.enableResize(editing);
    if (!editing) persist();
}

function moveItemLive(fromId, toId) {
    const from = layout.findIndex((item) => item.id === fromId); const to = layout.findIndex((item) => item.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const grid = byId('dashboard-widget-grid');
    const moving = grid?.querySelector(`[data-widget-id="${fromId}"]`);
    const target = grid?.querySelector(`[data-widget-id="${toId}"]`);
    if (!grid || !moving || !target) return;
    const positions = new Map([...grid.children].map((node) => [node, node.getBoundingClientRect()]));
    const [item] = layout.splice(from, 1); layout.splice(to, 0, item);
    if (from < to) target.after(moving); else target.before(moving);
    [...grid.children].forEach((node) => {
        if (node === moving) return;
        const before = positions.get(node); const after = node.getBoundingClientRect();
        const dx = before.left - after.left; const dy = before.top - after.top;
        if (dx || dy) node.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }], { duration: 210, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
}

function changeSize(id, direction) {
    syncLayoutFromGrid();
    const item = layout.find((entry) => entry.id === id); const meta = def(id); const element = document.querySelector(`[data-widget-id="${id}"]`); if (!item || !meta || !element || !gridStack) return;
    if (window.matchMedia('(max-width: 700px)').matches) {
        const presets = [6, 12, GRID_COLUMNS]; const current = presets.reduce((best, value) => Math.abs(value - item.w) < Math.abs(best - item.w) ? value : best, 12); const index = presets.indexOf(current);
        if (direction === 'down' && index === 0) item.h = meta.minH;
        else if (direction === 'up' && item.h < meta.h) item.h++;
        else item.w = presets[clamp(index + (direction === 'up' ? 1 : -1), 0, presets.length - 1)];
    } else if (direction === 'down') {
        if (item.w > meta.minW) item.w--;
        else if (item.h > meta.minH) item.h--;
    } else {
        if (item.h < meta.h) growHeightAndShrinkNeighbour(item, 1);
        else growWidthAndShrinkNeighbour(item, 1);
    }
    gridStack.update(element, { w: item.w, h: item.h });
    persist();
}

function compactLastRowFor(newWidget) {
    let row = [];
    let used = 0;
    layout.forEach((item) => {
        if (used + item.w > GRID_COLUMNS) { row = []; used = 0; }
        row.push(item); used += item.w;
        if (used === GRID_COLUMNS) { row = []; used = 0; }
    });
    while (used + newWidget.w > GRID_COLUMNS) {
        const candidate = [...row].sort((a, b) => (b.w - def(b.id).minW) - (a.w - def(a.id).minW))[0];
        if (!candidate || candidate.w <= def(candidate.id).minW) break;
        candidate.w--;
        used--;
    }
}

function rowContaining(item) {
    const rows = []; let row = []; let used = 0;
    for (const current of layout) {
        if (used + current.w > GRID_COLUMNS) { rows.push(row); row = []; used = 0; }
        row.push(current); used += current.w;
        if (used === GRID_COLUMNS) { rows.push(row); row = []; used = 0; }
    }
    if (row.length) rows.push(row);
    return rows.find((items) => items.includes(item)) || [item];
}

function growWidthAndShrinkNeighbour(item, amount = 1) {
    let remaining = Math.min(amount, def(item.id).maxW - item.w);
    while (remaining > 0) {
        const neighbour = rowContaining(item)
            .filter((entry) => entry !== item && entry.w > def(entry.id).minW)
            .sort((a, b) => (b.w - def(b.id).minW) - (a.w - def(a.id).minW))[0];
        if (!neighbour) break;
        neighbour.w--; item.w++; remaining--;
    }
}

function growHeightAndShrinkNeighbour(item, amount = 1) {
    let remaining = Math.min(amount, def(item.id).maxH - item.h);
    while (remaining > 0) {
        const neighbour = rowContaining(item)
            .filter((entry) => entry !== item && entry.h > def(entry.id).minH)
            .sort((a, b) => (b.h - def(b.id).minH) - (a.h - def(a.id).minH))[0];
        if (!neighbour) break;
        neighbour.h--; item.h++; remaining--;
    }
}

function bindEvents() {
    window.addEventListener('resize', () => { clearTimeout(responsiveTimer); responsiveTimer = window.setTimeout(applyResponsiveGrid, 120); });
    byId('dashboard-edit-toggle')?.addEventListener('click', () => setEditing(!editing));
    byId('dashboard-catalog-close')?.addEventListener('click', () => setEditing(false));
    byId('dashboard-reset-layout')?.addEventListener('click', () => { layout = defaultLayout(); renderGrid(); setEditing(true); persist(); });
    byId('dashboard-widget-search')?.addEventListener('input', (event) => renderCatalog(event.target.value));
    byId('dashboard-widget-list')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-add-widget]'); if (!button || button.disabled || !gridStack) return;
        const meta = def(button.dataset.addWidget); const item = { id: meta.id, type: meta.id, order: layout.length, w: meta.w, h: meta.h, x: 0, y: 0, config: {} };
        const article = makeWidget(item);
        byId('dashboard-widget-grid')?.appendChild(article);
        gridStack.makeWidget(article, { id: meta.id, w: meta.w, h: meta.h, minW: meta.minW, minH: meta.minH, maxW: meta.maxW, maxH: meta.maxH, autoPosition: true });
        observeWidgetDensity(); syncLayoutFromGrid(); renderCatalog(); persist();
    });
    byId('dashboard-widget-grid')?.addEventListener('click', (event) => {
        const article = event.target.closest('.dashboard-widget'); if (!article) return;
        if (event.target.closest('[data-remove]')) { const source = sourceFor(article.dataset.widgetId); if (source) byId('dashboard-widget-sources')?.appendChild(source); gridStack?.removeWidget(article, true); syncLayoutFromGrid(); renderCatalog(); persist(); return; }
        const size = event.target.closest('[data-size]'); if (size) changeSize(article.dataset.widgetId, size.dataset.size);
        if (event.target.closest('[data-dashboard-action="sync"]')) window.syncDriveScreenshots?.(false);
    });
    return;
    byId('dashboard-edit-toggle')?.addEventListener('click', () => setEditing(!editing));
    byId('dashboard-catalog-close')?.addEventListener('click', () => setEditing(false));
    byId('dashboard-reset-layout')?.addEventListener('click', () => { layout = defaultLayout(); persist(); renderGrid(); });
    byId('dashboard-widget-search')?.addEventListener('input', (event) => renderCatalog(event.target.value));
    byId('dashboard-widget-list')?.addEventListener('click', (event) => { const button = event.target.closest('[data-add-widget]'); if (!button || button.disabled) return; const meta = def(button.dataset.addWidget); compactLastRowFor(meta); layout.push({ id: meta.id, type: meta.id, order: layout.length, w: meta.w, h: meta.h, x: 0, y: layout.length, config: {} }); persist(); renderGrid(); });
    byId('dashboard-widget-grid')?.addEventListener('click', (event) => {
        const article = event.target.closest('.dashboard-widget'); if (!article) return;
        if (event.target.closest('[data-remove]')) { layout = layout.filter((item) => item.id !== article.dataset.widgetId); persist(); renderGrid(); return; }
        const size = event.target.closest('[data-size]'); if (size) changeSize(article.dataset.widgetId, size.dataset.size);
        if (event.target.closest('[data-dashboard-action="sync"]')) window.syncDriveScreenshots?.(false);
    });
    byId('dashboard-widget-grid')?.addEventListener('pointerdown', (event) => {
        if (!editing) return; const article = event.target.closest('.dashboard-widget'); if (!article) return;
        if (event.target.closest('.dashboard-widget-drag')) {
            const rect = article.getBoundingClientRect(); const ghost = article.cloneNode(true);
            ghost.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
            ghost.className = 'dashboard-widget-drag-ghost';
            ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`; ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`;
            document.body.appendChild(ghost);
            drag = { id: article.dataset.widgetId, pointerId: event.pointerId, article, ghost, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY };
            article.classList.add('is-dragging'); byId('dashboard-widget-grid')?.classList.add('is-dragging-active');
            event.target.setPointerCapture?.(event.pointerId); event.preventDefault();
        }
        if (event.target.closest('.dashboard-resize-handle')) { const item = layout.find((entry) => entry.id === article.dataset.widgetId); drag = { id: item.id, pointerId: event.pointerId, resize: true, startX: event.clientX, startY: event.clientY, w: item.w, h: item.h }; event.target.setPointerCapture?.(event.pointerId); event.preventDefault(); }
    });
    document.addEventListener('pointermove', (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.resize) { const item = layout.find((entry) => entry.id === drag.id); const meta = def(drag.id); const desiredW = clamp(drag.w + Math.round((event.clientX - drag.startX) / 36), meta.minW, meta.maxW); const desiredH = clamp(drag.h + Math.round((event.clientY - drag.startY) / 58), meta.minH, meta.maxH); if (desiredW < item.w) item.w = desiredW; else if (desiredW > item.w) growWidthAndShrinkNeighbour(item, desiredW - item.w); if (desiredH < item.h) item.h = desiredH; else if (desiredH > item.h) growHeightAndShrinkNeighbour(item, desiredH - item.h); document.querySelectorAll('#dashboard-widget-grid .dashboard-widget').forEach((node) => { const entry = layout.find((value) => value.id === node.dataset.widgetId); if (entry) { node.style.setProperty('--widget-w', entry.w); node.style.setProperty('--widget-h', entry.h); node.dataset.widgetH = String(entry.h); } }); return; }
        drag.lastX = event.clientX; drag.lastY = event.clientY;
        if (!drag.frame) drag.frame = requestAnimationFrame(() => { if (drag?.ghost) drag.ghost.style.transform = `translate3d(${drag.lastX - drag.startX}px,${drag.lastY - drag.startY}px,0) scale(1.02)`; if (drag) drag.frame = 0; });
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.dashboard-widget'); if (target && target.dataset.widgetId !== drag.id) moveItemLive(drag.id, target.dataset.widgetId);
    });
    document.addEventListener('pointerup', (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.frame) cancelAnimationFrame(drag.frame);
        drag.ghost?.remove();
        document.querySelector(`[data-widget-id="${drag.id}"]`)?.classList.remove('is-dragging');
        byId('dashboard-widget-grid')?.classList.remove('is-dragging-active');
        if (drag.resize) renderGrid();
        persist(); drag = null;
    });
}

export function refreshDashboardWidgets() {
    if (!initialized) return;
    layout.forEach((item) => {
        if (sourceNodes.has(item.id)) return;
        const host = document.querySelector(`[data-widget-id="${item.id}"] .dashboard-widget-content`);
        if (host) renderGenerated(item.id, host);
    });
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 20);
}

export async function initDashboardWidgets() {
    if (!byId('dashboard-widget-grid')) return;
    if (!sourceNodes.size) document.querySelectorAll('[data-dashboard-widget]').forEach((node) => sourceNodes.set(node.dataset.dashboardWidget, node));
    const mentorModal = byId('dashboard-mentor-modal');
    if (mentorModal && mentorModal.parentElement !== byId('view-dash')) byId('view-dash')?.appendChild(mentorModal);
    let storedLayout = state.appData?.settings?.dashboardLayout;
    if (!ownProfile() && state.currentViewedUserId) {
        const { data, error } = await supabase.from('profiles').select('settings').eq('id', state.currentViewedUserId).maybeSingle();
        if (!error) storedLayout = data?.settings?.dashboardLayout;
    }
    layout = normalizeLayout(storedLayout);
    if (!initialized) { bindEvents(); initialized = true; }
    const toggle = byId('dashboard-edit-toggle'); if (toggle) toggle.hidden = !ownProfile();
    editing = false; renderGrid(); setEditing(false);
}
