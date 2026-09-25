import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { loadAllMonths, loadJournalRange } from './storage.js';
import { calculatePreMarketVolume } from './polygon_intraday_cache.js';
import { clampResearchPeriod, criteriaCoverage, groupCriteriaPairs, journalDatesInRange, shiftIsoMonths, sixMonthWindows } from './market_criteria_analysis.js';
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

async function renderExit(period) {
    const status = field('exit-status');
    if (status) status.textContent = 'Рахую вихід по часу…';
    try {
        const dates = journalDatesInRange(state.appData?.journal || {}, period.from, period.to);
        const { renderBestExitAnalysis } = await import('./best_exit_analysis.js');
        await renderBestExitAnalysis({
            journal: state.appData.journal || {},
            periodDates: dates,
            sourceType: 'current',
            periodLabel: period.label,
        });
        if (status) status.textContent = `Період ${period.label}. Якщо цін ще немає, натисніть «Почати» в цій панелі.`;
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
    }
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
        const coverage = criteriaCoverage(state.appData.journal, { from: period.from, to: period.to });
        if (status) status.textContent = coverageText(period.label, coverage);
        await renderExit(period);
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

function coverageText(label, coverage) {
    if (!coverage.trades) return `У періоді ${label} немає угод із тікером.`;
    const sameDay = coverage.trades === coverage.pairs
        ? ''
        : ` ${coverage.trades} угод згортаються в ${coverage.pairs} днів тікера: кілька угод одного паперу за день мають одні критерії.`;
    return `Період ${label}, ${selectedTypeLabel()}: критерії є для ${coverage.ready} із ${coverage.pairs} днів тікера.${sameDay}`;
}

async function tradeDateBounds() {
    const userId = state.currentViewedUserId || state.myUserId;
    if (!userId) throw new Error('Потрібно увійти в акаунт');
    const oldest = await supabase.from('trades').select('trade_date').eq('user_id', userId).is('deleted_at', null).order('trade_date', { ascending: true }).limit(1);
    const newest = await supabase.from('trades').select('trade_date').eq('user_id', userId).is('deleted_at', null).order('trade_date', { ascending: false }).limit(1);
    if (oldest.error) throw oldest.error;
    if (newest.error) throw newest.error;
    return {
        from: String(oldest.data?.[0]?.trade_date || '').slice(0, 10),
        to: String(newest.data?.[0]?.trade_date || '').slice(0, 10),
    };
}

function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
    return chunks;
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
        const bounds = await tradeDateBounds();
        const windows = sixMonthWindows(bounds.from, bounds.to);
        if (!windows.length) {
            if (status) status.textContent = 'У журналі немає угод для критеріїв.';
            return;
        }
        if (status) status.textContent = `Шукаю угоди з ${bounds.from} по ${bounds.to}…`;
        let journalTrades = 0;
        let journalPairs = 0;
        const pending = [];
        for (const [index, window] of windows.entries()) {
            if (status) status.textContent = `Читаю журнал ${window.from} — ${window.to} (${index + 1} із ${windows.length})…`;
            await ensureJournal(window.from, window.to);
            const coverage = criteriaCoverage(state.appData.journal, window);
            journalTrades += coverage.trades;
            journalPairs += coverage.pairs;
            pending.push(...coverage.pending);
        }
        view().dataset.researchReady = '1';
        const groups = groupCriteriaPairs(pending);
        if (progress) {
            progress.max = Math.max(1, pending.length);
            progress.value = 0;
        }
        if (!pending.length) {
            if (progress) progress.value = 1;
            if (status) {
                status.textContent = journalTrades
                    ? `У журналі ${journalTrades} угод і ${journalPairs} днів тікера. Критерії вже є для кожного такого дня, тож повторно нічого не качається. На екрані зараз ${period.label}.`
                    : 'У журналі немає угод із тікером.';
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
            if (status) status.textContent = `${group.ticker}: ${group.pairs.length} дат · тікер ${finished + 1} із ${groups.length} · у журналі ${journalTrades} угод`;
            const savedDates = new Set();
            try {
                for (const slice of chunk(group.pairs, 80)) {
                    const volPreByDate = await volPreByDateForPairs(slice, session.access_token);
                    const response = await fetch('/api/trade-polygons', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ticker: group.ticker, dates: slice.map((pair) => pair.date), volPreByDate }),
                    });
                    const payload = await response.json().catch(() => ({}));
                    const results = Array.isArray(payload.results) ? payload.results : [];
                    if (!response.ok && !results.some((item) => item.ok)) throw new Error(payload.error || `HTTP ${response.status}`);
                    results.forEach((item) => {
                        if (!item?.ok || !item.metrics) return;
                        rememberCriteria(item.date, group.ticker, item.metrics);
                        savedDates.add(item.date);
                    });
                }
            } catch (error) {
                console.warn('[Research criteria]', group.ticker, error);
            }
            done += savedDates.size;
            failed += group.pairs.length - savedDates.size;
            finished += 1;
            if (progress) progress.value = done + failed;
        });
        await renderPeriod(period.from, period.to);
        if (status) status.textContent = `Журнал: ${journalTrades} угод, ${journalPairs} днів тікера. Завантажено ${done}, помилок ${failed}, уже були ${journalPairs - pending.length}. Таблиця показує ${period.label}.`;
        showToast(`Критерії за ${period.label}: завантажено ${done}`);
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
        showToast(status?.textContent || 'Не вдалося довантажити критерії');
    } finally {
        if (button) button.disabled = false;
    }
}
