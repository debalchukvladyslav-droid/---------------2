import { state } from './state.js';
import { callGeminiViaProxy } from './ai/client.js';
import { getStorageUrl } from './gallery.js';
import { saveSettings } from './storage.js';
import { parseSheetProfitRisk } from './stats_sheet_metrics.js';
import { showToast } from './utils.js';

const STORE_VERSION = 1;
const MAX_PER_RUN = 12;
const PATTERN_KEYS = new Set([
    'late_entry', 'chase_extension', 'weak_breakout', 'countertrend', 'no_structure',
    'early_entry', 'poor_rr', 'stop_violation', 'repeated_entry', 'unclear',
]);

let analysisRunning = false;
let renderToken = 0;

function isOwnAnalyticsSource() {
    const selection = state.statsSourceSelection || {};
    const key = selection.key || state.CURRENT_VIEWED_USER || state.USER_DOC_NAME;
    return selection.type === 'current' && key === state.USER_DOC_NAME;
}

function normalizeTicker(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    const parsed = Number.parseFloat(String(value).replace(/\s/g, '').replace(',', '.').replace(/[^0-9.+-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function tradeResult(trade = {}) {
    const pnl = numberOrNull(trade.net ?? trade.pnl ?? trade.profit);
    const kf = parseSheetProfitRisk(trade?.sheet?.profitRisk ?? trade.profitRisk ?? trade.kf);
    return { pnl, kf };
}

function allDayScreens(entry = {}) {
    const screens = entry.screenshots && typeof entry.screenshots === 'object' ? entry.screenshots : {};
    return ['good', 'normal', 'bad', 'error']
        .flatMap(category => (Array.isArray(screens[category]) ? screens[category] : []).map(path => ({ path, category })))
        .filter(item => item.path);
}

function screenMatchesTicker(path, ticker, entry = {}) {
    const wanted = normalizeTicker(ticker);
    if (!wanted) return false;
    const saved = normalizeTicker(state.appData?.tickers?.[path] ?? entry?.tickers?.[path]);
    if (saved) return saved === wanted;
    const tags = state.appData?.screenTags?.[path] || [];
    if (tags.some(tag => normalizeTicker(tag) === wanted)) return true;
    return normalizeTicker(String(path).split(/[\\/]/).pop()).includes(wanted);
}

function collectCandidates() {
    const journal = state.currentStatsContext?.journal || state.appData?.journal || {};
    const byPath = new Map();

    Object.entries(journal).forEach(([date, entry = {}]) => {
        const trades = (Array.isArray(entry.trades) ? entry.trades : [])
            .map(trade => ({ trade, ...tradeResult(trade) }))
            .filter(row => (row.pnl != null && row.pnl < 0) || (row.kf != null && row.kf < 0));
        if (!trades.length) return;

        const dayScreens = allDayScreens(entry);
        trades.forEach(({ trade, pnl, kf }) => {
            const symbol = normalizeTicker(trade.symbol ?? trade.ticker ?? trade?.sheet?.ticker);
            let screens = dayScreens.filter(item => screenMatchesTicker(item.path, symbol, entry));
            if (!screens.length && trades.length === 1) screens = dayScreens;
            screens.forEach(({ path, category }) => {
                const old = byPath.get(path);
                const candidate = { path, category, date, symbol: symbol || '—', pnl, kf };
                if (!old || (candidate.pnl ?? 0) < (old.pnl ?? 0)) byPath.set(path, candidate);
            });
        });
    });

    return [...byPath.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function getStore() {
    if (!state.appData.settings || typeof state.appData.settings !== 'object') state.appData.settings = {};
    const current = state.appData.settings.lossPatternAnalysis;
    if (!current || current.version !== STORE_VERSION || !current.items || typeof current.items !== 'object') {
        state.appData.settings.lossPatternAnalysis = { version: STORE_VERSION, items: {}, updatedAt: null };
    }
    return state.appData.settings.lossPatternAnalysis;
}

function cacheKey(candidate) {
    const created = state.appData?.screenMeta?.[candidate.path]?.createdAt || '';
    return `${candidate.path}|${created}`;
}

function formatMoney(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toLocaleString('uk-UA', { maximumFractionDigits: 0 })} $`;
}

function formatKf(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} КФ`;
}

function setStatus(text, tone = '') {
    const element = document.getElementById('stats-loss-patterns-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.tone = tone;
}

function parseAiJson(text) {
    const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('AI не повернув структуру аналізу');
    const value = JSON.parse(clean.slice(start, end + 1));
    const patternKey = PATTERN_KEYS.has(value.patternKey) ? value.patternKey : 'unclear';
    return {
        patternKey,
        label: String(value.label || 'Ситуація потребує ручного перегляду').slice(0, 90),
        insight: String(value.insight || '').slice(0, 220),
        confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    };
}

async function imageInlineData(path) {
    const url = await getStorageUrl(path);
    if (!url) throw new Error('Скрін недоступний у сховищі');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Скрін не завантажився (${response.status})`);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Не вдалося прочитати скрін'));
        reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(',');
    return { mime_type: blob.type || 'image/jpeg', data: dataUrl.slice(comma + 1) };
}

async function inspectCandidate(candidate) {
    const image = await imageInlineData(candidate.path);
    const prompt = `Ти аналізуєш скрін графіка мінусової угоди проп-трейдера.
Визнач лише візуальний тип повторюваної проблеми входу. Не вигадуй того, чого не видно.
Обери patternKey тільки з: late_entry, chase_extension, weak_breakout, countertrend, no_structure, early_entry, poor_rr, stop_violation, repeated_entry, unclear.
Поверни ТІЛЬКИ JSON: {"patternKey":"...","label":"коротка назва українською","insight":"одне коротке практичне спостереження українською","confidence":0.0}.
Контекст: дата ${candidate.date}, тікер ${candidate.symbol}, результат ${candidate.pnl ?? 'невідомий'} $, ${candidate.kf ?? 'невідомо'} КФ.`;
    const text = await callGeminiViaProxy({
        contents: [{ parts: [{ text: prompt }, { inline_data: image }] }],
        generationConfig: { temperature: 0.15, responseMimeType: 'application/json' },
    }, 'gemini-2.5-flash');
    return parseAiJson(text);
}

function createScreenCard(item) {
    const card = document.createElement('article');
    card.className = 'stats-loss-screen';
    const image = document.createElement('img');
    image.alt = `${item.symbol}, ${item.date}`;
    image.loading = 'lazy';
    getStorageUrl(item.path).then(url => {
        if (!url || !image.isConnected) return;
        image.src = url;
        image.addEventListener('click', () => window.openZoom?.(url), { once: true });
    });
    const meta = document.createElement('div');
    meta.className = 'stats-loss-screen__meta';
    const title = document.createElement('strong');
    title.textContent = item.symbol || '—';
    const result = document.createElement('span');
    result.textContent = `${item.date} · ${formatMoney(item.pnl)} · ${formatKf(item.kf)}`;
    meta.append(title, result);
    card.append(image, meta);
    return card;
}

function renderGroups(items) {
    const host = document.getElementById('stats-loss-patterns-groups');
    if (!host) return;
    host.replaceChildren();
    const groups = new Map();
    items.forEach(item => {
        if (!groups.has(item.patternKey)) groups.set(item.patternKey, []);
        groups.get(item.patternKey).push(item);
    });
    const repeated = [...groups.values()].filter(group => group.length >= 2).sort((a, b) => b.length - a.length);
    if (!repeated.length) {
        const empty = document.createElement('div');
        empty.className = 'stats-loss-patterns__empty';
        empty.textContent = items.length
            ? 'Повтору ще не видно. Нові мінусові скріни будуть зіставлятися з цією історією.'
            : 'Ще немає проаналізованих мінусових скрінів.';
        host.append(empty);
        return;
    }

    repeated.forEach(group => {
        const totalPnl = group.reduce((sum, item) => sum + (Number.isFinite(item.pnl) ? item.pnl : 0), 0);
        const knownKf = group.filter(item => Number.isFinite(item.kf));
        const totalKf = knownKf.reduce((sum, item) => sum + item.kf, 0);
        const section = document.createElement('section');
        section.className = 'stats-loss-pattern';
        const head = document.createElement('div');
        head.className = 'stats-loss-pattern__head';
        const copy = document.createElement('div');
        const title = document.createElement('h4');
        title.textContent = group[0].label;
        const insight = document.createElement('p');
        insight.textContent = group[0].insight || 'Переглянь ці входи поруч — у них повторюється одна візуальна ситуація.';
        copy.append(title, insight);
        const totals = document.createElement('div');
        totals.className = 'stats-loss-pattern__totals';
        totals.innerHTML = `<strong>${group.length} повтори</strong><span>${formatMoney(totalPnl)}</span><span>${knownKf.length ? formatKf(totalKf) : 'КФ —'}</span>`;
        head.append(copy, totals);
        const screens = document.createElement('div');
        screens.className = 'stats-loss-pattern__screens';
        group.forEach(item => screens.append(createScreenCard(item)));
        section.append(head, screens);
        host.append(section);
    });
}

export function renderLossPatternAnalysis() {
    const section = document.getElementById('stats-loss-patterns');
    if (!section) return;
    const visible = !state.statsCompareMode
        && state.CURRENT_VIEWED_USER === state.USER_DOC_NAME
        && isOwnAnalyticsSource();
    section.hidden = !visible;
    if (!visible) return;

    const token = ++renderToken;
    const candidates = collectCandidates();
    const store = getStore();
    const relevantKeys = new Set(candidates.map(cacheKey));
    const items = Object.values(store.items).filter(item => relevantKeys.has(item.cacheKey));
    const remaining = candidates.filter(candidate => !store.items[cacheKey(candidate)]).length;
    renderGroups(items);
    if (analysisRunning) return;
    setStatus(items.length
        ? `Перевірено ${items.length}. ${remaining ? `Нових скрінів: ${remaining}.` : 'Усі знайдені скріни перевірено.'}`
        : (candidates.length ? `Знайдено ${candidates.length} мінусових скрінів для перевірки.` : 'Для мінусових угод поки немає прив’язаних скрінів.'));
    const button = document.getElementById('stats-loss-patterns-analyze');
    if (button && token === renderToken) {
        button.disabled = !remaining;
        button.textContent = remaining ? (items.length ? 'Перевірити нові скріни' : 'Почати аналіз') : 'Усе перевірено';
    }
}

export async function analyzeLossPatterns() {
    if (analysisRunning) return;
    if (state.statsCompareMode || state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME || !isOwnAnalyticsSource()) return;
    const store = getStore();
    const pending = collectCandidates().filter(candidate => !store.items[cacheKey(candidate)]);
    if (!pending.length) {
        showToast('Нових мінусових скрінів немає');
        renderLossPatternAnalysis();
        return;
    }

    analysisRunning = true;
    const button = document.getElementById('stats-loss-patterns-analyze');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    const batch = pending.slice(0, MAX_PER_RUN);
    let completed = 0;
    let failed = 0;
    try {
        for (const candidate of batch) {
            setStatus(`AI переглядає скрін ${completed + failed + 1} із ${batch.length}…`);
            try {
                const result = await inspectCandidate(candidate);
                const key = cacheKey(candidate);
                store.items[key] = { ...candidate, ...result, cacheKey: key, analyzedAt: new Date().toISOString() };
                completed += 1;
                renderGroups(Object.values(store.items));
                if (completed % 3 === 0) await saveSettings();
            } catch (error) {
                failed += 1;
                console.warn('[Loss pattern analysis]', candidate.path, error);
                if (/ліміт|quota|429/i.test(String(error?.message || error))) break;
            }
        }
        store.updatedAt = new Date().toISOString();
        await saveSettings();
        if (completed) showToast(`Перевірено скрінів: ${completed}`);
        if (failed && !completed) showToast('Не вдалося проаналізувати скріни. Спробуйте пізніше.');
    } finally {
        analysisRunning = false;
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        renderLossPatternAnalysis();
    }
}
