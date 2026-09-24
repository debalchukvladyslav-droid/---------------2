import { fetchWithSession } from './authenticated_fetch.js';
import { formatEtClock, needlePoint, nextLivePollDelay } from '../lib/aggressiveness_core.js';

const CACHE_KEY = 'pj:market-aggressiveness:last-valid:v1';
const FACE_KEY = 'pj:market-gauge-face:v1';
const TONES = ['minimal', 'cautious', 'neutral', 'aggressive', 'maximal'];
let pendingRequest = null;
let pollTimer = 0;
let refillTimer = 0;
let refillAttempts = 0;
let shownPayload = null;

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '';
}

function setNeedle(score) {
    const value = Math.max(0, Math.min(100, Number(score) || 0));
    const face = document.getElementById('market-aggressiveness-face');
    if (face) face.style.setProperty('--market-score', String(value));
    const indicator = document.getElementById('market-aggressiveness-indicator');
    if (!indicator) return;
    const point = needlePoint(value);
    indicator.setAttribute('cx', point.cx.toFixed(1));
    indicator.setAttribute('cy', point.cy.toFixed(1));
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
        localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
        /* private mode */
    }
}

function formatDelta(delta) {
    const value = Number(delta);
    if (!Number.isFinite(value)) return '';
    if (Math.abs(value) < 0.05) return 'без змін';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatSigned(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    const rounded = digits ? number.toFixed(digits) : String(Math.round(number));
    return `${number > 0 ? '+' : ''}${rounded}`;
}

const openRows = new Set();
let historyDays = 14;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DRILL = {
    microSmall: [
        ['iwm5', 'IWM проти SPY, 5 днів'],
        ['iwm10', 'IWM проти SPY, 10 днів'],
        ['iwc5', 'IWC проти SPY, 5 днів'],
        ['iwc10', 'IWC проти SPY, 10 днів'],
    ],
    speculative: [
        ['xbi5', 'XBI проти SPY, 5 днів'],
        ['xbi10', 'XBI проти SPY, 10 днів'],
        ['arkk5', 'ARKK проти SPY, 5 днів'],
        ['arkk10', 'ARKK проти SPY, 10 днів'],
    ],
};

function finiteText(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : String(Math.round(Number(value)));
}

function ledgerValue(value, { negate = false, digits = 0 } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    const shown = negate ? -number : number;
    if (!digits) return String(Math.round(shown));
    const text = shown.toFixed(digits);
    return shown > 0 ? `+${text}` : text;
}

function ledgerLine(label, value, { button = false, rowKey = '' } = {}) {
    const line = document.createElement(button ? 'button' : 'div');
    line.className = 'aggressiveness-ledger-line';
    if (button) {
        line.type = 'button';
        line.dataset.action = 'aggressiveness-row';
        line.dataset.row = rowKey;
        line.setAttribute('aria-expanded', openRows.has(rowKey) ? 'true' : 'false');
    }
    const name = document.createElement('span');
    name.textContent = label;
    const amount = document.createElement('b');
    amount.textContent = value;
    line.append(name, amount);
    return line;
}

function drillList(key, detail) {
    const list = document.createElement('div');
    list.className = 'aggressiveness-ledger-drill';
    (DRILL[key] || []).forEach(([field, label]) => {
        const item = detail?.[field];
        const line = document.createElement('div');
        const name = document.createElement('span');
        name.textContent = label;
        const amount = document.createElement('b');
        if (item?.value == null) amount.textContent = 'немає даних';
        else if (item.method === 'percentile') amount.textContent = `${Math.round(item.value)} зі 100`;
        else amount.textContent = `${Math.round(item.value)} зі 100 · мало історії`;
        line.append(name, amount);
        list.append(line);
    });
    return list;
}

function ledgerRow(label, value, { child = false, total = false, rowKey = '', detail = null, hint = '' } = {}) {
    const row = document.createElement('div');
    row.className = 'aggressiveness-ledger-row';
    if (child) row.classList.add('is-child');
    if (total) row.classList.add('is-total');
    if (rowKey && openRows.has(rowKey)) row.classList.add('is-open');
    row.append(ledgerLine(label, value, { button: Boolean(rowKey), rowKey }));
    if (hint) {
        const note = document.createElement('p');
        note.className = 'aggressiveness-ledger-hint';
        note.textContent = hint;
        row.append(note);
    }
    if (rowKey) row.append(drillList(rowKey, detail));
    return row;
}

function shortDate(iso) {
    return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function svgEl(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
}

function progressionChart(points) {
    const width = 720;
    const height = 228;
    const pad = { left: 44, right: 28, top: 26, bottom: 32 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
    const last = [...points].reverse().find((point) => point.score != null);
    svg.setAttribute('aria-label', last ? `Агресивність за ${points.length} днів, сьогодні ${last.score}` : 'Прогресія агресивності');
    [0, 20, 40, 60, 80, 100].forEach((level) => {
        const y = pad.top + (1 - level / 100) * innerH;
        svg.append(svgEl('line', { x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: 'aggressiveness-chart-grid' }));
        const label = svgEl('text', { x: pad.left - 8, y: y + 4, class: 'aggressiveness-chart-axis' });
        label.textContent = String(level);
        svg.append(label);
    });
    const xAt = (index) => pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
    const yAt = (score) => pad.top + (1 - score / 100) * innerH;
    let run = [];
    const flush = () => {
        if (run.length < 2) {
            run = [];
            return;
        }
        svg.append(svgEl('polyline', {
            points: run.map((point) => `${xAt(point.index)},${yAt(point.score)}`).join(' '),
            class: 'aggressiveness-chart-line',
        }));
        run = [];
    };
    points.forEach((point, index) => {
        if (point.score == null) flush();
        else run.push({ ...point, index });
    });
    flush();
    points.forEach((point, index) => {
        if (point.score == null) return;
        const cx = xAt(index);
        const cy = yAt(point.score);
        const dot = svgEl('circle', {
            cx, cy, r: index === points.length - 1 ? 4.5 : 3,
            class: index === points.length - 1 ? 'aggressiveness-chart-dot is-last' : 'aggressiveness-chart-dot',
        });
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `${shortDate(point.date)} · ${point.score}${point.label ? ` · ${point.label}` : ''}`;
        dot.append(title);
        svg.append(dot);
        const edge = index === 0 || index === points.length - 1;
        if (points.length <= 8 || edge) {
            const value = svgEl('text', {
                x: index === 0 ? cx + 8 : (index === points.length - 1 ? cx - 8 : cx),
                y: Math.max(16, cy - 9),
                class: 'aggressiveness-chart-value',
            });
            value.setAttribute('text-anchor', index === 0 ? 'start' : (index === points.length - 1 ? 'end' : 'middle'));
            value.textContent = String(point.score);
            svg.append(value);
        }
        if (points.length <= 8 || edge || index % 2 === 0) {
            const date = svgEl('text', { x: cx, y: height - 8, class: 'aggressiveness-chart-date' });
            date.setAttribute('text-anchor', index === 0 ? 'start' : (index === points.length - 1 ? 'end' : 'middle'));
            date.textContent = shortDate(point.date);
            svg.append(date);
        }
    });
    return svg;
}

function renderProgression(payload) {
    const history = Array.isArray(payload?.history) ? payload.history.filter((point) => point?.date) : [];
    if (history.length < 2) return null;
    const days = historyDays === 7 ? 7 : 14;
    const points = history.slice(-days);
    const block = document.createElement('section');
    block.className = 'aggressiveness-chart-block';
    const head = document.createElement('div');
    head.className = 'aggressiveness-chart-head';
    const title = document.createElement('span');
    title.textContent = 'Як змінювалась оцінка';
    const switches = document.createElement('div');
    switches.className = 'aggressiveness-range';
    [7, 14].forEach((count) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'aggressiveness-range';
        button.dataset.days = String(count);
        button.textContent = `${count} днів`;
        button.setAttribute('aria-pressed', days === count ? 'true' : 'false');
        switches.append(button);
    });
    head.append(title, switches);
    const frame = document.createElement('div');
    frame.className = 'aggressiveness-chart';
    frame.append(progressionChart(points));
    block.append(head, frame);
    return block;
}

function renderDetails(payload) {
    shownPayload = payload;
    const host = document.getElementById('aggressiveness-info-body');
    if (!host) return;
    const components = payload?.components || {};
    const detail = components.detail || {};
    host.replaceChildren();

    const lead = document.createElement('p');
    lead.className = 'aggressiveness-info-lead';
    lead.textContent = 'Оцінка на сьогодні: наскільки ринок зручний для механічних шортів. Число зверху — підсумок. Нижче видно, з чого він склався: база до вчорашнього закриття, мінус штрафи, плюс сьогоднішній рух.';
    host.append(lead);

    if (payload?.incomplete) {
        const note = document.createElement('p');
        note.className = 'aggressiveness-info-note';
        const waiting = refillAttempts > 0 && refillAttempts < 3;
        note.textContent = waiting
            ? 'Частину серій ще довантажую. За хвилину оцінка оновиться сама.'
            : (payload?.message || 'Data incomplete');
        host.append(note);
    }

    const hero = document.createElement('div');
    hero.className = 'aggressiveness-hero';
    const score = document.createElement('strong');
    score.textContent = finiteText(payload?.displayScore);
    const status = document.createElement('span');
    status.textContent = payload?.label || '—';
    const confidence = document.createElement('em');
    const confidenceValue = Number(payload?.confidence);
    confidence.textContent = Number.isFinite(confidenceValue)
        ? `Дані на ${Math.round(confidenceValue)}%. Це не змінює оцінку, лише показує, чи вистачає історії.`
        : 'Повноту даних ще не пораховано.';
    hero.append(score, status, confidence);
    host.append(hero);

    const scale = document.createElement('p');
    scale.className = 'aggressiveness-info-lead';
    scale.textContent = '0–19 майже не чіпати · 20–39 обережно · 40–59 звичайний день · 60–79 можна агресивніше · 80–100 найзручніший режим.';
    host.append(scale);
    const chart = renderProgression(payload);
    if (chart) host.append(chart);

    const list = document.createElement('div');
    list.className = 'aggressiveness-ledger';
    list.append(ledgerRow('База', finiteText(payload?.baseScore), {
        hint: 'Усе, що відомо до вчорашнього закриття. З цього числа починається підсумок.',
    }));
    list.append(ledgerRow('Дрібні акції', finiteText(components.microSmall), {
        child: true,
        rowKey: 'microSmall',
        detail,
        hint: 'IWM і IWC проти SPY. Натисни рядок: побачиш, де дрібні були за останні 5 і 10 днів. 0 — у хвості, 100 — серед найсильніших.',
    }));
    list.append(ledgerRow('Спекулятивні', finiteText(components.speculative), {
        child: true,
        rowKey: 'speculative',
        detail,
        hint: 'XBI і ARKK проти SPY. Те саме порівняння, але для історій, де живуть pump and dump.',
    }));
    list.append(ledgerRow('Широкий ринок', finiteText(components.broad), {
        child: true,
        hint: 'Сам SPY. Дивиться, чи індекс іде рівно, без різкого падіння або перегріву.',
    }));
    list.append(ledgerRow('Стрес', finiteText(components.stress), {
        child: true,
        hint: 'VIX, ставки і нафта. 100 означає лише одне: штрафу за стрес немає. Це не знак, що ринок хороший.',
    }));
    list.append(ledgerRow('Вузьке лідерство', ledgerValue(components.narrowPenalty, { negate: true }), {
        hint: 'Штраф, якщо Nasdaq або чіпи тягнуть ринок, а дрібні стоять. Самі по собі QQQ і SMH балів не додають.',
    }));
    list.append(ledgerRow('Перегрів', ledgerValue(components.meltUpPenalty, { negate: true }), {
        hint: 'Ще один штраф, якщо індекс уже сильно виріс, волатильність тиха, а дрібні це не підтверджують.',
    }));
    list.append(ledgerRow('Сьогодні', formatSigned(components.liveAdjustment ?? payload?.liveAdjustment, 1), {
        hint: 'Рух SPY, QQQ і IWM сьогодні. З 4:00 до 9:30 — від учорашнього закриття, після 9:30 — від відкриття. О 11:40 цифра заморожується.',
    }));
    list.append(ledgerRow('Разом', finiteText(payload?.displayScore), {
        total: true,
        hint: 'База мінус два штрафи плюс сьогоднішнє коригування. Саме це число стоїть на шкалі.',
    }));
    host.append(list);

    const updated = document.createElement('p');
    updated.className = 'aggressiveness-info-note';
    updated.textContent = `Оновлено ${formatEtClock(payload?.updatedAt) || '—'}`;
    host.append(updated);

    if (payload?.missing?.length) {
        const missing = document.createElement('p');
        missing.className = 'aggressiveness-info-note';
        missing.textContent = `Немає даних: ${payload.missing.join(', ')}`;
        host.append(missing);
    }
}

export function setAggressivenessRange(days) {
    const next = Number(days) === 7 ? 7 : 14;
    if (next === historyDays) return;
    historyDays = next;
    if (shownPayload) renderDetails(shownPayload);
}

export function toggleAggressivenessRow(key) {
    if (!key) return;
    if (openRows.has(key)) openRows.delete(key);
    else openRows.add(key);
    if (shownPayload) renderDetails(shownPayload);
}

function applyTone(tone, incomplete) {
    const face = document.getElementById('market-aggressiveness-face');
    if (!face) return;
    TONES.forEach((name) => face.classList.remove(`market-gauge-face--${name}`));
    face.classList.toggle('is-incomplete', Boolean(incomplete));
    if (!incomplete && tone) face.classList.add(`market-gauge-face--${tone}`);
}

function renderPayload(payload, { incomplete = false } = {}) {
    const score = payload?.displayScore;
    const hasScore = score != null && Number.isFinite(Number(score));
    setText('market-aggressiveness-score', hasScore ? String(Math.round(score)) : '—');
    setText('market-aggressiveness-label', incomplete ? 'Data incomplete' : (payload?.label || ''));
    const confidence = Number(payload?.confidence);
    setText('market-aggressiveness-confidence', Number.isFinite(confidence) ? `Впевненість ${Math.round(confidence)}%` : '');
    setText('market-aggressiveness-delta', formatDelta(payload?.delta));
    setText('market-aggressiveness-updated', formatEtClock(payload?.updatedAt));
    setNeedle(hasScore ? score : 0);
    applyTone(payload?.tone, incomplete || !hasScore);
    renderDetails(payload);
}

function readStoredFace() {
    try {
        return localStorage.getItem(FACE_KEY) === 'aggressiveness' ? 'aggressiveness' : 'sentiment';
    } catch {
        return 'sentiment';
    }
}

function rememberGaugeFace(flipped) {
    try {
        localStorage.setItem(FACE_KEY, flipped ? 'aggressiveness' : 'sentiment');
    } catch {
        /* private mode */
    }
}

export function applyStoredGaugeFace() {
    const shell = document.getElementById('market-sentiment-card');
    if (!shell) return;
    const flipped = readStoredFace() === 'aggressiveness';
    shell.classList.toggle('is-flipped', flipped);
    shell.dataset.gaugeFace = flipped ? 'aggressiveness' : 'sentiment';
    const flip = shell.querySelector('.market-gauge-flip');
    if (flip) flip.setAttribute('aria-label', flipped ? 'Перемкнути на настрій ринку' : 'Перемкнути на індикатор агресивності');
}

export function flipMarketGauge() {
    const shell = document.getElementById('market-sentiment-card');
    if (!shell) return;
    const flipped = shell.classList.toggle('is-flipped');
    shell.dataset.gaugeFace = flipped ? 'aggressiveness' : 'sentiment';
    rememberGaugeFace(flipped);
    if (!flipped) closeAggressivenessInfo();
    const flip = shell.querySelector('.market-gauge-flip');
    if (flip) flip.setAttribute('aria-label', flipped ? 'Перемкнути на настрій ринку' : 'Перемкнути на індикатор агресивності');
    syncDetailsButton(shell);
}

function syncDetailsButton(shell = document.getElementById('market-sentiment-card')) {
    const info = shell?.querySelector('.market-gauge-info');
    if (!info) return;
    const open = document.getElementById('aggressiveness-info-modal')?.style.display === 'flex';
    info.setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function openAggressivenessInfo() {
    const modal = document.getElementById('aggressiveness-info-modal');
    const shell = document.getElementById('market-sentiment-card');
    if (!modal) return;
    if (shownPayload) renderDetails(shownPayload);
    if (shell) {
        shell.classList.add('is-flipped');
        shell.dataset.gaugeFace = 'aggressiveness';
        const flip = shell.querySelector('.market-gauge-flip');
        if (flip) flip.setAttribute('aria-label', 'Перемкнути на настрій ринку');
        rememberGaugeFace(true);
    }
    modal.style.display = 'flex';
    syncDetailsButton(shell);
    modal.querySelector('[data-action="aggressiveness-info-close"]')?.focus();
}

export function closeAggressivenessInfo() {
    const modal = document.getElementById('aggressiveness-info-modal');
    if (modal) modal.style.display = 'none';
    syncDetailsButton();
}

export function toggleAggressivenessDetails() {
    const modal = document.getElementById('aggressiveness-info-modal');
    if (modal?.style.display === 'flex') closeAggressivenessInfo();
    else openAggressivenessInfo();
}

async function fetchAggressiveness(force) {
    const response = await fetchWithSession(`/api/aggressiveness${force ? '?fresh=1' : ''}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 200) {
        throw new Error(data?.message || `Aggressiveness API ${response.status}`);
    }
    return data;
}

export async function renderMarketAggressiveness(options = {}) {
    const face = document.getElementById('market-aggressiveness-face');
    if (!face) return;
    applyStoredGaugeFace();
    const force = Boolean(options.force);
    if (!pendingRequest || force) pendingRequest = fetchAggressiveness(force);
    const request = pendingRequest;
    try {
        const payload = await request;
        if (payload?.incomplete) {
            const last = payload.lastValid || readCache();
            const view = last ? {
                ...last,
                incomplete: true,
                missing: payload.missing || last.missing || [],
                providerMissing: payload.providerMissing || [],
                message: 'Data incomplete',
            } : { ...payload, label: 'Data incomplete' };
            scheduleRefill(payload);
            renderPayload(view, { incomplete: true });
        } else {
            refillAttempts = 0;
            writeCache(payload);
            renderPayload(payload);
        }
    } catch (error) {
        const last = readCache();
        renderPayload(last ? { ...last, incomplete: true, missing: [error.message] } : {
            incomplete: true,
            message: 'Data incomplete',
            label: 'Data incomplete',
        }, { incomplete: true });
    } finally {
        if (pendingRequest === request) pendingRequest = null;
        armPoll();
    }
}

function scheduleRefill(payload) {
    const missing = payload?.missing?.length || payload?.providerMissing?.length;
    if (!missing || refillAttempts >= 2) return;
    refillAttempts += 1;
    clearTimeout(refillTimer);
    refillTimer = setTimeout(() => {
        void renderMarketAggressiveness({ force: true });
    }, 65000);
}

function armPoll() {
    clearTimeout(pollTimer);
    const delay = nextLivePollDelay(new Date());
    if (delay == null) return;
    pollTimer = setTimeout(() => {
        void renderMarketAggressiveness({ force: true });
    }, delay);
}

export function bindMarketGaugeKeys() {
    const shell = document.getElementById('market-sentiment-card');
    if (!shell || shell.dataset.keysBound === '1') return;
    shell.dataset.keysBound = '1';
    shell.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        flipMarketGauge();
    });
}
