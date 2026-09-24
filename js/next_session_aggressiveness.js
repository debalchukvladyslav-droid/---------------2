import { fetchWithSession } from './authenticated_fetch.js';

const CACHE_KEY = 'pj:next-session:last-valid:v1';
export const NEXT_SESSION_UI_ENABLED = false;

function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value == null ? '' : String(value);
}

function readCache() {
    try {
        const payload = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

function writeCache(payload) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            targetDate: payload.targetDate,
            finalScore: payload.finalScore,
            label: payload.label,
            tone: payload.tone,
            regimeState: payload.regimeState,
            confidence: payload.confidence,
            savedAt: new Date().toISOString(),
        }));
    } catch { /* private mode */ }
}

function dayLabel(iso) {
    const parts = String(iso || '').split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}` : '';
}

function signed(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    const text = digits ? number.toFixed(digits) : String(Math.round(number));
    return number > 0 ? `+${text}` : text;
}

function percent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '—';
}

function applyCard(payload) {
    const card = document.getElementById('next-session-card');
    if (!card) return;
    card.classList.remove('is-loading', 'is-incomplete');
    card.dataset.tone = payload.tone || '';
    setText('next-session-date', dayLabel(payload.targetDate));
    setText('next-session-score', payload.finalScore == null ? '—' : String(payload.finalScore));
    setText('next-session-label', payload.label || 'Data incomplete');
    setText('next-session-regime', payload.regimeState || '');
    setText('next-session-confidence', payload.confidence == null ? '' : `Впевненість ${payload.confidence}%`);
    const history = payload.history || [];
    const previous = history.length > 1 ? history[history.length - 2] : null;
    const delta = previous && payload.basePrediction != null ? payload.basePrediction - previous.prediction : null;
    setText('next-session-delta', delta == null ? '' : `${signed(delta)} vs попередній прогноз`);
}

function showIncomplete(message) {
    const card = document.getElementById('next-session-card');
    const cached = readCache();
    if (cached?.finalScore != null) {
        applyCard(cached);
        setText('next-session-label', 'Data incomplete');
        setText('next-session-delta', 'Останній повний прогноз збережено');
        return;
    }
    if (!card) return;
    card.classList.add('is-incomplete');
    card.classList.remove('is-loading');
    setText('next-session-score', '—');
    setText('next-session-label', message || 'Data incomplete');
}

function row(label, value) {
    const line = document.createElement('div');
    line.className = 'next-session-row';
    const name = document.createElement('span');
    name.textContent = label;
    const amount = document.createElement('strong');
    amount.textContent = value;
    line.append(name, amount);
    return line;
}

function svgEl(name, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
}

function chart(history) {
    const rows = (history || []).filter((item) => Number.isFinite(Number(item.prediction)));
    const frame = document.createElement('div');
    frame.className = 'aggressiveness-chart next-session-chart';
    if (rows.length < 2) {
        frame.textContent = 'Історія зʼявиться після кількох сесій.';
        return frame;
    }
    const width = 640;
    const height = 180;
    const pad = { left: 28, right: 36, top: 16, bottom: 28 };
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
    svg.append(svgEl('title', {}));
    svg.lastChild.textContent = 'Прогноз на сесію і фактичний short edge цієї сесії';
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const yOf = (value) => pad.top + (1 - Math.max(0, Math.min(100, value)) / 100) * plotH;
    const xOf = (index) => pad.left + (rows.length === 1 ? plotW / 2 : (index / (rows.length - 1)) * plotW);
    [0, 50, 100].forEach((mark) => {
        svg.append(svgEl('line', {
            x1: pad.left, y1: yOf(mark), x2: width - pad.right, y2: yOf(mark), class: 'aggressiveness-chart-grid',
        }));
    });
    const line = (key, className) => {
        const points = rows.map((item, index) => {
            const value = Number(item[key]);
            return Number.isFinite(value) ? `${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}` : null;
        }).filter(Boolean);
        if (points.length > 1) svg.append(svgEl('polyline', { points: points.join(' '), class: className }));
    };
    line('actual', 'next-session-line next-session-line--actual');
    line('prediction', 'aggressiveness-chart-line');
    rows.forEach((item, index) => {
        if (index !== 0 && index !== rows.length - 1 && index !== Math.floor(rows.length / 2)) return;
        const label = svgEl('text', { x: xOf(index), y: height - 8, class: 'aggressiveness-chart-date' });
        label.textContent = dayLabel(item.targetDate);
        svg.append(label);
    });
    frame.append(svg);
    const legend = document.createElement('p');
    legend.className = 'next-session-legend';
    legend.textContent = 'Лінія прогнозу — оцінка, зроблена на закритті попереднього дня. Друга лінія — фактичний short edge саме цієї дати.';
    frame.append(legend);
    return frame;
}

function renderDetails(payload) {
    const body = document.getElementById('next-session-info-body');
    if (!body) return;
    body.replaceChildren();
    const lagged = payload.lagged || {};
    const transition = payload.transitionDetail || {};
    const blocks = document.createElement('div');
    blocks.className = 'next-session-blocks';
    [
        ['Market Lead', payload.marketLeading],
        ['Lagged Mechanical', payload.laggedMechanical],
        ['Transition', payload.transition],
        ['Base forecast', payload.basePrediction],
        ['Premarket adjustment', signed(payload.premarketAdjustment, 1)],
        ['Final', payload.finalScore],
    ].forEach(([label, value]) => {
        const shown = label === 'Premarket adjustment' ? value : (value == null ? '—' : String(Math.round(Number(value))));
        blocks.append(row(label, shown));
    });
    const facts = document.createElement('div');
    facts.className = 'next-session-blocks';
    [
        ['Yesterday Dump Breadth', percent(lagged.dumpBreadth1)],
        ['3D Dump Breadth', percent(lagged.dumpBreadth3)],
        ['5D Dump Breadth', percent(lagged.dumpBreadth5)],
        ['Fast Edge', transition.fast == null ? '—' : String(Math.round(transition.fast))],
        ['Slow Edge', transition.slow == null ? '—' : String(Math.round(transition.slow))],
        ['Edge Acceleration', signed(transition.acceleration)],
        ['≥2R Rate', percent(lagged.rate2)],
        ['Median Winner', lagged.winnerMedian == null ? '—' : `${signed(lagged.winnerMedian, 1)}R`],
        ['Unique tickers', lagged.uniqueTickers == null ? '—' : String(lagged.uniqueTickers)],
    ].forEach(([label, value]) => facts.append(row(label, value)));
    const copy = document.createElement('p');
    copy.className = 'next-session-copy';
    copy.textContent = payload.explanation || '';
    const note = document.createElement('p');
    note.className = 'next-session-copy';
    note.textContent = payload.mode === 'market-only'
        ? 'Механічних днів ще менше десяти, тому число зараз дорівнює лише ринковому блоку. Впевненість через це нижча.'
        : `Ваги ${payload.scoreVersion}: ринок 50%, офісні результати 25%, прискорення 25%.`;
    body.append(blocks, facts, chart(payload.history), copy, note);
}

export function openNextSessionDetails() {
    const modal = document.getElementById('next-session-info-modal');
    if (!modal || !modal._payload) return;
    renderDetails(modal._payload);
    modal.style.display = 'flex';
}

export function closeNextSessionDetails() {
    const modal = document.getElementById('next-session-info-modal');
    if (modal) modal.style.display = 'none';
}

export async function renderNextSessionAggressiveness() {
    const card = document.getElementById('next-session-card');
    if (!NEXT_SESSION_UI_ENABLED) {
        if (card) card.hidden = true;
        return;
    }
    if (!card) return;
    try {
        const response = await fetchWithSession('/api/aggressiveness?view=next');
        const payload = await response.json().catch(() => ({}));
        const modal = document.getElementById('next-session-info-modal');
        if (!response.ok || payload.complete === false || payload.status === 'incomplete') {
            showIncomplete(payload.message || 'Data incomplete');
            if (modal) modal._payload = { explanation: payload.message || 'Data incomplete', history: payload.history || [] };
            return;
        }
        applyCard(payload);
        writeCache(payload);
        if (modal) modal._payload = payload;
    } catch {
        showIncomplete('Data incomplete');
    }
}
