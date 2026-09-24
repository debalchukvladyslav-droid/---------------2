import { fetchWithSession } from './authenticated_fetch.js';
import { formatEtClock, needlePoint, nextLivePollDelay } from '../lib/aggressiveness_core.js';

const CACHE_KEY = 'pj:market-aggressiveness:last-valid:v1';
const TONES = ['minimal', 'cautious', 'neutral', 'aggressive', 'maximal'];
let pendingRequest = null;
let pollTimer = 0;
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

const WATCH_ROWS = [
    ['Micro / Small · 35%', 'IWM і IWC проти SPY за 5 і 10 днів. Це головна ознака, що рух є і в дрібних іменах.', 'microSmall'],
    ['Speculative · 25%', 'XBI і ARKK: апетит до спекулятивних історій, де живуть pump&dump.', 'speculative'],
    ['Broad market · 15%', 'Шлях SPY і його короткострокова волатильність.', 'broad'],
    ['Stress safety · 25%', 'VIX, дохідність US10Y і нафта. Стрес знижує оцінку.', 'stress'],
];

function detailCard(title, text, value) {
    const card = document.createElement('article');
    card.className = 'aggressiveness-info-item';
    const top = document.createElement('div');
    top.className = 'aggressiveness-info-item-top';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const score = document.createElement('b');
    score.textContent = value == null || value === 'NaN' ? '—' : String(value);
    top.append(heading, score);
    const copy = document.createElement('p');
    copy.textContent = text;
    card.append(top, copy);
    return card;
}

function renderDetails(payload) {
    shownPayload = payload;
    const host = document.getElementById('aggressiveness-info-body');
    if (!host) return;
    const components = payload?.components || {};
    host.replaceChildren();

    const lead = document.createElement('p');
    lead.className = 'aggressiveness-info-lead';
    lead.textContent = 'Наскільки режим сприятливий для механічних pump&dump short. Сесія бере лише дані до вчорашнього close. QQQ і SMH самі оцінку не піднімають: вони лише штраф, якщо лідерство вузьке.';
    host.append(lead);

    if (payload?.incomplete) {
        const note = document.createElement('p');
        note.className = 'aggressiveness-info-note';
        note.textContent = payload?.message || 'Data incomplete';
        host.append(note);
    }

    const summary = document.createElement('div');
    summary.className = 'aggressiveness-info-summary';
    [
        ['Оцінка', Number.isFinite(Number(payload?.displayScore)) ? String(Math.round(payload.displayScore)) : '—'],
        ['Статус', payload?.label || '—'],
        ['Base', Number.isFinite(Number(payload?.baseScore)) ? String(Math.round(payload.baseScore)) : '—'],
        ['Оновлено', formatEtClock(payload?.updatedAt) || '—'],
    ].forEach(([label, value]) => {
        const cell = document.createElement('div');
        const name = document.createElement('span');
        name.textContent = label;
        const strong = document.createElement('strong');
        strong.textContent = value;
        cell.append(name, strong);
        summary.append(cell);
    });
    host.append(summary);

    const list = document.createElement('div');
    list.className = 'aggressiveness-info-list';
    WATCH_ROWS.forEach(([title, text, key]) => {
        const raw = components[key];
        list.append(detailCard(title, text, Number.isFinite(Number(raw)) ? String(Math.round(raw)) : '—'));
    });
    list.append(detailCard(
        'Штраф за вузьке лідерство',
        'QQQ сильніший за IWM, SMH сильніший за IWC, або слабкий XBI. Штраф не більший за 18.',
        `-${Math.round(components.narrowPenalty || 0)}`,
    ));
    list.append(detailCard(
        'Live',
        'Коригування з 09:30 до 11:40 ET, далі значення заморожується. Діапазон від −8 до +8.',
        formatSigned(components.liveAdjustment ?? payload?.liveAdjustment, 1),
    ));
    host.append(list);

    if (payload?.missing?.length) {
        const missing = document.createElement('p');
        missing.className = 'aggressiveness-info-note';
        missing.textContent = `Немає даних: ${payload.missing.join(', ')}`;
        host.append(missing);
    }
}

function applyTone(tone, incomplete) {
    const face = document.getElementById('market-aggressiveness-face');
    if (!face) return;
    TONES.forEach((name) => face.classList.remove(`market-gauge-face--${name}`));
    face.classList.toggle('is-incomplete', Boolean(incomplete));
    if (!incomplete && tone) face.classList.add(`market-gauge-face--${tone}`);
}

function renderPayload(payload, { incomplete = false } = {}) {
    const score = Number(payload?.displayScore);
    const hasScore = Number.isFinite(score);
    setText('market-aggressiveness-score', hasScore ? String(Math.round(score)) : '—');
    setText('market-aggressiveness-label', incomplete ? 'Data incomplete' : (payload?.label || ''));
    setText('market-aggressiveness-delta', formatDelta(payload?.delta));
    setText('market-aggressiveness-updated', formatEtClock(payload?.updatedAt));
    setNeedle(hasScore ? score : 0);
    applyTone(payload?.tone, incomplete || !hasScore);
    renderDetails(payload);
}

export function flipMarketGauge() {
    const shell = document.getElementById('market-sentiment-card');
    if (!shell) return;
    const flipped = shell.classList.toggle('is-flipped');
    shell.dataset.gaugeFace = flipped ? 'aggressiveness' : 'sentiment';
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
    const force = Boolean(options.force);
    if (!pendingRequest || force) pendingRequest = fetchAggressiveness(force);
    const request = pendingRequest;
    try {
        const payload = await request;
        if (payload?.incomplete) {
            const last = payload.lastValid || readCache();
            if (last) {
                renderPayload({
                    ...last,
                    incomplete: true,
                    missing: payload.missing || last.missing || [],
                    message: 'Data incomplete',
                }, { incomplete: true });
            } else {
                renderPayload({ ...payload, label: 'Data incomplete' }, { incomplete: true });
            }
        } else {
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
