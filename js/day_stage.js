import { state } from './state.js';
import { parseDecimalInput, showPrompt, showToast } from './utils.js';
import { resolveMonthlyDayloss } from './data_utils.js';
import { getCalendarDayResult, visibleTradeRows } from './trade_filters.js';
import { pickSheetRowsSource } from './datagrid_rows.js';
import { getNyseDaySchedule } from './nyse_calendar.js';
import { findScreenshotsForTicker, getStorageUrl, openScreenshotForTrade, openZoomGallery } from './gallery.js';
import { saveSettings } from './storage.js';

let stageWanted = false;
let bound = false;
let screenToken = 0;
let flyDirection = 0;
let lastStageDate = '';
let flightToken = 0;
let dayDateMonth = null;
const tiltQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'];
const SCORES = [
    { key: 'discipline', id: 'day-score-discipline', label: 'Дисципліна', tone: 'green' },
    { key: 'plan', id: 'day-score-plan', label: 'План', tone: 'blue' },
    { key: 'emotion', id: 'day-score-emotion', label: 'Емоційний стан', tone: 'amber' },
    { key: 'entries', id: 'day-score-entries', label: 'Якість входів', tone: 'teal' },
];

function isOwnJournal() {
    return state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
}

function isDayFormOpen() {
    const sidebar = document.getElementById('form-sidebar');
    if (!sidebar) return false;
    if (window.innerWidth <= 1024) return sidebar.classList.contains('open');
    return !sidebar.classList.contains('collapsed');
}

function isCalendarActive() {
    return document.getElementById('view-calendar')?.classList.contains('active') === true;
}

function stageShouldShow(options = {}) {
    if (!stageWanted || !isCalendarActive() || !state.selectedDateStr) return false;
    if (window.innerWidth <= 1024) return true;
    return isDayFormOpen() || options.pendingForm === true;
}

function formatLongDate(dateStr) {
    const [year, month, day] = String(dateStr || '').split('-').map(Number);
    if (!year || !month || !day) return 'День';
    const text = new Date(year, month - 1, day).toLocaleDateString('uk-UA', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    });
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatSignedMoney(value) {
    const parsed = typeof value === 'number' ? value : parseDecimalInput(value);
    if (parsed === null || !Number.isFinite(parsed)) return null;
    const rounded = parseFloat(parsed.toFixed(2));
    return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(2)}$`;
}

function formatKf(value) {
    const parsed = parseDecimalInput(value);
    if (parsed === null) return '';
    return parsed.toLocaleString('uk-UA', { maximumFractionDigits: 2 });
}

function tradeKf(trade) {
    const raw = trade?.sheet?.profitRisk ?? trade?.profitRisk ?? trade?.kf;
    const normalized = String(raw ?? '').trim().replace(',', '.').replace(/\s*(?:r|кф)\s*$/i, '');
    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('uk-UA', { maximumFractionDigits: 2 });
}

function tradeComment(trade) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    return String(trade?.comment ?? trade?.notes ?? trade?.review ?? sheet.comment ?? sheet.traderComment ?? sheet.teamLeadComment ?? '').trim();
}

function preferredSheetId() {
    try {
        const storageKey = state.myUserId ? `sheet_spreadsheet_id:${state.myUserId}` : 'sheet_spreadsheet_id';
        return localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey) || '';
    } catch {
        return '';
    }
}

function dayTradeRows(dateStr, day) {
    const imported = pickSheetRowsSource(state.appData?.sheetRows || {}, preferredSheetId());
    const sheetRows = Array.isArray(imported?.byDay?.[dateStr]) ? imported.byDay[dateStr] : [];
    if (sheetRows.length) {
        return [...sheetRows]
            .sort((a, b) => (Number(a?.sheet?.sheetRow) || 0) - (Number(b?.sheet?.sheetRow) || 0))
            .map((trade) => ({ trade }));
    }
    return visibleTradeRows(day?.trades);
}

function sheetScreenshotUrl(trade) {
    const url = String(trade?.sheet?.screenshotUrl || '').trim();
    return url.startsWith('http') ? url : '';
}

function galleryPathsForSheetScreenshot(trade) {
    const url = sheetScreenshotUrl(trade);
    const driveId = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1] || '';
    if (!driveId) return [];
    const meta = state.appData?.screenMeta || {};
    return Object.keys(meta).filter((path) => String(meta[path]?.driveId || '') === driveId);
}

function emptyLine(text) {
    const node = document.createElement('p');
    node.className = 'day-stage-empty';
    node.textContent = text;
    return node;
}

function setIdleValue(element, value) {
    if (!element || document.activeElement === element) return;
    if (element.value !== value) element.value = value;
}

function mirrorField(stageId, formId) {
    const stageEl = document.getElementById(stageId);
    const formEl = document.getElementById(formId);
    if (!stageEl || !formEl || stageEl.dataset.mirrorBound === '1') return;
    stageEl.dataset.mirrorBound = '1';
    stageEl.addEventListener('input', () => {
        if (formEl.value === stageEl.value) return;
        formEl.value = stageEl.value;
        formEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    formEl.addEventListener('input', () => {
        if (document.activeElement === stageEl) return;
        if (stageEl.value !== formEl.value) stageEl.value = formEl.value;
    });
}

function resetTilt(root) {
    root?.querySelectorAll('[data-tilt]').forEach((element) => {
        element.style.setProperty('--tilt-x', '0deg');
        element.style.setProperty('--tilt-y', '0deg');
    });
}

function bindTilt(root) {
    root.addEventListener('pointermove', (event) => {
        if (tiltQuery.matches) return;
        const card = event.target?.closest?.('[data-tilt]');
        root.querySelectorAll('[data-tilt]').forEach((element) => {
            if (element === card) return;
            element.style.setProperty('--tilt-x', '0deg');
            element.style.setProperty('--tilt-y', '0deg');
        });
        if (!card || !root.contains(card)) return;
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = (event.clientX - rect.left) / rect.width - 0.5;
        const py = (event.clientY - rect.top) / rect.height - 0.5;
        card.style.setProperty('--tilt-x', `${(-py * 6).toFixed(2)}deg`);
        card.style.setProperty('--tilt-y', `${(px * 6).toFixed(2)}deg`);
    });
    root.addEventListener('pointerleave', () => resetTilt(root));
}

function overlayBlocksEscape() {
    const preview = document.getElementById('image-preview');
    if (preview && preview.style.display && preview.style.display !== 'none') return true;
    return ['session-review-modal', 'session-modal', 'sos-modal', 'name-modal', 'live-news-modal', 'cumulative-weekly-modal', 'next-session-info-modal', 'aggressiveness-info-modal']
        .some((id) => {
            const element = document.getElementById(id);
            if (!element) return false;
            if (element.classList.contains('open')) return true;
            return element.style.display && element.style.display !== 'none';
        });
}

function writeHidden(id, value, emit) {
    const el = document.getElementById(id);
    if (!el) return;
    const next = value == null ? '' : String(value);
    if (el.value === next) return;
    el.value = next;
    if (emit) el.dispatchEvent(new Event('input', { bubbles: true }));
}

function storedScore(day, key) {
    const raw = document.getElementById(`day-score-${key}`)?.value;
    if (raw !== undefined && raw !== '') {
        const fromField = Number(raw);
        if (Number.isFinite(fromField)) return Math.min(10, Math.max(1, Math.round(fromField)));
    }
    const saved = Number(day?.dayScores?.[key]);
    if (Number.isFinite(saved) && saved >= 1 && saved <= 10) return Math.round(saved);
    return null;
}

function storedGrade() {
    const raw = String(document.getElementById('day-grade')?.value || '').trim().toUpperCase();
    return GRADES.includes(raw) ? raw : '';
}

function readTags() {
    try {
        const parsed = JSON.parse(document.getElementById('day-tags-json')?.value || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 16);
    } catch {
        return [];
    }
}

function writeTags(tags, emit) {
    writeHidden('day-tags-json', JSON.stringify(tags.slice(0, 16)), emit);
    renderTags();
}

function shiftWeekday(dateStr, direction) {
    const [year, month, day] = String(dateStr || '').split('-').map(Number);
    if (!year || !month || !day) return '';
    const date = new Date(year, month - 1, day);
    const step = direction < 0 ? -1 : 1;
    for (let i = 0; i < 8; i += 1) {
        date.setDate(date.getDate() + step);
        const dow = date.getDay();
        if (dow !== 0 && dow !== 6) break;
    }
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
}

function dayNets(rows) {
    const nets = [];
    rows.forEach(({ trade }) => {
        const net = Number(trade?.net);
        if (Number.isFinite(net)) nets.push(net);
    });
    return nets;
}

function sparkline(nets, profit) {
    if (nets.length < 2) return null;
    let acc = 0;
    const points = nets.map((net) => (acc += net));
    const min = Math.min(...points, 0);
    const max = Math.max(...points, 0);
    const span = max - min || 1;
    const width = 128;
    const height = 46;
    const padX = 4;
    const coords = points.map((point, index) => {
        const x = padX + (index / (points.length - 1)) * (width - padX * 2);
        const y = height - ((point - min) / span) * (height - 8) - 4;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', `day-stage-spark ${profit ? 'is-profit' : 'is-loss'}`);
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', coords.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '2.4');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
    return svg;
}

function scoreIcon(tone) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    const shapes = {
        green: 'M12 3l7 3v6c0 4.2-2.8 7.2-7 8.5C7.8 19.2 5 16.2 5 12V6l7-3z',
        blue: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
        amber: 'M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
        teal: 'M4 16l5-5 3 3 8-8M14 6h6v6',
    };
    path.setAttribute('d', shapes[tone] || shapes.green);
    svg.append(path);
    return svg;
}

function commitScore(key, value) {
    writeHidden(`day-score-${key}`, value, true);
}

function bindScoreDrag(root) {
    const host = root.querySelector('#day-stage-scores');
    if (!host) return;
    host.addEventListener('pointerdown', (event) => {
        const card = event.target?.closest?.('[data-score]');
        if (!card || !isOwnJournal() || event.button !== 0) return;
        event.preventDefault();
        const startY = event.clientY;
        const start = Number(card.dataset.value) || 5;
        host.dataset.dragging = '1';
        card.setPointerCapture(event.pointerId);
        const paint = (clientY) => {
            const next = Math.min(10, Math.max(1, Math.round(start + (startY - clientY) / 16)));
            card.dataset.value = String(next);
            card.setAttribute('aria-valuenow', String(next));
            const strong = card.querySelector('strong');
            if (strong) strong.textContent = `${next}/10`;
            if (!tiltQuery.matches) {
                const dy = clientY - startY;
                const scale = 1 + Math.min(0.16, Math.abs(dy) / 180);
                const shift = Math.max(-14, Math.min(14, dy / 8));
                card.style.transformOrigin = dy < 0 ? 'center bottom' : 'center top';
                card.style.transform = `translateY(${shift}px) scaleY(${scale})`;
            }
        };
        const move = (ev) => paint(ev.clientY);
        const end = () => {
            card.removeEventListener('pointermove', move);
            card.removeEventListener('pointerup', end);
            card.removeEventListener('pointercancel', end);
            card.style.transform = '';
            delete host.dataset.dragging;
            commitScore(card.dataset.score, Number(card.dataset.value));
        };
        card.addEventListener('pointermove', move);
        card.addEventListener('pointerup', end);
        card.addEventListener('pointercancel', end);
    });
    host.addEventListener('keydown', (event) => {
        const card = event.target?.closest?.('[data-score]');
        if (!card || !isOwnJournal()) return;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const current = Number(card.dataset.value) || 5;
        const next = Math.min(10, Math.max(1, current + (event.key === 'ArrowUp' ? 1 : -1)));
        card.dataset.value = String(next);
        const strong = card.querySelector('strong');
        if (strong) strong.textContent = `${next}/10`;
        commitScore(card.dataset.score, next);
    });
}

function mirrorRange(stageId, formId, stageLabelId, formLabelId) {
    const stageEl = document.getElementById(stageId);
    const formEl = document.getElementById(formId);
    if (!stageEl || !formEl || stageEl.dataset.mirrorBound === '1') return;
    stageEl.dataset.mirrorBound = '1';
    const paint = (source, labelId) => {
        const label = document.getElementById(labelId);
        if (label) label.textContent = `${source.value}/10`;
    };
    stageEl.addEventListener('input', () => {
        if (formEl.value !== stageEl.value) {
            formEl.value = stageEl.value;
            formEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        paint(stageEl, stageLabelId);
    });
    formEl.addEventListener('input', () => {
        if (document.activeElement === stageEl) return;
        if (stageEl.value !== formEl.value) stageEl.value = formEl.value;
        paint(stageEl, stageLabelId);
        paint(formEl, formLabelId);
    });
}

function ensureBound() {
    if (bound) return;
    const stage = document.getElementById('day-stage');
    if (!stage) return;
    bound = true;
    bindTilt(stage);
    bindScoreDrag(stage);
    mirrorField('day-stage-notes', 'trade-notes');
    mirrorField('day-stage-improvement', 'next-session-improvement');
    mirrorField('day-prep-goal', 'session-goal');
    mirrorField('day-prep-plan', 'session-plan');
    mirrorRange('day-prep-readiness', 'session-readiness', 'day-prep-readiness-val', 'session-readiness-val');
    document.addEventListener('pointerdown', (event) => {
        const menu = document.getElementById('day-grade-menu');
        if (!menu || menu.hidden) return;
        if (event.target?.closest?.('#day-grade-menu, [data-action="day-grade-open"]')) return;
        menu.hidden = true;
    });
    document.addEventListener('pointerdown', (event) => {
        const calendar = document.getElementById('day-stage-date-calendar');
        if (!calendar || calendar.hidden) return;
        if (event.target?.closest?.('#day-stage-date-calendar, #day-stage-date')) return;
        setDayDateCalendarOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !stageShouldShow()) return;
        const calendar = document.getElementById('day-stage-date-calendar');
        if (calendar && !calendar.hidden) {
            setDayDateCalendarOpen(false);
            return;
        }
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (overlayBlocksEscape()) return;
        closeDayStage();
        window.closeDayPanel?.();
    });
    document.addEventListener('app:view-enter', () => applyVisibility());
    window.addEventListener('resize', () => applyVisibility());
}

const FLY_MS = 760;
const FLY_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

function boxOf(element) {
    return {
        left: element.offsetLeft,
        top: element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
    };
}

function clearFlightArtifacts(hero) {
    flightToken += 1;
    if (!hero) return;
    hero.classList.remove('is-flying');
    hero.querySelectorAll('.day-stage-card-fly-out, .day-stage-ghost-fly').forEach((node) => node.remove());
    hero.querySelectorAll('.day-stage-ghost').forEach((ghost) => {
        ghost.getAnimations().forEach((animation) => animation.cancel());
        ghost.classList.remove('is-slot-hidden');
        ghost.style.opacity = '';
        ghost.style.transform = '';
        ghost.style.filter = '';
    });
    const card = document.getElementById('day-stage-card');
    if (!card) return;
    card.style.transition = 'none';
    card.getAnimations().forEach((animation) => animation.cancel());
    card.style.transform = '';
    card.style.filter = '';
    card.style.opacity = '';
    card.style.zIndex = '';
    requestAnimationFrame(() => {
        if (card.isConnected) card.style.transition = '';
    });
}

function placeFlightClone(node, hero, box, className) {
    node.removeAttribute('id');
    node.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
    node.classList.remove('day-tilt');
    node.classList.add(className);
    node.style.position = 'absolute';
    node.style.right = 'auto';
    node.style.margin = '0';
    node.style.left = `${box.left}px`;
    node.style.top = `${box.top}px`;
    node.style.width = `${box.width}px`;
    node.style.height = `${box.height}px`;
    node.style.pointerEvents = 'none';
    hero.appendChild(node);
}

function flyCarousel({ card, outgoing, leaving, direction, hero, prevGhost, nextGhost, cardBox, destBox }) {
    const token = ++flightToken;
    const toNext = direction > 0;
    const sourceGhost = toNext ? nextGhost : prevGhost;
    const destGhost = toNext ? prevGhost : nextGhost;
    const rotIn = toNext ? 14 : -14;
    const rotOut = toNext ? -14 : 14;
    const rest = getComputedStyle(card).transform;
    const cardRect = card.getBoundingClientRect();
    const sourceRect = sourceGhost.getBoundingClientRect();
    const destRect = destGhost.getBoundingClientRect();
    const dxIn = (sourceRect.left + sourceRect.width / 2) - (cardRect.left + cardRect.width / 2);
    const dyIn = (sourceRect.top + sourceRect.height / 2) - (cardRect.top + cardRect.height / 2);
    const scaleIn = Math.max(0.36, Math.min(0.58, sourceRect.width / Math.max(cardRect.width, 1)));
    const step = Math.round((Math.abs(dxIn) || 220) + sourceRect.width * 0.85);

    hero.classList.add('is-flying');
    destGhost.classList.add('is-slot-hidden');

    const enterFrom = `translateX(${toNext ? step : -step}px) rotate(${rotIn}deg) scale(0.9)`;
    const enterTo = `rotate(${rotIn}deg) scale(0.9)`;
    sourceGhost.animate([
        { transform: enterFrom, opacity: 0, filter: 'blur(12px)' },
        { transform: enterTo, opacity: 0.78, filter: 'blur(3px)' },
    ], { duration: FLY_MS, easing: FLY_EASE, fill: 'both' });

    if (leaving) {
        placeFlightClone(leaving, hero, destBox, 'day-stage-ghost-fly');
        const leaveFrom = `rotate(${rotOut}deg) scale(0.9)`;
        const leaveTo = `translateX(${toNext ? -step : step}px) rotate(${rotOut}deg) scale(0.9)`;
        leaving.animate([
            { transform: leaveFrom, opacity: 0.78, filter: 'blur(3px)' },
            { transform: leaveTo, opacity: 0, filter: 'blur(12px)' },
        ], { duration: FLY_MS, easing: FLY_EASE, fill: 'both' });
    }

    placeFlightClone(outgoing, hero, cardBox, 'day-stage-card-fly-out');
    outgoing.style.zIndex = '1';
    const outRect = outgoing.getBoundingClientRect();
    const dxOut = (destRect.left + destRect.width / 2) - (outRect.left + outRect.width / 2);
    const dyOut = (destRect.top + destRect.height / 2) - (outRect.top + outRect.height / 2);
    const scaleOut = Math.max(0.36, Math.min(0.58, destRect.width / Math.max(outRect.width, 1)));
    outgoing.animate([
        { transform: 'none', filter: 'blur(0px)', opacity: 1 },
        { transform: `translate(${dxOut}px, ${dyOut}px) rotate(${rotOut}deg) scale(${scaleOut})`, filter: 'blur(8px)', opacity: 0 },
    ], { duration: FLY_MS, easing: FLY_EASE, fill: 'both' });

    card.style.zIndex = '4';
    card.style.transition = 'none';
    const incoming = card.animate([
        { transform: `translate(${dxIn}px, ${dyIn}px) rotate(${rotIn}deg) scale(${scaleIn})`, filter: 'blur(8px)', opacity: 0.66 },
        { transform: rest && rest !== 'none' ? rest : 'perspective(900px) rotateX(0deg) rotateY(0deg)', filter: 'blur(0px)', opacity: 1 },
    ], { duration: FLY_MS, easing: FLY_EASE, fill: 'both' });

    destGhost.animate([
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: 0.62 },
        { opacity: 0.78, offset: 1 },
    ], { duration: FLY_MS, easing: 'linear', fill: 'both' });

    let settled = false;
    const finish = () => {
        if (settled || token !== flightToken) return;
        settled = true;
        card.style.transition = 'none';
        destGhost.classList.remove('is-slot-hidden');
        sourceGhost.getAnimations().forEach((animation) => animation.cancel());
        destGhost.getAnimations().forEach((animation) => animation.cancel());
        incoming.cancel();
        card.style.transform = '';
        card.style.filter = '';
        card.style.opacity = '';
        card.style.zIndex = '';
        hero.classList.remove('is-flying');
        hero.querySelectorAll('.day-stage-card-fly-out, .day-stage-ghost-fly').forEach((node) => node.remove());
        requestAnimationFrame(() => {
            card.style.transition = '';
        });
    };
    incoming.onfinish = finish;
    window.setTimeout(finish, FLY_MS + 90);
}

export function noteDayFly(offset) {
    if (!stageShouldShow() || tiltQuery.matches) return;
    flyDirection = offset < 0 ? -1 : 1;
}

function dateParts(dateStr) {
    const [year, month, day] = String(dateStr || '').split('-').map(Number);
    if (!year || !month || !day) return null;
    return { year, month: month - 1, day };
}

function setDayDateCalendarOpen(open) {
    const calendar = document.getElementById('day-stage-date-calendar');
    const trigger = document.getElementById('day-stage-date');
    if (!calendar || !trigger) return;
    calendar.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        const parsed = dateParts(state.selectedDateStr);
        const now = new Date();
        dayDateMonth = parsed
            ? { year: parsed.year, month: parsed.month }
            : { year: now.getFullYear(), month: now.getMonth() };
        renderDayDateCalendar();
    }
}

export function toggleDayDateCalendar() {
    const calendar = document.getElementById('day-stage-date-calendar');
    if (!calendar) return;
    setDayDateCalendarOpen(calendar.hidden);
}

export function shiftDayDateCalendar(offset) {
    if (!dayDateMonth) setDayDateCalendarOpen(true);
    if (!dayDateMonth || !Number.isFinite(offset) || !offset) return;
    const next = new Date(dayDateMonth.year, dayDateMonth.month + offset, 1);
    dayDateMonth = { year: next.getFullYear(), month: next.getMonth() };
    renderDayDateCalendar();
}

export function pickDayDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
    setDayDateCalendarOpen(false);
    if (dateStr !== state.selectedDateStr) window.selectDate?.(dateStr);
}

function renderDayDateCalendar() {
    const grid = document.getElementById('day-stage-date-grid');
    const label = document.getElementById('day-stage-date-month');
    if (!grid || !label || !dayDateMonth) return;
    const { year, month } = dayDateMonth;
    const monthName = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));
    label.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
    grid.replaceChildren();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < firstWeekday; i += 1) {
        const empty = document.createElement('span');
        empty.className = 'day-stage-date-day is-empty';
        grid.append(empty);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'day-stage-date-day';
        button.dataset.action = 'day-date-pick';
        button.dataset.date = dateStr;
        button.textContent = String(day);
        const result = getCalendarDayResult(state.appData?.journal?.[dateStr] || {});
        if (result.value !== null && state.appData?.journal?.[dateStr]?.traderAbsent !== true && state.appData?.journal?.[dateStr]?.demoTrading !== true) {
            button.classList.add(result.value >= 0 ? 'is-profit' : 'is-loss');
        }
        if (dateStr === state.selectedDateStr) button.classList.add('is-active');
        grid.append(button);
    }
}

function renderGhost(element, dateStr) {
    if (!element) return;
    element.replaceChildren();
    if (!dateStr) return;
    const day = state.appData?.journal?.[dateStr] || {};
    const absent = day.traderAbsent === true;
    const pnl = absent ? null : getCalendarDayResult(day).value;
    element.classList.toggle('is-green', pnl !== null && pnl >= 0);
    element.classList.toggle('is-red', pnl !== null && pnl < 0);
    const num = document.createElement('strong');
    num.textContent = String(Number(dateStr.slice(8, 10)));
    const money = document.createElement('span');
    money.textContent = pnl === null ? '' : formatSignedMoney(pnl);
    element.append(num, money);
}

function renderCard(dateStr, day) {
    const card = document.getElementById('day-stage-card');
    if (!card) return;
    const absent = day?.traderAbsent === true;
    const demo = day?.demoTrading === true;
    const result = absent ? { value: null } : getCalendarDayResult(day || {});
    const pnl = result.value;
    const schedule = absent ? null : getNyseDaySchedule(dateStr);
    const rows = dayTradeRows(dateStr, day);
    const nets = dayNets(rows);
    const wins = nets.filter((net) => net > 0).length;
    const rate = nets.length ? Math.round((wins / nets.length) * 100) : null;
    const monthKey = dateStr.slice(0, 7);
    const dayloss = resolveMonthlyDayloss(state.appData?.settings, monthKey);
    const [, month, rawDay] = dateStr.split('-').map(Number);
    const monthName = new Date(Number(dateStr.slice(0, 4)), month - 1, 1).toLocaleDateString('uk-UA', { month: 'long' });

    card.className = 'day-stage-card day-tilt';
    card.dataset.tilt = '';
    if (!absent && pnl !== null) card.classList.add(pnl >= 0 ? 'is-green' : 'is-red');
    if (absent) card.classList.add('is-absent');
    else if (demo) card.classList.add('is-demo');
    if (schedule?.type === 'closed') card.classList.add('is-closed');
    if (schedule?.type === 'early-close') card.classList.add('is-early');
    if (state.autoFlagsCache?.absoluteRecord === dateStr) card.classList.add('is-record');
    else if (state.autoFlagsCache?.records?.has?.(dateStr)) card.classList.add('is-record-old');
    if (pnl !== null && pnl <= dayloss) card.classList.add('is-dayloss');

    const monthNode = document.createElement('p');
    monthNode.className = 'day-stage-card-month';
    monthNode.textContent = monthName;

    const hero = document.createElement('div');
    hero.className = 'day-stage-card-hero';
    const number = document.createElement('div');
    number.className = 'day-stage-card-num';
    number.textContent = String(rawDay);
    const money = document.createElement('div');
    money.className = 'day-stage-card-pnl';
    if (absent) money.textContent = 'Неторговий';
    else if (pnl === null) money.textContent = 'Без результату';
    else {
        money.textContent = formatSignedMoney(pnl);
        money.classList.add(pnl >= 0 ? 'is-profit' : 'is-loss');
    }
    hero.append(number, money);
    const line = pnl !== null ? sparkline(nets, pnl >= 0) : null;
    if (line) hero.append(line);

    const tone = document.createElement('p');
    tone.className = 'day-stage-card-tone';
    if (absent) tone.textContent = 'Неторговий день';
    else if (pnl === null) tone.textContent = demo ? 'Демо без результату' : 'Без результату';
    else if (pnl > 0) tone.textContent = demo ? 'Прибуткове демо' : 'Прибутковий день';
    else if (pnl < 0) tone.textContent = demo ? 'Збиткове демо' : 'Збитковий день';
    else tone.textContent = 'Нульовий день';
    if (schedule?.type === 'closed') tone.textContent = 'Вихідний NYSE';
    if (schedule?.type === 'early-close') tone.textContent += ' · до 13:00';

    const stats = document.createElement('div');
    stats.className = 'day-stage-card-stats';
    const stat = (value, label) => {
        const cell = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = value;
        const span = document.createElement('span');
        span.textContent = label;
        cell.append(strong, span);
        return cell;
    };
    stats.append(
        stat(String(rows.length), rows.length === 1 ? 'угода' : 'угод'),
        stat(rate === null ? '—' : `${rate}%`, 'влучність'),
    );
    const kf = formatKf(day?.kf);
    if (kf) stats.append(stat(kf, 'КФ дня'));

    const grade = storedGrade();
    const gradeCell = document.createElement('div');
    gradeCell.className = 'day-stage-grade-wrap';
    const gradeBtn = document.createElement('button');
    gradeBtn.type = 'button';
    gradeBtn.className = 'day-stage-grade';
    gradeBtn.dataset.action = 'day-grade-open';
    gradeBtn.disabled = !isOwnJournal();
    const gradeLetter = document.createElement('strong');
    gradeLetter.textContent = grade || '—';
    const gradeLabel = document.createElement('span');
    gradeLabel.textContent = 'оцінка дня';
    gradeBtn.append(gradeLetter, gradeLabel);
    const menu = document.createElement('div');
    menu.id = 'day-grade-menu';
    menu.className = 'day-grade-menu';
    menu.hidden = true;
    GRADES.forEach((letter) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.dataset.action = 'day-grade-set';
        option.dataset.grade = letter;
        option.textContent = letter;
        option.className = letter === grade ? 'is-current' : '';
        menu.append(option);
    });
    gradeCell.append(gradeBtn, menu);
    stats.append(gradeCell);

    const stageHero = card.closest('.day-stage-hero');
    if (stageHero?.classList.contains('is-flying') && lastStageDate === dateStr) {
        card.replaceChildren(monthNode, hero, tone, stats);
        return;
    }

    const direction = flyDirection;
    flyDirection = 0;
    const prevGhost = document.getElementById('day-stage-ghost-prev');
    const nextGhost = document.getElementById('day-stage-ghost-next');
    const ghostsVisible = prevGhost && nextGhost && prevGhost.offsetWidth > 0 && nextGhost.offsetWidth > 0;
    const shouldFly = Boolean(direction && lastStageDate && lastStageDate !== dateStr && !tiltQuery.matches && stageHero && ghostsVisible);
    const cardBox = shouldFly ? boxOf(card) : null;
    const destGhost = shouldFly ? (direction > 0 ? prevGhost : nextGhost) : null;
    const destBox = destGhost ? boxOf(destGhost) : null;
    const leaving = destGhost ? destGhost.cloneNode(true) : null;
    const outgoing = shouldFly ? card.cloneNode(true) : null;
    card.replaceChildren(monthNode, hero, tone, stats);
    renderGhost(prevGhost, shiftWeekday(dateStr, -1));
    renderGhost(nextGhost, shiftWeekday(dateStr, 1));
    if (shouldFly) {
        clearFlightArtifacts(stageHero);
        flyCarousel({ card, outgoing, leaving, direction, hero: stageHero, prevGhost, nextGhost, cardBox, destBox });
    }
    lastStageDate = dateStr;
}

function renderScores(day) {
    const host = document.getElementById('day-stage-scores');
    if (!host || host.dataset.dragging === '1') return;
    host.replaceChildren();
    const editable = isOwnJournal();
    SCORES.forEach((field) => {
        const value = storedScore(day, field.key);
        const card = document.createElement('div');
        card.className = `day-score day-score--${field.tone}`;
        card.dataset.score = field.key;
        card.dataset.value = String(value ?? 5);
        card.tabIndex = editable ? 0 : -1;
        card.setAttribute('role', 'slider');
        card.setAttribute('aria-valuemin', '1');
        card.setAttribute('aria-valuemax', '10');
        card.setAttribute('aria-valuenow', value == null ? '0' : String(value));
        card.setAttribute('aria-label', `${field.label}, потягніть вгору або вниз`);
        const icon = document.createElement('span');
        icon.className = 'day-score-icon';
        icon.append(scoreIcon(field.tone));
        const strong = document.createElement('strong');
        strong.textContent = value == null ? '—' : `${value}/10`;
        const label = document.createElement('span');
        label.textContent = field.label;
        const hint = document.createElement('small');
        hint.textContent = editable ? 'потягни вгору / вниз' : '';
        card.append(icon, strong, label, hint);
        host.append(card);
    });
}

function renderTrades(dateStr, day) {
    const host = document.getElementById('day-stage-trades');
    if (!host) return;
    host.replaceChildren();
    const rows = dayTradeRows(dateStr, day);
    const head = document.createElement('div');
    head.className = 'day-stage-trades-head';
    const title = document.createElement('h3');
    title.textContent = 'Угоди';
    const sum = document.createElement('strong');
    const total = rows.reduce((acc, { trade }) => acc + (Number(trade?.net) || 0), 0);
    if (rows.length) {
        const rounded = parseFloat(total.toFixed(2));
        sum.textContent = formatSignedMoney(rounded);
        sum.classList.add(rounded >= 0 ? 'is-profit' : 'is-loss');
    }
    head.append(title, sum);
    host.append(head);
    if (!rows.length) {
        host.append(emptyLine('Угод за цей день немає.'));
        return;
    }
    const table = document.createElement('div');
    table.className = 'day-trade-table';
    const header = document.createElement('div');
    header.className = 'day-trade-row day-trade-row--head';
    ['Тікер', 'Тип входу', 'PnL', 'КФ', 'Коментар'].forEach((label) => {
        const cell = document.createElement('span');
        cell.textContent = label;
        header.append(cell);
    });
    table.append(header);
    rows.forEach(({ trade }) => {
        const net = Number(trade?.net);
        const hasNet = Number.isFinite(net);
        const comment = tradeComment(trade);
        const screenUrl = sheetScreenshotUrl(trade);
        const linked = galleryPathsForSheetScreenshot(trade);
        const gallery = findScreenshotsForTicker(dateStr, trade?.symbol);
        const hasScreen = Boolean(screenUrl) || linked.length > 0 || gallery.length > 0;
        const row = document.createElement(hasScreen ? 'button' : 'div');
        if (hasScreen) row.type = 'button';
        row.className = `day-trade-row${hasNet ? (net >= 0 ? ' is-profit-row' : ' is-loss-row') : ''}`;
        row.title = hasScreen ? 'Відкрити скрін угоди' : '';
        const symbol = document.createElement('span');
        symbol.className = 'day-trade-symbol';
        symbol.textContent = String(trade?.symbol || '?').toUpperCase();
        const type = document.createElement('span');
        type.textContent = String(trade?.type || trade?.sheet?.tradeType || '—');
        const pnl = document.createElement('strong');
        pnl.className = hasNet && net >= 0 ? 'is-profit' : 'is-loss';
        pnl.textContent = hasNet ? formatSignedMoney(net) : '—';
        const kf = document.createElement('span');
        kf.textContent = tradeKf(trade) || '—';
        const note = document.createElement('span');
        note.className = 'day-trade-comment';
        note.textContent = comment || '—';
        row.append(symbol, type, pnl, kf, note);
        if (hasScreen) {
            row.addEventListener('click', () => {
                if (gallery.length) {
                    void openScreenshotForTrade(dateStr, trade);
                    return;
                }
                const path = linked[0] || screenUrl;
                if (!path) return;
                void getStorageUrl(path).then((src) => {
                    if (src) openZoomGallery(src, [src]);
                });
            });
        }
        table.append(row);
    });
    host.append(table);
}

function renderPrep(dateStr) {
    const day = state.appData?.journal?.[dateStr] || {};
    const editable = isOwnJournal() && !state.dayDetailsLoading;
    const goal = document.getElementById('day-prep-goal');
    const plan = document.getElementById('day-prep-plan');
    const readiness = document.getElementById('day-prep-readiness');
    const readinessLabel = document.getElementById('day-prep-readiness-val');
    const portraitDate = document.getElementById('day-portrait-date');
    if (portraitDate) portraitDate.textContent = dateStr;
    if (goal) {
        goal.readOnly = !editable;
        setIdleValue(goal, document.getElementById('session-goal')?.value ?? day.sessionGoal ?? '');
    }
    if (plan) {
        plan.readOnly = !editable;
        setIdleValue(plan, document.getElementById('session-plan')?.value ?? day.sessionPlan ?? '');
    }
    if (readiness) {
        readiness.disabled = !editable;
        const value = document.getElementById('session-readiness')?.value || day.sessionReadiness || 5;
        if (document.activeElement !== readiness) readiness.value = String(value);
        if (readinessLabel) readinessLabel.textContent = `${readiness.value}/10`;
    }
    const ai = document.getElementById('day-prep-ai-result');
    const formAi = document.getElementById('session-ai-result');
    if (ai && formAi) {
        ai.style.display = formAi.style.display;
        ai.style.background = formAi.style.background;
        ai.style.border = formAi.style.border;
        ai.innerHTML = formAi.innerHTML;
    }
    window.renderSessionPlaybook?.();
}

async function renderTickerScreens(dateStr, day) {
    const host = document.getElementById('trade-type-screens');
    if (!host) return;
    const token = ++screenToken;
    host.replaceChildren();
    const rows = dayTradeRows(dateStr, day);
    const matches = [];
    const seenPath = new Set();
    rows.forEach(({ trade }) => {
        const symbol = String(trade?.symbol || '').trim();
        const direct = sheetScreenshotUrl(trade);
        const linked = galleryPathsForSheetScreenshot(trade);
        (linked.length ? linked : (direct ? [direct] : [])).forEach((path) => {
            if (!path || seenPath.has(path)) return;
            seenPath.add(path);
            matches.push({ path, symbol: symbol || '?' });
        });
        if (!symbol) return;
        findScreenshotsForTicker(dateStr, symbol).forEach((item) => {
            if (!item?.path || seenPath.has(item.path)) return;
            seenPath.add(item.path);
            matches.push({ path: item.path, symbol });
        });
    });
    if (!matches.length) {
        host.append(emptyLine('Немає скрінів, привʼязаних до тікерів цього дня.'));
        return;
    }
    const strip = document.createElement('div');
    strip.className = 'trade-type-screen-strip';
    host.append(strip);
    const resolved = await Promise.all(matches.map(async (item) => ({ ...item, src: await getStorageUrl(item.path) })));
    if (token !== screenToken || state.selectedDateStr !== dateStr) return;
    const sources = resolved.map((item) => item.src).filter(Boolean);
    resolved.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'trade-type-screen';
        button.title = item.symbol.toUpperCase();
        const image = document.createElement('img');
        image.alt = `Скрін ${item.symbol}`;
        image.loading = 'lazy';
        if (item.src) image.src = item.src;
        const caption = document.createElement('span');
        caption.textContent = item.symbol.toUpperCase();
        button.append(image, caption);
        if (item.src) button.addEventListener('click', () => openZoomGallery(item.src, sources));
        strip.append(button);
    });
}

function renderTags() {
    const host = document.getElementById('day-tags');
    if (!host) return;
    host.replaceChildren();
    readTags().forEach((tag) => {
        const chip = document.createElement('span');
        chip.className = 'day-tag';
        const label = document.createElement('span');
        label.textContent = tag;
        chip.append(label);
        if (isOwnJournal()) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.action = 'day-tag-remove';
            remove.dataset.tag = tag;
            remove.setAttribute('aria-label', `Прибрати тег ${tag}`);
            remove.textContent = '×';
            chip.append(remove);
        }
        host.append(chip);
    });
    if (isOwnJournal()) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'day-tag day-tag-add';
        add.dataset.action = 'day-tag-add';
        add.textContent = '+ Додати тег';
        host.append(add);
    }
}

function renderDayStage(dateStr) {
    const day = state.appData?.journal?.[dateStr] || {};
    const dateNode = document.getElementById('day-stage-date');
    if (dateNode) dateNode.textContent = formatLongDate(dateStr);
    const editable = isOwnJournal() && !state.dayDetailsLoading;
    const notes = document.getElementById('day-stage-notes');
    const improvement = document.getElementById('day-stage-improvement');
    if (notes) {
        notes.readOnly = !editable;
        setIdleValue(notes, document.getElementById('trade-notes')?.value ?? day.notes ?? '');
    }
    if (improvement) {
        improvement.readOnly = !editable;
        setIdleValue(improvement, document.getElementById('next-session-improvement')?.value ?? day.nextSessionImprovement ?? '');
    }
    renderCard(dateStr, day);
    renderScores(day);
    renderTrades(dateStr, day);
    renderPrep(dateStr);
    renderTags();
    if (!document.getElementById('day-stage-date-calendar')?.hidden) renderDayDateCalendar();
    void renderTickerScreens(dateStr, day);
}

export function refreshDayTypeScreens(dateStr = state.selectedDateStr) {
    if (!dateStr) return;
    void renderTickerScreens(dateStr, state.appData?.journal?.[dateStr] || {});
}

function placePortraitOverNav(portrait) {
    if (!portrait || portrait.parentElement === document.body) return;
    document.body.appendChild(portrait);
}

const APPEAR_MS = 300;
const hideTimers = new WeakMap();

function revealLayer(element) {
    if (!element) return;
    const pending = hideTimers.get(element);
    if (pending) clearTimeout(pending);
    const entering = element.hidden || element.classList.contains('is-leaving');
    element.hidden = false;
    element.classList.remove('is-leaving');
    if (!entering) {
        element.classList.remove('is-appearing');
        return;
    }
    element.classList.add('is-appearing');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!element.isConnected || element.classList.contains('is-leaving')) return;
            element.classList.remove('is-appearing');
        });
    });
}

function concealLayer(element) {
    if (!element || element.hidden || element.classList.contains('is-leaving')) return;
    element.classList.remove('is-appearing');
    element.classList.add('is-leaving');
    const timer = setTimeout(() => {
        if (!element.classList.contains('is-leaving')) return;
        element.hidden = true;
        element.classList.remove('is-leaving');
        if (element.id === 'day-stage') resetTilt(element);
    }, APPEAR_MS);
    hideTimers.set(element, timer);
}

function applyVisibility(options = {}) {
    const page = document.getElementById('view-calendar');
    const stage = document.getElementById('day-stage');
    const portrait = document.getElementById('day-portrait');
    if (!page || !stage) return;
    const open = stageShouldShow(options);
    page.classList.toggle('day-stage-open', open);
    document.body.classList.toggle('day-stage-open', open);
    if (portrait) {
        placePortraitOverNav(portrait);
        if (open && window.innerWidth > 1024) revealLayer(portrait);
        else concealLayer(portrait);
    }
    if (open) {
        revealLayer(stage);
        renderDayStage(state.selectedDateStr);
    } else concealLayer(stage);
}

export function syncDayExtras(dateStr) {
    const day = state.appData?.journal?.[dateStr] || {};
    const scores = day.dayScores && typeof day.dayScores === 'object' ? day.dayScores : {};
    SCORES.forEach((field) => {
        const value = Number(scores[field.key]);
        writeHidden(field.id, Number.isFinite(value) && value >= 1 && value <= 10 ? Math.round(value) : '', false);
    });
    const grade = String(day.dayGrade || '').trim().toUpperCase();
    writeHidden('day-grade', GRADES.includes(grade) ? grade : '', false);
    const tags = Array.isArray(day.dayTags) ? day.dayTags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 16) : [];
    writeHidden('day-tags-json', JSON.stringify(tags), false);
    renderTags();
}

export function setDayGrade(grade) {
    const letter = String(grade || '').trim().toUpperCase();
    if (!GRADES.includes(letter) || !isOwnJournal()) return;
    writeHidden('day-grade', letter, true);
    const menu = document.getElementById('day-grade-menu');
    if (menu) menu.hidden = true;
    if (stageShouldShow()) renderCard(state.selectedDateStr, state.appData?.journal?.[state.selectedDateStr] || {});
}

export async function addDayTag() {
    if (!isOwnJournal()) return;
    const name = await showPrompt('Назва тега');
    const tag = String(name || '').trim();
    if (!tag) return;
    const tags = readTags();
    if (tags.some((item) => item.toLowerCase() === tag.toLowerCase())) return;
    writeTags([...tags, tag], true);
}

export function removeDayTag(tag) {
    if (!isOwnJournal()) return;
    writeTags(readTags().filter((item) => item !== tag), true);
}

export async function addPrepItem() {
    if (!isOwnJournal()) return;
    const name = await showPrompt('Назва пункту підготовки');
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    if (!state.appData.settings) state.appData.settings = {};
    if (!Array.isArray(state.appData.settings.checklist)) state.appData.settings.checklist = [];
    state.appData.settings.checklist.push({ id: `chk_${Date.now()}`, name: trimmed });
    window.renderChecklistDisplay?.();
    renderPrep(state.selectedDateStr);
    try {
        await saveSettings();
        showToast('Пункт додано');
    } catch (error) {
        showToast('Не вдалося зберегти пункт');
        console.error(error);
    }
}

export function openDayStage(options = {}) {
    ensureBound();
    stageWanted = true;
    applyVisibility(options);
}

export function closeDayStage() {
    stageWanted = false;
    applyVisibility();
}

export function refreshDayStage() {
    if (!stageShouldShow()) return;
    ensureBound();
    renderDayStage(state.selectedDateStr);
}

export function onDayFormVisibilityChanged() {
    if (window.innerWidth > 1024 && !isDayFormOpen()) stageWanted = false;
    applyVisibility();
}
