import { fetchWithSession } from './authenticated_fetch.js';
import { formatEtClock, needlePoint, nextLivePollDelay } from '../lib/aggressiveness_core.js';

const CACHE_KEY = 'pj:market-aggressiveness:last-valid:v1';
const TONES = ['minimal', 'cautious', 'neutral', 'aggressive', 'maximal'];
let pendingRequest = null;
let pollTimer = 0;

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

function renderDetails(payload) {
    const host = document.getElementById('market-aggressiveness-details');
    if (!host) return;
    const components = payload?.components || {};
    const rows = [
        ['Micro/Small', Math.round(components.microSmall)],
        ['Speculative', Math.round(components.speculative)],
        ['Broad market', Math.round(components.broad)],
        ['Stress safety', Math.round(components.stress)],
        ['Narrow penalty', `-${Math.round(components.narrowPenalty || 0)}`],
        ['Live adjustment', formatSigned(components.liveAdjustment ?? payload?.liveAdjustment, 1)],
        ['Base', Math.round(payload?.baseScore)],
        ['Live', Math.round(payload?.liveScore)],
        ['Last updated', formatEtClock(payload?.updatedAt)],
    ];
    host.replaceChildren();
    const intro = document.createElement('p');
    intro.textContent = 'Наскільки режим сприятливий для механічних pump&dump short. Лише дані до вчорашнього close: IWM/IWC, XBI/ARKK, SPY, VIX, US10Y, нафта. QQQ і SMH лише як штраф за вузьке лідерство.';
    host.append(intro);
    if (payload?.incomplete) {
        const note = document.createElement('span');
        note.textContent = 'Data incomplete';
        host.append(note);
    }
    rows.forEach(([label, value]) => {
        const line = document.createElement('span');
        const name = document.createElement('span');
        name.textContent = `${label}: `;
        const strong = document.createElement('strong');
        strong.textContent = value == null || value === 'NaN' ? '—' : String(value);
        line.append(name, strong);
        host.append(line);
    });
    if (payload?.missing?.length) {
        const missing = document.createElement('span');
        missing.textContent = `Missing: ${payload.missing.join(', ')}`;
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
    if (!flipped) shell.classList.remove('is-details-open');
    const flip = shell.querySelector('.market-gauge-flip');
    if (flip) flip.setAttribute('aria-label', flipped ? 'Перемкнути на настрій ринку' : 'Перемкнути на індикатор агресивності');
    syncDetailsButton(shell);
}

function syncDetailsButton(shell) {
    const info = shell.querySelector('.market-gauge-info');
    if (info) info.setAttribute('aria-expanded', shell.classList.contains('is-details-open') ? 'true' : 'false');
}

export function toggleAggressivenessDetails() {
    const shell = document.getElementById('market-sentiment-card');
    if (!shell) return;
    shell.classList.add('is-flipped');
    shell.dataset.gaugeFace = 'aggressiveness';
    shell.classList.toggle('is-details-open');
    syncDetailsButton(shell);
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
