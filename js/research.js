import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { loadAllMonths, loadJournalRange } from './storage.js';
import { calculatePreMarketVolume } from './polygon_intraday_cache.js';
import { clampResearchPeriod, criteriaPairsFromJournal, groupCriteriaPairs, journalDatesInRange, shiftIsoMonths } from './market_criteria_analysis.js';
import { loadJournalPolygonDay } from './journal_polygon.js';

const RESEARCH_TRADE_TYPES = ['Візуально', 'Синя', 'Зелена', 'Фіолетова'];
const RESEARCH_TYPE_TONES = { Візуально: 'visual', Синя: 'blue', Зелена: 'green', Фіолетова: 'purple' };
let selectedTradeType = '';

function view() {
    return document.getElementById('view-research');
}

function field(name) {
    return view()?.querySelector(`[data-research-${name}]`);
}

function journalEndDate() {
    const dates = Object.keys(state.appData?.journal || {}).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    return dates.at(-1) || new Date().toISOString().slice(0, 10);
}

function presetMonths(from, to) {
    return [1, 3, 6].find((months) => shiftIsoMonths(to, -months) === from) || 0;
}

function markPreset(months) {
    view()?.querySelectorAll('[data-action="research-preset"]').forEach((button) => {
        button.classList.toggle('is-active', Number(button.dataset.months) === months);
    });
}

function applyClamp(edited) {
    const fromInput = field('from');
    const toInput = field('to');
    const next = clampResearchPeriod(fromInput?.value || '', toInput?.value || '', edited);
    if (next.invalid) return next;
    if (fromInput) fromInput.value = next.from;
    if (toInput) toInput.value = next.to;
    const note = field('note');
    if (note) {
        note.textContent = next.limited
            ? 'Період скорочено до 6 місяців.'
            : 'Можна обрати до 6 місяців. Довантаження потрібне лише для угод без критеріїв.';
    }
    markPreset(presetMonths(next.from, next.to));
    return next;
}

export function openResearchView() {
    const root = view();
    if (!root) return;
    const fromInput = field('from');
    const toInput = field('to');
    if (fromInput && toInput && !fromInput.value) {
        const end = toInput.value || journalEndDate();
        const next = clampResearchPeriod(shiftIsoMonths(end, -3), end, 'from');
        fromInput.value = next.from;
        toInput.value = next.to;
        markPreset(3);
    }
    markTradeType();
    if (root.dataset.periodBound === 'true') return;
    root.dataset.periodBound = 'true';
    root.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.matches('[data-research-from]')) applyClamp('from');
        if (target.matches('[data-research-to]')) applyClamp('to');
    });
}

export function applyResearchPreset(months) {
    const toInput = field('to');
    const end = toInput?.value || journalEndDate();
    const next = clampResearchPeriod(shiftIsoMonths(end, -Number(months)), end, 'from');
    const fromInput = field('from');
    if (fromInput) fromInput.value = next.from;
    if (toInput) toInput.value = next.to;
    markPreset(Number(months));
    const note = field('note');
    if (note) note.textContent = `Обрано ${months} міс. Натисніть «Показати», щоб побачити результат.`;
}

async function ensureJournal(from, to) {
    const nick = state.CURRENT_VIEWED_USER || state.USER_DOC_NAME;
    const userId = state.currentViewedUserId || state.myUserId;
    if (from && to) await loadJournalRange(nick, from, to, userId);
    else await loadAllMonths(nick, userId);
}

function readPeriod() {
    const next = applyClamp('to');
    if (!next || next.invalid) throw new Error('Оберіть дату початку і дату кінця');
    return { ...next, label: `${next.from} — ${next.to}` };
}

function selectedTypeLabel() {
    return selectedTradeType ? `для типу «${selectedTradeType}»` : 'по всіх типах';
}

function markTradeType() {
    const root = view();
    root?.querySelectorAll('[data-action="research-trade-type"]').forEach((button) => {
        const active = (button.dataset.tradeType || '') === selectedTradeType;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const panel = root?.querySelector('.research-results');
    panel?.classList.remove('is-type-visual', 'is-type-blue', 'is-type-green', 'is-type-purple');
    const tone = RESEARCH_TYPE_TONES[selectedTradeType];
    if (tone) panel?.classList.add(`is-type-${tone}`);
    const label = field('type-label');
    if (label) label.textContent = selectedTypeLabel();
}

export function selectResearchTradeType(type = '') {
    selectedTradeType = RESEARCH_TRADE_TYPES.includes(type) ? type : '';
    markTradeType();
    if (view()?.dataset.researchReady === '1') void renderPeriod(field('from')?.value || '', field('to')?.value || '');
}

async function renderPeriod(from, to) {
    const dates = journalDatesInRange(state.appData?.journal || {}, from, to);
    const { renderMarketCriteriaAnalysis } = await import('./stats.js');
    renderMarketCriteriaAnalysis(state.appData.journal || {}, dates, selectedTradeType);
    return dates.size;
}

export async function showResearch() {
    const status = field('status');
    const button = view()?.querySelector('[data-action="research-show"]');
    if (button) button.disabled = true;
    if (status) status.textContent = 'Завантажую угоди вибраного періоду…';
    try {
        const period = readPeriod();
        await ensureJournal(period.from, period.to);
        view().dataset.researchReady = '1';
        await renderPeriod(period.from, period.to);
        const pairs = criteriaPairsFromJournal(state.appData.journal, { from: period.from, to: period.to });
        const ready = pairs.filter((pair) => pair.loaded).length;
        if (status) {
            status.textContent = pairs.length
                ? `Період ${period.label}, ${selectedTypeLabel()}: критерії є для ${ready} із ${pairs.length} пар.`
                : `У періоді ${period.label} немає угод із тікером.`;
        }
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
    } finally {
        if (button) button.disabled = false;
    }
}

function rememberCriteria(date, ticker, metrics) {
    const day = state.appData.journal?.[date];
    if (!day || !metrics) return;
    day.tradePolygons = { ...(day.tradePolygons || {}), [ticker]: metrics };
    (day.trades || []).forEach((trade) => {
        if (String(trade?.symbol || trade?.ticker || '').trim().toUpperCase() === ticker) trade.marketCriteria = metrics;
    });
}

async function loadCriteriaDayBars(pair, token) {
    if (!pair.entryMinutes.length) return [];
    const loaded = await loadJournalPolygonDay(pair.ticker, pair.date, token, { to: '12:01:00' });
    return loaded.bars;
}

async function volPreByDateForPairs(pairs, token) {
    const volPreByDate = {};
    await Promise.all(pairs.map(async (pair) => {
        if (!pair.entryMinutes.length) return;
        try {
            const bars = await loadCriteriaDayBars(pair, token);
            const volumes = Object.fromEntries(pair.entryMinutes.map((minute) => [String(minute), calculatePreMarketVolume(bars, minute)]).filter(([, value]) => value !== null));
            if (Object.keys(volumes).length) volPreByDate[pair.date] = volumes;
        } catch (error) {
            console.warn('[Research criteria bars]', pair.ticker, pair.date, error);
        }
    }));
    return volPreByDate;
}

async function mapPool(items, limit, worker) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) await worker(queue.shift());
    }));
}

export async function loadResearchCriteria() {
    const status = field('status');
    const progress = field('progress');
    const button = view()?.querySelector('[data-action="research-load"]');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (progress) progress.hidden = false;
    try {
        const period = readPeriod();
        if (status) status.textContent = `Завантажую угоди за ${period.label}…`;
        await ensureJournal(period.from, period.to);
        view().dataset.researchReady = '1';
        const all = criteriaPairsFromJournal(state.appData.journal, { from: period.from, to: period.to });
        const pending = all.filter((pair) => !pair.loaded);
        const groups = groupCriteriaPairs(pending);
        if (progress) {
            progress.max = Math.max(1, pending.length);
            progress.value = 0;
        }
        if (!pending.length) {
            if (progress) progress.value = 1;
            if (status) {
                status.textContent = all.length
                    ? `У періоді ${period.label} критерії вже є для всіх ${all.length} пар.`
                    : `У періоді ${period.label} немає угод із тікером.`;
            }
            await renderPeriod(period.from, period.to);
            return;
        }
        const { data: { session } = {} } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
        let done = 0;
        let failed = 0;
        let finished = 0;
        await mapPool(groups, 2, async (group) => {
            if (status) status.textContent = `${group.ticker}: ${group.pairs.length} дат · тікер ${finished + 1} із ${groups.length}`;
            try {
                const volPreByDate = await volPreByDateForPairs(group.pairs, session.access_token);
                const response = await fetch('/api/trade-polygons', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker: group.ticker, dates: group.pairs.map((pair) => pair.date), volPreByDate }),
                });
                const payload = await response.json().catch(() => ({}));
                const results = Array.isArray(payload.results) ? payload.results : [];
                if (!response.ok && !results.some((item) => item.ok)) throw new Error(payload.error || `HTTP ${response.status}`);
                const savedDates = new Set();
                results.forEach((item) => {
                    if (!item?.ok || !item.metrics) return;
                    rememberCriteria(item.date, group.ticker, item.metrics);
                    savedDates.add(item.date);
                    done += 1;
                });
                failed += group.pairs.length - savedDates.size;
            } catch (error) {
                failed += group.pairs.length;
                console.warn('[Research criteria]', group.ticker, error);
            }
            finished += 1;
            if (progress) progress.value = done + failed;
        });
        await renderPeriod(period.from, period.to);
        if (status) status.textContent = `Період ${period.label}: завантажено ${done}, помилок ${failed}, уже були ${all.length - pending.length}.`;
        showToast(`Критерії за ${period.label}: завантажено ${done}`);
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
        showToast(status?.textContent || 'Не вдалося довантажити критерії');
    } finally {
        if (button) button.disabled = false;
    }
}
