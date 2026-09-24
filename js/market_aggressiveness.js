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
const DRILL = {
    microSmall: [
        ['iwm5', 'IWM vs SPY 5D'],
        ['iwm10', 'IWM vs SPY 10D'],
        ['iwc5', 'IWC vs SPY 5D'],
        ['iwc10', 'IWC vs SPY 10D'],
    ],
    speculative: [
        ['xbi5', 'XBI vs SPY 5D'],
        ['xbi10', 'XBI vs SPY 10D'],
        ['arkk5', 'ARKK vs SPY 5D'],
        ['arkk10', 'ARKK vs SPY 10D'],
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
        if (item?.value == null) amount.textContent = '—';
        else if (item.method === 'percentile') amount.textContent = `${Math.round(item.value)} percentile`;
        else amount.textContent = `${Math.round(item.value)} · мало історії`;
        line.append(name, amount);
        list.append(line);
    });
    return list;
}

function ledgerRow(label, value, { child = false, total = false, rowKey = '', detail = null } = {}) {
    const row = document.createElement('div');
    row.className = 'aggressiveness-ledger-row';
    if (child) row.classList.add('is-child');
    if (total) row.classList.add('is-total');
    if (rowKey && openRows.has(rowKey)) row.classList.add('is-open');
    row.append(ledgerLine(label, value, { button: Boolean(rowKey), rowKey }));
    if (rowKey) row.append(drillList(rowKey, detail));
    return row;
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
    lead.textContent = 'Агресивність на сьогодні, розрахована з ринкової інформації, доступної до поточного моменту. Base — дані до вчорашнього close. Live — сьогоднішня інформація.';
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
    confidence.textContent = Number.isFinite(confidenceValue) ? `Впевненість ${Math.round(confidenceValue)}%` : 'Впевненість —';
    hero.append(score, status, confidence);
    host.append(hero);

    const list = document.createElement('div');
    list.className = 'aggressiveness-ledger';
    list.append(ledgerRow('Base', finiteText(payload?.baseScore)));
    list.append(ledgerRow('Micro / Small', finiteText(components.microSmall), { child: true, rowKey: 'microSmall', detail }));
    list.append(ledgerRow('Speculative', finiteText(components.speculative), { child: true, rowKey: 'speculative', detail }));
    list.append(ledgerRow('Broad Market', finiteText(components.broad), { child: true }));
    list.append(ledgerRow('Stress Safety', finiteText(components.stress), { child: true }));
    list.append(ledgerRow('Narrow Leadership', ledgerValue(components.narrowPenalty, { negate: true })));
    list.append(ledgerRow('Melt-up', ledgerValue(components.meltUpPenalty, { negate: true })));
    list.append(ledgerRow('Live', formatSigned(components.liveAdjustment ?? payload?.liveAdjustment, 1)));
    list.append(ledgerRow('Final', finiteText(payload?.displayScore), { total: true }));
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
