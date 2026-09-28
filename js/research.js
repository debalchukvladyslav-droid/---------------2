import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { loadAllMonths, loadJournalRange } from './storage.js';
import { clampResearchPeriod, criteriaCoverage, groupCriteriaPairs, journalDatesInRange, shiftIsoMonths, sixMonthWindows } from './market_criteria_analysis.js';
import { ensureTradeCriteria } from './trade_criteria.js';

const RESEARCH_TRADE_TYPES = ['Візуально', 'Синя', 'Зелена', 'Фіолетова'];
const RESEARCH_TYPE_TONES = { Візуально: 'visual', Синя: 'blue', Зелена: 'green', Фіолетова: 'purple' };
let selectedTradeType = '';

function view() {
    return document.getElementById('view-research');
}

function researchInDevelopment() {
    return state.myRole !== 'admin';
}

function showResearchAvailability() {
    const root = view();
    const developing = researchInDevelopment();
    root?.querySelector('[data-research-dev]')?.toggleAttribute('hidden', !developing);
    root?.querySelector('[data-research-work]')?.toggleAttribute('hidden', developing);
    return developing;
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
    if (!root || showResearchAvailability()) return;
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
    fillExitPeriod();
    void import('./research_export.js').then((module) => module.prepareResearchExport());
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
    if (researchInDevelopment()) return;
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
    if (researchInDevelopment()) return;
    selectedTradeType = RESEARCH_TRADE_TYPES.includes(type) ? type : '';
    markTradeType();
    if (view()?.dataset.researchReady === '1') void renderPeriod(field('from')?.value || '', field('to')?.value || '');
}

function fillExitPeriod() {
    const fromInput = field('exit-from');
    const toInput = field('exit-to');
    if (!fromInput || !toInput || fromInput.value) return;
    const dates = Object.keys(state.appData?.journal || {}).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    if (!dates.length) return;
    const end = dates.at(-1);
    const start = shiftIsoMonths(end, -1);
    fromInput.value = start && start > dates[0] ? start : dates[0];
    toInput.value = end;
}

export async function showResearchExit() {
    if (researchInDevelopment()) return;
    const status = field('exit-status');
    const button = view()?.querySelector('[data-action="research-exit-show"]');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (status) status.textContent = 'Рахую зі збережених графіків. Polygon для цього не викликається.';
    try {
        const from = field('exit-from')?.value || '';
        const to = field('exit-to')?.value || '';
        if (from && to && from > to) throw new Error('Дата «Від» має бути не пізніше за «До»');
        await ensureJournal(from, to);
        const dates = journalDatesInRange(state.appData?.journal || {}, from, to);
        const label = from || to ? `${from || 'початок'} — ${to || 'сьогодні'}` : 'За весь час';
        const { renderBestExitAnalysis } = await import('./best_exit_analysis.js');
        await renderBestExitAnalysis({
            journal: state.appData.journal || {},
            sheetRows: { ...(state.appData.cumulativeSheetRows || {}), ...(state.appData.sheetRows || {}) },
            periodDates: dates,
            sourceType: 'current',
            periodLabel: label,
        });
        if (status) status.textContent = `${label}. Суми взято зі збережених графіків. «Довантажити» качає лише дні без свічок.`;
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
    } finally {
        if (button) button.disabled = false;
    }
}

async function renderPeriod(from, to) {
    const dates = journalDatesInRange(state.appData?.journal || {}, from, to);
    const { renderMarketCriteriaAnalysis } = await import('./stats.js');
    renderMarketCriteriaAnalysis(state.appData.journal || {}, dates, selectedTradeType);
    return dates.size;
}

export async function showResearch() {
    if (researchInDevelopment()) return;
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
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
    } finally {
        if (button) button.disabled = false;
    }
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
        : ` ${coverage.trades} угод на ${coverage.pairs} днів тікера. Snapshot рахується окремо для часу входу кожної угоди.`;
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

export async function loadResearchCriteria() {
    if (researchInDevelopment()) return;
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
        let done = 0;
        let failed = 0;
        let finished = 0;
        await mapPool(groups, 1, async (group) => {
            if (status) status.textContent = `${group.ticker}: ${group.pairs.length} дат · тікер ${finished + 1} із ${groups.length} · у журналі ${journalTrades} угод`;
            let saved = 0;
            for (const pair of group.pairs) {
                const trades = (state.appData.journal?.[pair.date]?.trades || []).filter((trade) => String(trade?.symbol || trade?.ticker || '').trim().toUpperCase() === group.ticker);
                let pairSaved = false;
                for (const trade of trades) {
                    try {
                        const snapshot = await ensureTradeCriteria(pair.date, trade);
                        if (snapshot) pairSaved = true;
                    } catch (error) {
                        console.warn('[Research criteria]', group.ticker, pair.date, error?.message || error);
                    }
                }
                if (pairSaved) saved += 1;
            }
            done += saved;
            failed += group.pairs.length - saved;
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
