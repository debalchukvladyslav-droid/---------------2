// === js/stats.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { normalizeAppData, getDefaultAppData } from './data_utils.js';
import { loadMonth, loadAllMonths, getCurrentViewedUserId, resolveViewedUserId } from './storage.js';
import { escapeHtml } from './utils.js';
import { ensureChartJs } from './vendor_loader.js';

// ─── STATS CACHE ───────────────────────────────────────────────────────────────────────────────
// Module-level Map survives filter switches and profile switches within the
// same session. Key = "docName|mk1,mk2,..." or "docName|all-time".
// Value = { journal: {}, ts: Date.now() }. TTL = 24 h.
const _statsCache = new Map();
const _CACHE_TTL = 24 * 60 * 60 * 1000;
const _profileIdCache = new Map();
const STATS_BREAKEVEN_DAYLOSS_RATIO = 0.04;

function _cacheGet(key) {
    const entry = _statsCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > _CACHE_TTL) { _statsCache.delete(key); return null; }
    return entry.journal;
}

function _cacheSet(key, journal) {
    _statsCache.set(key, { journal, ts: Date.now() });
}

// Wipes all entries for a given docName. Call after any write to Supabase
// so the next stats open re-fetches fresh data for that user only.
export function clearStatsCache(docName) {
    for (const key of _statsCache.keys()) {
        if (
            key.startsWith(`${docName}|`)
            || key.startsWith('__all__')
            || key.startsWith('__team__')
            || key.startsWith('__compare_')
        ) {
            _statsCache.delete(key);
        }
    }
}

function journalRowToEntry(row) {
    const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
    return {
        pnl: row?.pnl ?? null,
        gross_pnl: row?.gross_pnl ?? null,
        commissions: row?.commissions ?? null,
        locates: row?.locates ?? null,
        kf: row?.kf ?? null,
        notes: row?.notes ?? '',
        mentor_comment: row?.mentor_comment ?? '',
        ai_advice: row?.ai_advice ?? '',
        errors: metrics.errors || [],
        checkedParams: metrics.checkedParams || [],
        sliders: metrics.sliders || {},
        tradeTypesData: metrics.tradeTypesData || {},
        screenshots: metrics.screenshots || { good: [], normal: [], bad: [], error: [] },
        tickers: metrics.tickers || {},
        traded_tickers: metrics.traded_tickers || [],
        fondexx: metrics.fondexx || { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: metrics.ppro || { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        sessionGoal: metrics.sessionGoal ?? '',
        sessionPlan: metrics.sessionPlan ?? '',
        sessionReadiness: metrics.sessionReadiness ?? null,
        sessionSetups: metrics.sessionSetups || [],
        sessionAiResult: metrics.sessionAiResult ?? '',
        sessionDone: metrics.sessionDone ?? false,
        trades: metrics.trades || []
    };
}

async function getProfileForDocName(docName) {
    if (!docName) return null;
    if (_profileIdCache.has(docName)) return _profileIdCache.get(docName);

    const nick = String(docName).replace(/_stats$/, '');
    const { data, error } = await supabase
        .from('profiles')
        .select('id, nick, first_name, last_name, team, mentor_enabled, role, settings')
        .eq('nick', nick)
        .maybeSingle();

    if (error) throw error;
    _profileIdCache.set(docName, data || null);
    return data || null;
}

function getStatsProfileSettingsByNick(nick = '') {
    const cleanNick = cleanStatsNick(nick).replace(/_stats$/, '');
    const profileSettings = state._teamProfiles?.[cleanNick]?.settings;
    if (profileSettings && typeof profileSettings === 'object') return profileSettings;

    const currentNick = cleanStatsNick(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME).replace(/_stats$/, '');
    if (cleanNick && cleanNick === currentNick) return state.appData?.settings || {};
    return {};
}

function getStatsDaylossForDate(settings = {}, dateStr = '') {
    const safeSettings = settings && typeof settings === 'object' ? settings : {};
    const monthKey = /^\d{4}-\d{2}/.test(String(dateStr || '')) ? String(dateStr).slice(0, 7) : '';
    const monthlyRaw = monthKey && safeSettings.monthlyDayloss && typeof safeSettings.monthlyDayloss === 'object'
        ? Number(safeSettings.monthlyDayloss[monthKey])
        : NaN;
    const fallbackRaw = Number(safeSettings.defaultDayloss ?? safeSettings.daylossLimit ?? -100);
    const raw = Number.isFinite(monthlyRaw) ? monthlyRaw : fallbackRaw;
    return Math.abs(Number.isFinite(raw) && raw !== 0 ? raw : -100);
}

function getStatsBreakevenBand(settings = {}, dateStr = '') {
    return getStatsDaylossForDate(settings, dateStr) * STATS_BREAKEVEN_DAYLOSS_RATIO;
}

function classifyStatsPnlDay(pnl, settings = {}, dateStr = '', explicitBand = null) {
    const value = Number(pnl);
    if (!Number.isFinite(value)) return 'none';
    const band = Number.isFinite(Number(explicitBand))
        ? Math.max(0, Number(explicitBand))
        : getStatsBreakevenBand(settings, dateStr);
    if (Math.abs(value) <= band) return 'be';
    return value > 0 ? 'win' : 'loss';
}

async function fetchJournalRowsForDoc(docName, monthKeys = null, userId = null) {
    let resolvedUserId = userId;
    if (!resolvedUserId && docName === state.CURRENT_VIEWED_USER) {
        resolvedUserId = getCurrentViewedUserId();
    }

    let profile = null;
    if (!resolvedUserId) {
        profile = await getProfileForDocName(docName);
        resolvedUserId = profile?.id || null;
    }

    if (!resolvedUserId && docName === state.CURRENT_VIEWED_USER) {
        resolvedUserId = await resolveViewedUserId(docName);
    }

    if (!resolvedUserId) return {};

    let query = supabase
        .from('journal_days')
        .select('*')
        .eq('user_id', resolvedUserId)
        .order('trade_date', { ascending: true });

    if (monthKeys && monthKeys.size) {
        const sortedMonths = [...monthKeys].sort();
        const lastMonth = sortedMonths[sortedMonths.length - 1];
        const [year, month] = lastMonth.split('-').map(Number);
        const lastDay = new Date(year, month, 0).getDate();
        query = query
            .gte('trade_date', `${sortedMonths[0]}-01`)
            .lte('trade_date', `${lastMonth}-${String(lastDay).padStart(2, '0')}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const journal = {};
    const monthFilter = monthKeys ? new Set(monthKeys) : null;
    (data || []).forEach(row => {
        if (monthFilter && !monthFilter.has(String(row.trade_date).slice(0, 7))) return;
        journal[row.trade_date] = journalRowToEntry(row);
    });
    return journal;
}

function makeDocSnapshot(id, payload) {
    return {
        id,
        exists: !!payload && Object.keys(payload).length > 0,
        data: () => payload || {}
    };
}

function aggregateJournal(journal, settings = {}) {
    let allTimePnl = 0;
    let allTimeWinDays = 0;
    let allTimeLossDays = 0;
    let allTimeBeDays = 0;

    Object.entries(journal || {}).forEach(([dateStr, entry]) => {
        const pnl = parseFloat(entry?.pnl);
        if (Number.isNaN(pnl)) return;
        allTimePnl += pnl;
        const dayClass = classifyStatsPnlDay(pnl, settings, dateStr, entry?.__statsBreakevenBand);
        if (dayClass === 'win') allTimeWinDays++;
        else if (dayClass === 'loss') allTimeLossDays++;
        else allTimeBeDays++;
    });

    return { allTimePnl, allTimeWinDays, allTimeLossDays, allTimeBeDays };
}

const db = {
    collection(name) {
        if (name !== 'journal') throw new Error(`Unsupported collection: ${name}`);
        return {
            doc(docName) {
                return {
                    async get() {
                        const [profile, journal] = await Promise.all([
                            getProfileForDocName(docName),
                            fetchJournalRowsForDoc(docName, null)
                        ]);
                        return makeDocSnapshot(docName, { ...(profile || {}), ...aggregateJournal(journal, profile?.settings || {}) });
                    },
                    collection(childName) {
                        if (childName !== 'months') throw new Error(`Unsupported subcollection: ${childName}`);
                        return {
                            async get() {
                                const journal = await fetchJournalRowsForDoc(docName, null);
                                const months = {};
                                Object.entries(journal).forEach(([dateStr, entry]) => {
                                    const mk = dateStr.slice(0, 7);
                                    if (!months[mk]) months[mk] = {};
                                    months[mk][dateStr] = entry;
                                });
                                return {
                                    docs: Object.entries(months).map(([id, payload]) => makeDocSnapshot(id, payload))
                                };
                            },
                            doc(monthKey) {
                                return {
                                    async get() {
                                        const payload = await fetchJournalRowsForDoc(docName, new Set([monthKey]));
                                        return makeDocSnapshot(monthKey, payload);
                                    }
                                };
                            }
                        };
                    }
                };
            }
        };
    }
};

// ─── PERIOD HELPERS ───────────────────────────────────────────────────────────
// Derives the minimal set of YYYY-MM keys that the current activeFilters
// actually need. Falls back to the currently selected month when no filter
// is active ("За весь час" in the UI still shows the period tree, but we
// only download what is visible — all-time totals come from the aggregation
// document instead).
function _monthKeysForFilters(filters) {
    const keys = new Set();
    const now = state.todayObj || new Date();
    const pad = n => String(n).padStart(2, '0');

    if (!filters || filters.length === 0) {
        // No filter active — default to the last 2 months.
        const y0 = now.getFullYear(), m0 = now.getMonth(); // current month (0-based)
        keys.add(`${y0}-${pad(m0 + 1)}`);
        // Previous month (handles January → December of previous year)
        const prevDate = new Date(y0, m0 - 1, 1);
        keys.add(`${prevDate.getFullYear()}-${pad(prevDate.getMonth() + 1)}`);
        return keys;
    }

    for (const f of filters) {
        if (f.type === 'all-time') {
            // Повертаємо null — refreshStatsView викличе loadAllMonths
            return null;
        }
        if (f.type === 'week' || f.type === 'month') {
            // val is 'YYYY-M' (month) or 'YYYY-M-W' (week) — M is 0-based (JS getMonth())
            const parts = String(f.val).split('-');
            keys.add(`${parts[0]}-${pad(parseInt(parts[1]) + 1)}`);
        } else if (f.type === 'year') {
            for (let m = 1; m <= 12; m++) keys.add(`${f.val}-${pad(m)}`);
        }
    }
    return keys;
}

// Fetches only the month sub-documents that are required by the current
// filters for a given trader doc. Returns a merged flat journal object.
// Uses a Supabase-backed Firestore-compatible shim for older stats code.
async function fetchMonthsForPeriod(docName, filters, userId = null) {
    const monthKeys = _monthKeysForFilters(filters);
    if (!monthKeys) return fetchJournalRowsForDoc(docName, null, userId);
    const cacheKey = `${docName}|${[...monthKeys].sort().join(',')}`;

    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const journal = await fetchJournalRowsForDoc(docName, monthKeys, userId);
    _cacheSet(cacheKey, journal);
    return journal;
}

// Reads aggregate data for a trader (formerly journal/{docName}_stats fields:
// allTimePnl, allTimeWinDays, allTimeLossDays written by saveToLocal).
// Returns null when the document doesn't exist yet — callers show a TODO note.
async function fetchAggregation(docName) {
    try {
        const doc = await db.collection('journal').doc(docName)
            .get({ source: 'server' });
        if (!doc.exists) return null;
        const d = doc.data();
        // Only return if the aggregation fields are actually present
        if (d.allTimePnl === undefined) return null;
        return {
            allTimePnl:      d.allTimePnl      ?? 0,
            allTimeWinDays:  d.allTimeWinDays  ?? 0,
            allTimeLossDays: d.allTimeLossDays ?? 0,
            allTimeBeDays:   d.allTimeBeDays   ?? 0,
        };
    } catch (e) {
        console.warn('fetchAggregation failed:', e.message);
        return null;
    }
}

export async function getStatsDocData(docName, filters, userId = null) {
    if (!docName) return getDefaultAppData();
    if (docName === state.CURRENT_VIEWED_USER) {
        const data = normalizeAppData(state.appData);
        const needed = _monthKeysForFilters(filters); // null = all-time
        const currentUserId = getCurrentViewedUserId(userId) || await resolveViewedUserId(docName);
        if (needed) {
            await Promise.all([...needed].map(mk => loadMonth(docName, mk, currentUserId)));
            const journal = {};
            for (const dateStr in state.appData.journal) {
                if (needed.has(dateStr.slice(0, 7))) journal[dateStr] = state.appData.journal[dateStr];
            }
            data.journal = journal;
        } else {
            data.journal = state.appData.journal;
        }
        return data;
    }

    try {
        const [profile, journal] = await Promise.all([
            getProfileForDocName(docName),
            fetchMonthsForPeriod(docName, filters, userId),
        ]);
        const data = normalizeAppData(profile || {});
        data.journal = journal;
        return data;
    } catch (e) {
        console.error('getStatsDocData error:', e);
        return getDefaultAppData();
    }
}

function getStatsSourceButtonClass(type, key, selection = state.statsSourceSelection) {
    const sel = selection || state.statsSourceSelection;
    if (sel.type === type && String(sel.key) === String(key)) return 'stats-source-btn active';
    return 'stats-source-btn';
}

function cleanStatsNick(value = '') {
    const s = String(value || '');
    return (s.includes('(') && s.includes(')')) ? s.split('(')[1].replace(')', '').trim() : s.trim();
}

function isStatsProfile(profile) {
    return !!profile && profile.role !== 'mentor' && !profile.mentor_enabled;
}

function isStatsNickAllowed(nick) {
    const profile = state._teamProfiles?.[cleanStatsNick(nick)];
    return profile ? isStatsProfile(profile) : true;
}

function getStatsNicksForGroup(groupName) {
    return (state.TEAM_GROUPS[groupName] || [])
        .map(cleanStatsNick)
        .filter((nick) => nick && isStatsNickAllowed(nick));
}

function getAllStatsNicks() {
    const out = [];
    for (const group in state.TEAM_GROUPS || {}) {
        for (const nick of getStatsNicksForGroup(group)) {
            if (!out.includes(nick)) out.push(nick);
        }
    }
    return out;
}

function getStatsSourceOptionsHtml(selection = state.statsSourceSelection, dataPrefix = '') {
    const typeAttr = dataPrefix ? `data-${dataPrefix}-stats-source-type` : 'data-stats-source-type';
    const keyAttr = dataPrefix ? `data-${dataPrefix}-stats-source-key` : 'data-stats-source-key';
    let currentKey = state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '';
    let html = isStatsNickAllowed(currentKey.replace(/_stats$/, ''))
        ? `<button class="${getStatsSourceButtonClass('current', currentKey, selection)}" ${typeAttr}="current" ${keyAttr}="${escapeHtml(currentKey)}">🏠 Мій профіль</button>`
        : '';

    html += `<button class="${getStatsSourceButtonClass('all', '', selection)}" ${typeAttr}="all" ${keyAttr}="">🌍 Всі трейдери разом</button>`;

    Object.keys(state.TEAM_GROUPS || {}).sort((a, b) => a.localeCompare(b, 'uk')).forEach(groupName => {
        const groupNicks = getStatsNicksForGroup(groupName);
        if (!groupNicks.length) return;
        html += `<div class="stats-group-title">${escapeHtml(groupName)}</div>`;
        html += `<button class="${getStatsSourceButtonClass('team', groupName, selection)}" ${typeAttr}="team" ${keyAttr}="${escapeHtml(groupName)}">📚 Весь кущ</button>`;
        (state.TEAM_GROUPS[groupName] || []).slice().sort((a, b) => String(a).localeCompare(String(b), 'uk')).forEach(nick => {
            let cleanNick = cleanStatsNick(nick);
            if (!isStatsNickAllowed(cleanNick)) return;
            // Не показуємо себе в списку
            if (`${cleanNick}_stats` === state.USER_DOC_NAME) return;
            html += `<button class="${getStatsSourceButtonClass('trader', cleanNick, selection)}" ${typeAttr}="trader" ${keyAttr}="${escapeHtml(cleanNick || nick)}">👤 ${escapeHtml(nick)}</button>`;
        });
    });

    return html;
}

export function renderStatsSourceSelector() {
    let wrapEl = document.getElementById('stats-source-dropdown-wrap');
    let container = document.getElementById('stats-source-container');
    let triggerLabel = document.getElementById('stats-source-trigger-label');
    if (!wrapEl || !container || !triggerLabel) return;

    triggerLabel.innerText = getStatsSelectionLabel(state.statsSourceSelection.type, state.statsSourceSelection.key);

    container.innerHTML = getStatsSourceOptionsHtml(state.statsSourceSelection);
    if (!container.dataset.statsSourceBound) {
        container.dataset.statsSourceBound = 'true';
        container.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-stats-source-type]');
            if (!button || !container.contains(button)) return;
            void selectStatsSource(button.dataset.statsSourceType, button.dataset.statsSourceKey || '');
        });
    }
}

export async function selectStatsSource(type, key) {
    state.statsSourceSelection = { type, key: typeof key === 'string' ? key : '' };
    state.activeFilters = [];
    state.activeTradeTypeFilter = null;
    renderStatsSourceSelector();
    updateStatsPeriodTriggerLabel();
    if (window.closeStatsDropdown) window.closeStatsDropdown('source');
    if (window.refreshStatsView) await window.refreshStatsView();
}

// Допоміжні функції для розрахунків
function getWeekOfMonth(d) {
    let firstDayOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
    let offset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1; 
    if (offset >= 5) { offset -= 7; }
    return Math.max(1, Math.ceil((d.getDate() + offset) / 7));
}

export function resetStatsSourceSelection() {
    state.statsSourceSelection = { type: 'current', key: state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '' };
    state.activeFilters = [];
    state.currentStatsContext = {
        journal: state.appData.journal || {},
        label: getStatsSelectionLabel(state.statsSourceSelection.type, state.statsSourceSelection.key)
    };
}

export function getStatsSelectionLabel(type, key) {
    if (type === 'all') return 'Всі трейдери разом';
    if (type === 'team') return `Кущ: ${key}`;
    if (type === 'trader') return `Трейдер: ${key}`;
    if (state.CURRENT_VIEWED_USER && state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        return `Профіль: ${state.CURRENT_VIEWED_USER.replace('_stats', '')}`;
    }
    return 'Мій профіль';
}

export function updateStatsPeriodTriggerLabel() {
    let triggerLabel = document.getElementById('stats-period-trigger-label');
    if (!triggerLabel) return;

    if (state.activeFilters.length === 0) {
        triggerLabel.innerText = '2 місяці';
        return;
    }
    if (state.activeFilters.some(f => f.type === 'all-time')) {
        triggerLabel.innerText = 'За весь час';
        return;
    }

    let labels = state.activeFilters.map(f => f.label).join(', ');
    triggerLabel.innerText = labels.length > 36 ? labels.substring(0, 33) + '...' : labels;
}

export function renderTradeTypeSelector() {
    const container = document.getElementById('stats-tradetype-container');
    const triggerLabel = document.getElementById('stats-tradetype-trigger-label');
    if (!container || !triggerLabel) return;

    const types = state.currentStatsContext.tradeTypes || state.appData.tradeTypes || [];
    const active = state.activeTradeTypeFilter;
    // Якщо активний фільтр більше не існує в новому списку — скидаємо
    if (active && !types.includes(active)) state.activeTradeTypeFilter = null;
    const current = state.activeTradeTypeFilter;
    triggerLabel.innerText = current || 'Всі типи';

    let html = `<button class="stats-source-btn${!current ? ' active' : ''}" data-trade-type-filter="">Всі типи</button>`;
    types.forEach(t => {
        html += `<button class="stats-source-btn${current === t ? ' active' : ''}" data-trade-type-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
    });
    container.innerHTML = html;
    if (!container.dataset.tradeTypeBound) {
        container.dataset.tradeTypeBound = 'true';
        container.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-trade-type-filter]');
            if (!button || !container.contains(button)) return;
            selectTradeTypeFilter(button.dataset.tradeTypeFilter || null);
        });
    }
}

export function selectTradeTypeFilter(type) {
    state.activeTradeTypeFilter = type || null;
    renderTradeTypeSelector();
    if (window.closeStatsDropdown) window.closeStatsDropdown('tradetype');
    renderStatsTab();
}

function extractTradeTypesFromJournal(journal) {
    const seen = new Set();
    for (const dateStr in journal || {}) {
        const entry = journal[dateStr];
        if (entry?.tradeTypesData) Object.keys(entry.tradeTypesData).forEach(type => seen.add(type));
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, 'uk'));
}

function normalizeCompareSourceSelection() {
    if (!state.statsCompareSourceSelection?.type) {
        state.statsCompareSourceSelection = {
            type: state.statsSourceSelection?.type || 'current',
            key: state.statsSourceSelection?.key || state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || ''
        };
    }
}

async function loadCompareStatsContext(selection = state.statsCompareSourceSelection) {
    const sel = selection || { type: 'current', key: state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '' };
    const currentUserId = getCurrentViewedUserId() || await resolveViewedUserId(state.CURRENT_VIEWED_USER);
    let journal = {};
    let tradeTypes = [];
    let settings = {};

    try {
        if (sel.type === 'current') {
            const nick = cleanStatsNick(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME);
            if (isStatsNickAllowed(nick.replace(/_stats$/, ''))) {
                await loadAllMonths(state.CURRENT_VIEWED_USER, currentUserId);
                journal = state.appData.journal || {};
                tradeTypes = state.appData.tradeTypes || extractTradeTypesFromJournal(journal);
                settings = state.appData.settings || {};
            }
        } else if (sel.type === 'all') {
            const allNicks = getAllStatsNicks();
            const cacheKey = '__compare_all__|all-time';
            const cached = _cacheGet(cacheKey);
            if (cached) {
                journal = cached;
            } else {
                const journals = await Promise.all(allNicks.map(async (nick) => {
                    const k = `${nick}_stats|all-time`;
                    const c = _cacheGet(k);
                    const settings = getStatsProfileSettingsByNick(nick);
                    if (c) return { journal: c, settings };
                    const j = {};
                    const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                    (snap.docs || []).forEach(d => { Object.assign(j, d.data()); });
                    _cacheSet(k, j);
                    return { journal: j, settings };
                }));
                journal = mergeJournals(journals);
                _cacheSet(cacheKey, journal);
            }
            tradeTypes = extractTradeTypesFromJournal(journal);
        } else if (sel.type === 'team' && state.TEAM_GROUPS?.[sel.key]) {
            const cacheKey = `__compare_team__${sel.key}|all-time`;
            const cached = _cacheGet(cacheKey);
            if (cached) {
                journal = cached;
            } else {
                const journals = await Promise.all(getStatsNicksForGroup(sel.key).map(async (nick) => {
                    const k = `${nick}_stats|all-time`;
                    const c = _cacheGet(k);
                    const settings = getStatsProfileSettingsByNick(nick);
                    if (c) return { journal: c, settings };
                    const j = {};
                    const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                    (snap.docs || []).forEach(d => { Object.assign(j, d.data()); });
                    _cacheSet(k, j);
                    return { journal: j, settings };
                }));
                journal = mergeJournals(journals);
                _cacheSet(cacheKey, journal);
            }
            tradeTypes = extractTradeTypesFromJournal(journal);
        } else if (sel.type === 'trader') {
            const nick = cleanStatsNick(sel.key);
            if (!isStatsNickAllowed(nick)) {
                journal = {};
            } else {
                settings = getStatsProfileSettingsByNick(nick);
                const cacheKey = `${nick}_stats|all-time`;
                const cached = _cacheGet(cacheKey);
                if (cached) {
                    journal = cached;
                } else {
                    const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                    (snap.docs || []).forEach(d => { Object.assign(journal, d.data()); });
                    _cacheSet(cacheKey, journal);
                }
            }
            tradeTypes = extractTradeTypesFromJournal(journal);
        }
    } catch (error) {
        console.error('loadCompareStatsContext error:', error);
    }

    state.statsCompareContext = {
        label: getStatsSelectionLabel(sel.type, sel.key),
        journal,
        tradeTypes,
        settings
    };
    if (state.statsCompareTradeTypeFilter && !tradeTypes.includes(state.statsCompareTradeTypeFilter)) {
        state.statsCompareTradeTypeFilter = null;
    }
}

async function selectStatsCompareSource(type, key) {
    state.statsCompareSourceSelection = { type, key: typeof key === 'string' ? key : '' };
    state.statsCompareTradeTypeFilter = null;
    state.statsComparePeriodKey = '';
    state.statsCompareFilters = [];
    await loadCompareStatsContext(state.statsCompareSourceSelection);
    renderStatsTab();
}

function selectStatsCompareTradeType(type) {
    state.statsCompareTradeTypeFilter = type || null;
    state.statsComparePeriodKey = '';
    state.statsCompareFilters = [];
    renderStatsTab();
}

function setCompareDropdownState(type, isOpen) {
    const map = {
        source: 'compareSource',
        tradetype: 'compareTradeType',
        period: 'comparePeriod',
    };
    setStatsDropdownState(map[type] || type, isOpen);
}

export function toggleStatsEquityMode(enabled, target = 'main') {
    if (target === 'compare') {
        state.statsCompareEquityAdvancedMode = !!enabled;
        renderStatsTab();
        return;
    }
    state.statsEquityAdvancedMode = !!enabled;
    renderStatsTab();
}

export async function toggleStatsCompareMode(forceOpen = null) {
    state.statsCompareMode = forceOpen === null ? !state.statsCompareMode : !!forceOpen;
    if (state.statsCompareMode) {
        state.statsCompareSourceSelection = {
            type: state.statsSourceSelection?.type || 'current',
            key: state.statsSourceSelection?.key || state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || ''
        };
        state.statsCompareTradeTypeFilter = state.activeTradeTypeFilter || null;
        state.statsComparePeriodKey = '';
        state.statsCompareFilters = (state.activeFilters || []).map(filter => ({ ...filter }));
        await loadCompareStatsContext(state.statsCompareSourceSelection);
    }
    renderStatsTab();
}

export function closeStatsCompareMode() {
    state.statsCompareMode = false;
    renderStatsTab();
}

// Maps each logical dropdown name to its panel-id and trigger-id.
const _DROPDOWN_IDS = {
    source:    ['stats-source-panel',    'stats-source-trigger'],
    period:    ['stats-period-panel',    'stats-period-trigger'],
    tradetype: ['stats-tradetype-panel', 'stats-tradetype-trigger'],
    compareSource: ['stats-compare-source-panel', 'stats-compare-source-trigger'],
    comparePeriod: ['stats-compare-period-panel', 'stats-compare-period-trigger'],
    compareTradeType: ['stats-compare-tradetype-panel', 'stats-compare-tradetype-trigger'],
};

export function setStatsDropdownState(type, isOpen) {
    const [panelId, triggerId] = _DROPDOWN_IDS[type] || [];
    if (!panelId) return;
    const panel   = document.getElementById(panelId);
    const trigger = document.getElementById(triggerId);
    if (!panel || !trigger) return;
    // Drive visibility purely through CSS class so the stylesheet's
    // .stats-bar-trigger.open rule fires correctly.
    panel.classList.toggle('open', isOpen);
    panel.style.display = isOpen ? 'block' : 'none';
    panel.classList.toggle('initially-hidden', !isOpen);
    trigger.classList.toggle('open', isOpen);
}

export function closeStatsDropdown(type = null) {
    const targets = type ? [type] : Object.keys(_DROPDOWN_IDS);
    targets.forEach(t => setStatsDropdownState(t, false));
    if (!type || state.activeStatsDropdown === type) state.activeStatsDropdown = null;
}

export function toggleStatsDropdown(type) {
    const willOpen = state.activeStatsDropdown !== type;
    // Close everything first (including the one we may be re-opening).
    closeStatsDropdown();
    if (!willOpen) return;
    // Populate content before making the panel visible.
    if (type === 'source')    renderStatsSourceSelector();
    if (type === 'tradetype') renderTradeTypeSelector();
    if (type === 'period')    buildStatsTree();
    setStatsDropdownState(type, true);
    state.activeStatsDropdown = type;
}

export function toggleTree(el) {
    let ul = el.parentElement.nextElementSibling;
    if(ul && ul.tagName === 'UL') {
        if(ul.style.display === 'none') { ul.style.display = 'block'; el.innerText = '▼'; }
        else { ul.style.display = 'none'; el.innerText = '▶'; }
    }
}

export async function toggleStatsFilter(type, val, el, event, labelName) {
    if (event) event.stopPropagation();

    const wasAllTime = state.activeFilters.some(f => f.type === 'all-time');

    if (type === 'all') {
        // Якщо вже активний — скидаємо до дефолту 2 місяці
        if (wasAllTime) {
            state.activeFilters = [];
            document.querySelectorAll('.tree-item, .tree-root').forEach(e => e.classList.remove('active-filter'));
        } else {
            state.activeFilters = [{ type: 'all-time', val: 'all', label: 'За весь час' }];
            document.querySelectorAll('.tree-item, .tree-root').forEach(e => e.classList.remove('active-filter'));
            el.classList.add('active-filter');
        }
    } else {
        document.querySelector('.tree-root')?.classList.remove('active-filter');
        // Якщо перемикаємось з all-time або з іншого типу — скидаємо
        const hasOtherType = state.activeFilters.some(f => f.type !== type);
        if (hasOtherType) {
            state.activeFilters = [];
            document.querySelectorAll('.tree-item').forEach(e => e.classList.remove('active-filter'));
        }
        const index = state.activeFilters.findIndex(f => f.type === type && f.val === val);
        if (index > -1) {
            state.activeFilters.splice(index, 1);
            el.classList.remove('active-filter');
        } else {
            state.activeFilters.push({ type, val, label: labelName });
            el.classList.add('active-filter');
        }
    }

    updateStatsPeriodTriggerLabel();
    // Завжди робимо повний refresh — дані могли не бути завантажені для нового фільтру
    if (window.refreshStatsView) await window.refreshStatsView();
}

function mergeJournals(journals) {
    let merged = {};
    for (let j of journals) {
        if (!j || !j.journal) continue;
        for (let d in j.journal) {
            let entry = j.journal[d];
            if (entry.pnl === null || entry.pnl === undefined || entry.pnl === '') continue;
            if (!merged[d]) merged[d] = { pnl: 0, commissions: 0, locates: 0, tradeTypesData: {}, __statsBreakevenBand: 0 };
            const costs = getEntryCosts(entry);
            merged[d].pnl = (parseFloat(merged[d].pnl) || 0) + (parseFloat(entry.pnl) || 0);
            merged[d].commissions = (parseFloat(merged[d].commissions) || 0) + costs.commissions;
            merged[d].locates = (parseFloat(merged[d].locates) || 0) + costs.locates;
            const entryBand = Number.isFinite(Number(entry.__statsBreakevenBand))
                ? Number(entry.__statsBreakevenBand)
                : getStatsBreakevenBand(j.settings || {}, d);
            merged[d].__statsBreakevenBand = (Number(merged[d].__statsBreakevenBand) || 0) + entryBand;
            Object.entries(entry.tradeTypesData || {}).forEach(([type, typeData]) => {
                const typePnl = parseFloat(typeData?.pnl);
                if (!Number.isFinite(typePnl)) return;
                if (!merged[d].tradeTypesData[type]) merged[d].tradeTypesData[type] = { pnl: 0 };
                merged[d].tradeTypesData[type].pnl = (parseFloat(merged[d].tradeTypesData[type].pnl) || 0) + typePnl;
            });
        }
    }
    return merged;
}

export async function refreshStatsView() {
    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    let requestId = ++state.statsLoadRequestId;
    const currentUserId = getCurrentViewedUserId() || await resolveViewedUserId(state.CURRENT_VIEWED_USER);

    // Invalidate the per-request month cache is no longer needed —
    // _statsCache is persistent with TTL; invalidation happens via clearStatsCache()
    state.statsMonthCache = {};

    const statsView = document.getElementById('view-stats');
    let overlay = document.getElementById('stats-loading-overlay');
    if (!overlay && statsView) {
        overlay = document.createElement('div');
        overlay.id = 'stats-loading-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.55);z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;border-radius:8px;backdrop-filter:blur(2px);';
        overlay.innerHTML = `
            <div style="width:48px;height:48px;border:4px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;"></div>
            <div id="stats-loading-text" style="color:var(--text-main);font-size:1rem;font-weight:500;">Завантаження даних...</div>
            <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
        statsView.style.position = 'relative';
        statsView.appendChild(overlay);
    }
    if (overlay) overlay.style.display = 'flex';
    const loadingText = document.getElementById('stats-loading-text');

    let treeContainer = document.getElementById('stats-tree-container');
    if (treeContainer) treeContainer.innerHTML = '';

    let journal = {};
    const sel = state.statsSourceSelection;
    const filters = state.activeFilters;
    const isAllTime = filters.some(f => f.type === 'all-time');

    // Для побудови дерева навігації — завантажуємо список ID місяців без даних (тільки для current)
    // Якщо вже завантажено або є завантажені місяці — будуємо з кешу
    if (sel.type === 'current' && !state._monthListLoaded) {
        if (state.loadedMonths[state.CURRENT_VIEWED_USER]?.size > 0) {
            // Є завантажені місяці — використовуємо їх як базу для дерева
            state._availableMonthKeys = new Set(state.loadedMonths[state.CURRENT_VIEWED_USER]);
            // Завантажуємо повний список у фоні (без блокування рендеру)
            db.collection('journal').doc(state.CURRENT_VIEWED_USER)
                .collection('months').get({ source: 'server' })
                .then(snap => {
                    state._availableMonthKeys = new Set(snap.docs.map(d => d.id));
                    state._monthListLoaded = true;
                })
                .catch(e => console.warn('Could not load month list:', e.message));
        } else {
            try {
                const snap = await db.collection('journal').doc(state.CURRENT_VIEWED_USER)
                    .collection('months').get({ source: 'server' });
                state._availableMonthKeys = new Set(snap.docs.map(d => d.id));
                state._monthListLoaded = true;
            } catch (e) {
                console.warn('Could not load month list:', e.message);
                state._availableMonthKeys = new Set(state.loadedMonths[state.CURRENT_VIEWED_USER] || {});
            }
        }
    }

    try {
        if (sel.type === 'current') {
            const currentNick = cleanStatsNick(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME).replace(/_stats$/, '');
            if (!isStatsNickAllowed(currentNick)) {
                journal = {};
            } else if (isAllTime) {
                if (loadingText) loadingText.textContent = 'Завантаження всіх місяців...';
                await loadAllMonths(state.CURRENT_VIEWED_USER, currentUserId);
                journal = state.appData.journal || {};
            } else {
                // Перевіряємо чи потрібні місяці вже завантажені
                const needed = _monthKeysForFilters(filters);
                const nick = state.CURRENT_VIEWED_USER;
                const loaded = state.loadedMonths[nick] || new Set();
                const missing = needed ? [...needed].filter(mk => !loaded.has(mk)) : [];
                if (missing.length === 0) {
                    // Всі дані вже в пам'яті — жодних запитів
                    console.log(`[STATS] Дані з пам'яті, запитів немає. Місяці: ${[...needed].join(', ')}`);
                    const journalFiltered = {};
                    for (const dateStr in state.appData.journal) {
                        if (!needed || needed.has(dateStr.slice(0, 7))) journalFiltered[dateStr] = state.appData.journal[dateStr];
                    }
                    journal = journalFiltered;
                } else {
                    console.log(`[STATS] Запит до Supabase: не вистачає місяців: ${missing.join(', ')}`);
                    if (loadingText) loadingText.textContent = 'Завантаження даних...';
                    const data = await getStatsDocData(nick, filters, currentUserId);
                    journal = data.journal || {};
                }
            }

        } else if (sel.type === 'all') {
            if (loadingText) loadingText.textContent = 'Завантаження трейдерів...';
            const allNicks = getAllStatsNicks();
            if (isAllTime) {
                const allTimeCacheKey = `__all__|all-time`;
                const cachedAll = _cacheGet(allTimeCacheKey);
                if (cachedAll) {
                    journal = cachedAll;
                } else {
                    const journals = await Promise.all(
                        allNicks.map(async nick => {
                            const k = `${nick}_stats|all-time`;
                            const c = _cacheGet(k);
                            const settings = getStatsProfileSettingsByNick(nick);
                            if (c) return { journal: c, settings };
                            const j = {};
                            const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                            (snap.docs || []).forEach(d => { Object.assign(j, d.data()); });
                            _cacheSet(k, j);
                            return { journal: j, settings };
                        })
                    );
                    journal = mergeJournals(journals);
                    _cacheSet(allTimeCacheKey, journal);
                }
            } else {
                const journals = await Promise.all(
                    allNicks.map(nick => fetchMonthsForPeriod(`${nick}_stats`, filters))
                );
                journal = mergeJournals(journals.map((j, index) => ({ journal: j, settings: getStatsProfileSettingsByNick(allNicks[index]) })));
            }

        } else if (sel.type === 'team' && state.TEAM_GROUPS[sel.key]) {
            if (loadingText) loadingText.textContent = `Завантаження куща ${sel.key}...`;
            const traders = getStatsNicksForGroup(sel.key);
            if (isAllTime) {
                const teamCacheKey = `__team__${sel.key}|all-time`;
                const cachedTeam = _cacheGet(teamCacheKey);
                if (cachedTeam) {
                    journal = cachedTeam;
                } else {
                    const journals = await Promise.all(
                        traders.map(async nick => {
                            const k = `${nick}_stats|all-time`;
                            const c = _cacheGet(k);
                            const settings = getStatsProfileSettingsByNick(nick);
                            if (c) return { journal: c, settings };
                            const j = {};
                            const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                            (snap.docs || []).forEach(d => { Object.assign(j, d.data()); });
                            _cacheSet(k, j);
                            return { journal: j, settings };
                        })
                    );
                    journal = mergeJournals(journals);
                    _cacheSet(teamCacheKey, journal);
                }
            } else {
                const journals = await Promise.all(
                    traders.map(nick => fetchMonthsForPeriod(`${nick}_stats`, filters))
                );
                journal = mergeJournals(journals.map((j, index) => ({ journal: j, settings: getStatsProfileSettingsByNick(traders[index]) })));
            }

        } else if (sel.type === 'trader') {
            if (loadingText) loadingText.textContent = `Завантаження ${sel.key}...`;
            const nick = cleanStatsNick(sel.key);
            if (!isStatsNickAllowed(nick)) {
                journal = {};
            } else if (isAllTime) {
                const k = `${nick}_stats|all-time`;
                const cached = _cacheGet(k);
                if (cached) {
                    journal = cached;
                } else {
                    const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                    (snap.docs || []).forEach(d => { Object.assign(journal, d.data()); });
                    _cacheSet(k, journal);
                }
            } else {
                journal = await fetchMonthsForPeriod(`${nick}_stats`, filters);
            }

        } else {
            journal = state.appData.journal || {};
        }
    } catch (e) {
        console.error('refreshStatsView fetch error:', e);
    }

    if (requestId !== state.statsLoadRequestId) { if (overlay) overlay.style.display = 'none'; return; }

    // Збираємо tradeTypes для поточного контексту
    let contextTradeTypes = [];
    let contextSettings = {};
    if (sel.type === 'current') {
        const currentNick = cleanStatsNick(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME).replace(/_stats$/, '');
        contextTradeTypes = isStatsNickAllowed(currentNick) ? (state.appData.tradeTypes || []) : [];
        contextSettings = isStatsNickAllowed(currentNick) ? (state.appData.settings || {}) : {};
    } else if (sel.type === 'trader') {
        const nick = cleanStatsNick(sel.key);
        if (isStatsNickAllowed(nick)) {
            const data = await getStatsDocData(`${nick}_stats`, filters);
            contextTradeTypes = data.tradeTypes || [];
            contextSettings = data.settings || getStatsProfileSettingsByNick(nick);
        }
    } else {
        const seen = new Set();
        for (const d in journal) {
            const entry = journal[d];
            if (entry.tradeTypesData) Object.keys(entry.tradeTypesData).forEach(t => seen.add(t));
        }
        contextTradeTypes = Array.from(seen);
    }

    if (requestId !== state.statsLoadRequestId) { if (overlay) overlay.style.display = 'none'; return; }

    state.currentStatsContext = { label: getStatsSelectionLabel(sel.type, sel.key), journal, tradeTypes: contextTradeTypes, settings: contextSettings };

    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    if (window.renderTradeTypeSelector) window.renderTradeTypeSelector();
    buildStatsTree();
    updateStatsPeriodTriggerLabel();
    if (loadingText) loadingText.textContent = 'Завантаження графіків...';
    await ensureChartJs();
    renderStatsTab();
    if (overlay) overlay.style.display = 'none';
}

function renderMistakeChart(filteredEntries, cssRed, cssText, cssBgPanel) {
    const panel = document.getElementById('mistake-chart-panel');
    const ctx = document.getElementById('mistakeChart');
    if (!panel || !ctx) return;

    // Збираємо суму PnL по кожній помилці (тільки мінусові дні)
    const mistakeCost = {};
    for (let e of filteredEntries) {
        const errors = e.data.errors;
        if (!errors || !errors.length) continue;
        const pnl = e.pnl;
        // Розподіляємо PnL рівномірно між усіма помилками дня
        const share = pnl / errors.length;
        for (let err of errors) {
            if (!err) continue;
            mistakeCost[err] = (mistakeCost[err] || 0) + share;
        }
    }

    const entries = Object.entries(mistakeCost)
        .sort((a, b) => a[1] - b[1]); // від найдорожчої (найбільший мінус) до найменшої

    if (!entries.length) {
        panel.classList.add('initially-hidden');
        return;
    }
    panel.classList.remove('initially-hidden');

    const labels = entries.map(([k]) => k);
    const values = entries.map(([, v]) => parseFloat(v.toFixed(2)));
    const colors = values.map(v => v < 0 ? cssRed : '#10b981');

    // Висота залежить від кількості помилок
    ctx.parentElement.style.height = Math.max(160, entries.length * 48) + 'px';

    if (state.mistakeChartInstance) state.mistakeChartInstance.destroy();
    state.mistakeChartInstance = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data: values, backgroundColor: colors, borderColor: colors, borderWidth: 2, borderRadius: 4 }]
        },
        options: {
            indexAxis: 'y',
            animation: {
                duration: 850,
                easing: 'easeOutQuart',
                delay: (context) => context.type === 'data' ? Math.min(context.dataIndex * 55, 420) : 0,
            },
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ' ' + fmtMoney(ctx.parsed.x) } }
            },
            layout: { padding: { right: 10 } },
            scales: {
                x: { grid: { color: 'rgba(100,116,139,0.2)' }, ticks: { color: cssText, callback: v => fmtMoneyAbs(v) } },
                y: { grid: { display: false }, ticks: { color: cssText, font: { size: 12 } } }
            }
        }
    });
}

function statsColorWithAlpha(color, alpha) {
    const c = String(color || '').trim();
    if (c.startsWith('#')) {
        const hex = c.length === 4
            ? c.slice(1).split('').map(ch => ch + ch).join('')
            : c.slice(1, 7);
        const n = parseInt(hex, 16);
        if (Number.isFinite(n)) return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }
    if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
    if (c.startsWith('rgba(')) return c.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
    return c || `rgba(156, 163, 175, ${alpha})`;
}

function statsCssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function statsLerp(a, b, t) {
    return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

function statsColorToRgb(color, fallback = '#10b981') {
    const c = String(color || fallback).trim();
    if (c.startsWith('#')) {
        const hex = c.length === 4
            ? c.slice(1).split('').map(ch => ch + ch).join('')
            : c.slice(1, 7);
        const n = parseInt(hex, 16);
        if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return statsColorToRgb(fallback, '#10b981');
}

function statsMixColor(a, b, t) {
    const ca = statsColorToRgb(a);
    const cb = statsColorToRgb(b);
    return `rgb(${statsLerp(ca[0], cb[0], t)}, ${statsLerp(ca[1], cb[1], t)}, ${statsLerp(ca[2], cb[2], t)})`;
}

function statsInterpolateSeries(series, t) {
    if (!series.length) return 0;
    if (series.length === 1) return series[0] || 0;
    const pos = Math.max(0, Math.min(1, t)) * (series.length - 1);
    const left = Math.floor(pos);
    const right = Math.min(series.length - 1, left + 1);
    const local = pos - left;
    return (series[left] || 0) + ((series[right] || 0) - (series[left] || 0)) * local;
}

function statsValueGradientColor(value, minValue, maxValue, palette = {}) {
    const red = palette.loss || statsCssVar('--loss', '#dc2626');
    const orange = palette.orange || '#f97316';
    const green = palette.profit || statsCssVar('--profit', '#10b981');
    const n = Number(value) || 0;
    if (n <= 0) {
        const span = Math.max(1, Math.abs(Math.min(0, minValue)));
        return statsMixColor(red, orange, 1 - Math.min(1, Math.abs(n) / span));
    }
    const span = Math.max(1, Math.max(0, maxValue));
    return statsMixColor(orange, green, Math.min(1, n / span));
}

function buildStatsValueGradient(ctx, chartArea, values, alpha = 1, palette = {}) {
    const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const samples = Math.max(16, Math.min(64, values.length * 5 || 16));
    for (let i = 0; i < samples; i++) {
        const stop = samples === 1 ? 0 : i / (samples - 1);
        const value = statsInterpolateSeries(values, stop);
        gradient.addColorStop(stop, statsColorWithAlpha(statsValueGradientColor(value, minValue, maxValue, palette), alpha));
    }
    return gradient;
}

function statsDrawdownColor(drawdown, worstDrawdown, palette = {}) {
    const loss = palette.loss || statsCssVar('--loss', '#ef4444');
    const orange = palette.orange || '#f97316';
    const profit = palette.profit || statsCssVar('--profit', '#10b981');
    const worstAbs = Math.abs(Number(worstDrawdown) || 0);
    const ddAbs = Math.abs(Math.min(0, Number(drawdown) || 0));
    if (!worstAbs || ddAbs <= 0) return profit;

    const ratio = Math.min(1, ddAbs / worstAbs);
    if (ratio < 0.18) return profit;
    if (ratio < 0.6) return statsMixColor(profit, orange, (ratio - 0.18) / 0.42);
    return statsMixColor(orange, loss, (ratio - 0.6) / 0.4);
}

function buildStatsDrawdownGradient(ctx, chartArea, rows, worstDrawdown, alpha = 1, palette = {}) {
    const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
    if (!rows.length) {
        gradient.addColorStop(0, statsColorWithAlpha(palette.profit || '#10b981', alpha));
        gradient.addColorStop(1, statsColorWithAlpha(palette.profit || '#10b981', alpha));
        return gradient;
    }

    const drawdowns = rows.map(row => row.drawdown || 0);
    const samples = Math.max(16, Math.min(80, rows.length * 5 || 16));
    for (let i = 0; i < samples; i++) {
        const stop = samples === 1 ? 0 : i / (samples - 1);
        const drawdown = statsInterpolateSeries(drawdowns, stop);
        gradient.addColorStop(stop, statsColorWithAlpha(statsDrawdownColor(drawdown, worstDrawdown, palette), alpha));
    }
    return gradient;
}

function buildStatsChartTheme(cssGreen, cssRed, cssAccent, cssBgPanel, cssText) {
    const bgPanel = statsCssVar('--bg-panel', cssBgPanel);
    const bgMain = statsCssVar('--bg-main', '#0f172a');
    const border = statsCssVar('--border', '#1f2937');
    const muted = statsCssVar('--text-muted', '#9ca3af');
    const text = statsCssVar('--text-main', cssText);
    const bgRgb = statsColorToRgb(bgPanel, '#0f172a');
    const luminance = (0.2126 * bgRgb[0] + 0.7152 * bgRgb[1] + 0.0722 * bgRgb[2]) / 255;
    const isLight = luminance > 0.72 || document.body?.getAttribute('data-theme') === 'light';

    return {
        isLight,
        bgPanel,
        bgMain,
        text,
        muted,
        grid: statsColorWithAlpha(border, isLight ? 0.72 : 0.62),
        labelBg: statsColorWithAlpha(bgPanel, isLight ? 0.94 : 0.86),
        labelBorder: statsColorWithAlpha(border, isLight ? 0.9 : 0.75),
        labelShadow: isLight ? 'rgba(15, 23, 42, 0.16)' : 'rgba(0, 0, 0, 0.42)',
        profit: cssGreen || statsCssVar('--profit', '#10b981'),
        loss: cssRed || statsCssVar('--loss', '#ef4444'),
        accent: cssAccent || statsCssVar('--accent', '#3b82f6'),
        orange: '#f97316',
    };
}

function buildStatsEquityAnalysis(entries, cumulativeValues, settings = {}) {
    const rows = [];
    let peak = 0;
    let worstDrawdown = 0;
    let positiveRun = 0;
    const longHorizon = entries.length > 90;
    const minZoneSpan = entries.length > 260 ? 8 : entries.length > 120 ? 5 : 1;
    const mergeGap = entries.length > 260 ? 4 : entries.length > 120 ? 2 : 0;

    entries.forEach((entry, index) => {
        const dayClass = classifyStatsPnlDay(entry.pnl, settings, entry.dateStr, entry.breakevenBand);
        const equity = cumulativeValues[index] || 0;
        const previousPeak = peak;
        peak = Math.max(peak, equity);
        const drawdown = equity - peak;
        worstDrawdown = Math.min(worstDrawdown, drawdown);
        positiveRun = dayClass === 'win' ? positiveRun + 1 : 0;
        rows.push({
            dateStr: entry.dateStr,
            pnl: entry.pnl,
            dayClass,
            equity,
            peak,
            drawdown,
            drawdownAbs: Math.abs(drawdown),
            isNewHigh: equity >= previousPeak && equity > 0,
            isGoodDay: dayClass === 'win',
            isRecovery: drawdown < 0 && index > 0 && drawdown > (rows[index - 1]?.drawdown || 0),
            positiveRun,
        });
    });

    let zones = [];
    const worstAbs = Math.abs(worstDrawdown);
    let current = null;
    rows.forEach((row, index) => {
        const ddRatio = worstAbs > 0 ? row.drawdownAbs / worstAbs : 0;
        let type = 'neutral';
        if (longHorizon) {
            const lookback = rows.slice(Math.max(0, index - 9), index + 1);
            const avgPnl = lookback.reduce((sum, item) => sum + item.pnl, 0) / Math.max(1, lookback.length);
            const improving = index > 0 && row.equity > (rows[Math.max(0, index - 5)]?.equity || row.equity);
            if (row.drawdown < 0 && ddRatio >= 0.55) type = 'deep-drawdown';
            else if (row.drawdown < 0 && ddRatio >= 0.28) type = 'drawdown';
            else if (row.isNewHigh || (avgPnl > 0 && improving)) type = 'good';
            else if (row.isRecovery && improving) type = 'recovery';
        } else {
            if (row.drawdown < 0 && ddRatio >= 0.6) type = 'deep-drawdown';
            else if (row.drawdown < 0 && ddRatio >= 0.25) type = 'drawdown';
            else if (row.isNewHigh || row.positiveRun >= 2) type = 'good';
            else if (row.isRecovery) type = 'recovery';
        }

        if (type === 'neutral') {
            if (current) { zones.push(current); current = null; }
            return;
        }
        if (!current || current.type !== type) {
            if (current) zones.push(current);
            current = { type, start: index, end: index };
        } else {
            current.end = index;
        }
    });
    if (current) zones.push(current);
    if (longHorizon) zones = normalizeStatsZones(zones, minZoneSpan, mergeGap);
    return { rows, zones, worstDrawdown, longHorizon };
}

function normalizeStatsZones(zones, minSpan, mergeGap) {
    const merged = [];
    zones.forEach((zone) => {
        const last = merged[merged.length - 1];
        if (last && last.type === zone.type && zone.start - last.end <= mergeGap + 1) {
            last.end = zone.end;
        } else {
            merged.push({ ...zone });
        }
    });

    return merged.filter((zone) => {
        if (zone.type === 'deep-drawdown') return zone.end - zone.start + 1 >= Math.max(2, Math.floor(minSpan / 2));
        return zone.end - zone.start + 1 >= minSpan;
    });
}

function getStatsZoneColor(type, theme = {}) {
    if (type === 'deep-drawdown') return statsColorWithAlpha(theme.loss || '#ef4444', theme.isLight ? 0.16 : 0.18);
    if (type === 'drawdown') return statsColorWithAlpha(theme.orange || '#f97316', theme.isLight ? 0.12 : 0.14);
    if (type === 'recovery') return statsColorWithAlpha('#14b8a6', theme.isLight ? 0.1 : 0.12);
    if (type === 'good') return statsColorWithAlpha(theme.profit || '#10b981', theme.isLight ? 0.11 : 0.14);
    return 'transparent';
}

function statsZoneBounds(points, area, start, end) {
    const p0 = points[start];
    const p1 = points[end];
    if (!p0 || !p1) return null;
    const prev = points[start - 1];
    const next = points[end + 1];
    const left = prev ? (prev.x + p0.x) / 2 : area.left;
    const right = next ? (next.x + p1.x) / 2 : area.right;
    return { left: Math.max(area.left, left), right: Math.min(area.right, right) };
}

const statsEquityZonesPlugin = {
    id: 'statsEquityZones',
    beforeDatasetsDraw(chart) {
        const zones = chart.canvas?.$statsEquityZones || [];
        if (!zones.length) return;
        const mainIndex = chart.data.datasets.findIndex(ds => ds.role === 'stats-equity-main');
        const meta = chart.getDatasetMeta(mainIndex);
        const points = meta?.data || [];
        const area = chart.chartArea;
        if (!points.length || !area) return;

        const { ctx } = chart;
        const theme = chart.canvas?.$statsChartTheme || {};
        ctx.save();
        zones.forEach((zone) => {
            const bounds = statsZoneBounds(points, area, zone.start, zone.end);
            if (!bounds || bounds.right <= bounds.left) return;
            ctx.fillStyle = getStatsZoneColor(zone.type, theme);
            ctx.fillRect(bounds.left, area.top, bounds.right - bounds.left, area.bottom - area.top);
        });
        ctx.restore();
    },
};

const statsZeroLinePlugin = {
    id: 'statsZeroLine',
    beforeDatasetsDraw(chart) {
        const yScale = chart.scales?.y;
        const area = chart.chartArea;
        if (!yScale || !area || yScale.min > 0 || yScale.max < 0) return;
        const y = yScale.getPixelForValue(0);
        const { ctx } = chart;
        const theme = chart.canvas?.$statsChartTheme || {};
        const profit = theme.profit || '#10b981';
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = statsColorWithAlpha(profit, 0.92);
        ctx.shadowColor = statsColorWithAlpha(profit, theme.isLight ? 0.18 : 0.35);
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
    },
};

const statsKeyLabelsPlugin = {
    id: 'statsKeyLabels',
    afterDatasetsDraw(chart) {
        const rows = chart.canvas?.$statsEquityRows || [];
        if (!rows.length) return;
        const mainIndex = chart.data.datasets.findIndex(ds => ds.role === 'stats-equity-main');
        const meta = chart.getDatasetMeta(mainIndex);
        const points = meta?.data || [];
        if (!points.length) return;

        const values = rows.map(row => row.equity);
        const peakValue = Math.max(...values);
        const peakIndex = values.lastIndexOf(peakValue);
        const lastIndex = rows.length - 1;
        const labels = [
            { index: peakIndex, text: fmtMoney(peakValue), color: chart.canvas?.$statsChartTheme?.profit || '#10b981', dy: -18 },
            { index: lastIndex, text: fmtMoney(rows[lastIndex]?.equity || 0), color: chart.canvas?.$statsChartTheme?.orange || '#f97316', dy: -18 },
        ].filter((label, index, all) => all.findIndex(item => item.index === label.index) === index);

        const { ctx, chartArea } = chart;
        const theme = chart.canvas?.$statsChartTheme || {};
        ctx.save();
        ctx.font = "700 10px 'DM Mono', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        labels.forEach(({ index, text, color, dy }) => {
            const point = points[index];
            if (!point) return;
            const width = ctx.measureText(text).width + 12;
            const x = Math.max(chartArea.left + width / 2, Math.min(chartArea.right - width / 2, point.x));
            const y = Math.max(chartArea.top + 10, Math.min(chartArea.bottom - 10, point.y + dy));
            ctx.fillStyle = theme.labelBg || statsColorWithAlpha('#0b0f14', 0.8);
            ctx.strokeStyle = theme.labelBorder || statsColorWithAlpha(color, 0.35);
            ctx.lineWidth = 1;
            ctx.shadowColor = theme.labelShadow || 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 10;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(x - width / 2, y - 9, width, 18, 6);
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.fillRect(x - width / 2, y - 9, width, 18);
                ctx.strokeRect(x - width / 2, y - 9, width, 18);
            }
            ctx.fillStyle = color;
            ctx.shadowColor = statsColorWithAlpha(color, theme.isLight ? 0.24 : 0.45);
            ctx.shadowBlur = 8;
            ctx.fillText(text, x, y);
            ctx.shadowBlur = 0;
        });
        ctx.restore();
    },
};

const statsFinalPointPlugin = {
    id: 'statsFinalPoint',
    afterDatasetsDraw(chart) {
        const rows = chart.canvas?.$statsEquityRows || [];
        if (!rows.length) return;
        const mainIndex = chart.data.datasets.findIndex(ds => ds.role === 'stats-equity-main');
        const meta = chart.getDatasetMeta(mainIndex);
        const point = meta?.data?.[rows.length - 1];
        if (!point) return;

        const { ctx } = chart;
        const theme = chart.canvas?.$statsChartTheme || {};
        const orange = theme.orange || '#f97316';
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = orange;
        ctx.shadowColor = statsColorWithAlpha(orange, theme.isLight ? 0.45 : 0.9);
        ctx.shadowBlur = 22;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = statsColorWithAlpha('#ffffff', 0.88);
        ctx.shadowColor = statsColorWithAlpha(orange, 0.95);
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.restore();
    },
};

const statsBarGlowPlugin = {
    id: 'statsBarGlow',
    beforeDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.shadowColor = statsColorWithAlpha(chart.canvas?.$statsGlowColor || '#10b981', 0.22);
        ctx.shadowBlur = 12;
    },
    afterDatasetsDraw(chart) {
        chart.ctx.restore();
    },
};

export function buildStatsTree() {
    // Для current: дерево будується з _availableMonthKeys (список ID документів без завантаження даних)
    // для інших — з поточного контексту журналу
    const sel = state.statsSourceSelection;
    let tree = {};
    const includeKnownEmptyMonths = false;

    if (includeKnownEmptyMonths && sel.type === 'current' && state._availableMonthKeys && state._availableMonthKeys.size > 0) {
        // Будуємо дерево зі списку місяців (без даних) — повна навігація
        for (const mk of state._availableMonthKeys) {
            const [y, m] = mk.split('-').map(Number);
            if (!y || !m) continue;
            if (!tree[y]) tree[y] = {};
            if (!tree[y][m - 1]) tree[y][m - 1] = new Set([1]);
        }
        // Додаємо тижні з завантажених даних
        const sourceJournal = state.appData.journal || {};
        for (let d in sourceJournal) {
            const data = sourceJournal[d];
            if (data.pnl === null || data.pnl === undefined || data.pnl === '') continue;
            const parts = d.split('-');
            const y = parseInt(parts[0]), m = parseInt(parts[1]) - 1;
            const w = getWeekOfMonth(new Date(y, m, parseInt(parts[2])));
            if (tree[y] && tree[y][m]) tree[y][m].add(w);
        }
    } else {
        const sourceJournal = sel.type === 'current'
            ? (state.appData.journal || {})
            : (state.currentStatsContext.journal || {});
        for (let d in sourceJournal) {
            const data = sourceJournal[d];
            if (data.pnl !== null && data.pnl !== undefined && data.pnl !== '') {
                const parts = d.split('-');
                const y = parseInt(parts[0]), m = parseInt(parts[1]) - 1;
                const w = getWeekOfMonth(new Date(y, m, parseInt(parts[2])));
                if (!tree[y]) tree[y] = {};
                if (!tree[y][m]) tree[y][m] = new Set();
                tree[y][m].add(w);
            }
        }
    }
    
    let isAllTimeActive = state.activeFilters.some(f => f.type === 'all-time');
    let html = `<div class="tree-item tree-root ${isAllTimeActive ? 'active-filter' : ''}"><span class="tree-toggle" style="opacity: 0;"></span><span class="tree-label" data-stats-filter-type="all" data-stats-filter-value="" data-stats-filter-label="За весь час">🌍 За весь час</span></div>`;
    let monthsNames = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
    let years = Object.keys(tree).sort((a,b)=>b-a);
    html += `<ul class="tree-nav">`;
    for(let y of years) {
        let isYActive = state.activeFilters.some(f => f.type === 'year' && f.val == y) ? 'active-filter' : '';
        html += `<li><div class="tree-item ${isYActive}"><span class="tree-toggle" data-tree-toggle>▼</span><span class="tree-label" data-stats-filter-type="year" data-stats-filter-value="${y}" data-stats-filter-label="${y} рік">${y}</span></div><ul>`;
        let months = Object.keys(tree[y]).map(Number).sort((a,b)=>b-a);
        for(let m of months) {
            let mVal = `${y}-${m}`; let isMActive = state.activeFilters.some(f => f.type === 'month' && f.val === mVal) ? 'active-filter' : '';
            html += `<li><div class="tree-item ${isMActive}"><span class="tree-toggle" data-tree-toggle>▼</span><span class="tree-label" data-stats-filter-type="month" data-stats-filter-value="${mVal}" data-stats-filter-label="${escapeHtml(monthsNames[m])} ${y}">${escapeHtml(monthsNames[m])}</span></div><ul>`;
            let weeks = Array.from(tree[y][m]).sort((a,b)=>a-b); 
            for(let w of weeks) {
                let wVal = `${y}-${m}-${w}`; let isWActive = state.activeFilters.some(f => f.type === 'week' && f.val === wVal) ? 'active-filter' : '';
                html += `<li><div class="tree-item ${isWActive}"><span class="tree-toggle" style="opacity: 0;"></span><span class="tree-label" data-stats-filter-type="week" data-stats-filter-value="${wVal}" data-stats-filter-label="${escapeHtml(monthsNames[m])}, Тиждень ${w}">Тиждень ${w}</span></div></li>`;
            }
            html += `</ul></li>`;
        }
        html += `</ul></li>`;
    }
    html += `</ul>`;
    const treeContainer = document.getElementById('stats-tree-container');
    treeContainer.innerHTML = html;
    if (!treeContainer.dataset.statsTreeBound) {
        treeContainer.dataset.statsTreeBound = 'true';
        treeContainer.addEventListener('click', (event) => {
            const toggle = event.target?.closest?.('[data-tree-toggle]');
            if (toggle && treeContainer.contains(toggle)) {
                toggleTree(toggle);
                return;
            }
            const label = event.target?.closest?.('[data-stats-filter-type]');
            if (!label || !treeContainer.contains(label)) return;
            const type = label.dataset.statsFilterType;
            const raw = label.dataset.statsFilterValue || '';
            const value = type === 'year' ? Number(raw) : raw || null;
            void toggleStatsFilter(type, value, label.parentElement, event, label.dataset.statsFilterLabel || label.textContent || '');
        });
    }
}

function fmtMoney(val) {
    const abs = Math.abs(val);
    const formatted = abs >= 1000
        ? Math.round(abs).toLocaleString('uk-UA').replace(/\u00a0/g, '\u202f')
        : parseFloat(abs.toFixed(2)).toString();
    return (val >= 0 ? '+' : '-') + formatted + '$';
}

function fmtMoneyAbs(val) {
    const abs = Math.abs(val);
    return (abs >= 1000
        ? Math.round(abs).toLocaleString('uk-UA').replace(/\u00a0/g, '\u202f')
        : parseFloat(abs.toFixed(2)).toString()) + '$';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function statsDeltaClass(value) {
    return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
}

function getEntryPeriodKey(entry, scale = 'year') {
    const year = entry.dateObj.getFullYear();
    const month = String(entry.dateObj.getMonth() + 1).padStart(2, '0');
    if (scale === 'week') return `${year}-${month}-W${getWeekOfMonth(entry.dateObj)}`;
    if (scale === 'month') return `${year}-${month}`;
    return String(year);
}

function getCompareOptionLabel(key, scale) {
    if (scale === 'week') {
        const [year, month, week] = key.split('-');
        return `${year}-${month} · ${week.replace('W', 'Тиждень ')}`;
    }
    if (scale === 'month') return key;
    return `${key} рік`;
}

function getCompareOptions(entries, scale = 'year') {
    const keys = new Set();
    entries.forEach((entry) => {
        keys.add(getEntryPeriodKey(entry, scale));
    });
    return [...keys]
        .sort((a, b) => b.localeCompare(a, 'uk', { numeric: true }))
        .map((key) => ({ key, label: getCompareOptionLabel(key, scale), scale }));
}

function summarizeCompareEntries(entries) {
    let pnl = 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    entries.forEach((entry) => {
        const value = Number(entry.pnl) || 0;
        pnl += value;
        if (value > 0) {
            wins++;
            grossProfit += value;
        } else if (value < 0) {
            losses++;
            grossLoss += Math.abs(value);
        }
    });
    const days = entries.length;
    return {
        days,
        pnl,
        winrate: days ? (wins / days) * 100 : 0,
        pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
        avgDay: days ? pnl / days : 0,
    };
}

function percentChange(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (Math.abs(from) < 0.000001) return Math.abs(to) < 0.000001 ? 0 : null;
    return ((to - from) / Math.abs(from)) * 100;
}

function fmtPercentChange(value) {
    if (value === null || !Number.isFinite(value)) return 'new';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${value.toFixed(1)}%`;
}

function fmtPlainNumber(value) {
    if (value === Infinity) return '∞';
    if (!Number.isFinite(value)) return '—';
    return value.toFixed(2);
}

function getEntryCosts(entryData = {}) {
    const directCommissions = parseFloat(entryData.commissions);
    const directLocates = parseFloat(entryData.locates);
    const sourceCommissions = (parseFloat(entryData.fondexx?.comm) || 0) + (parseFloat(entryData.ppro?.comm) || 0);
    const sourceLocates = (parseFloat(entryData.fondexx?.locates) || 0) + (parseFloat(entryData.ppro?.locates) || 0);
    return {
        commissions: Number.isFinite(directCommissions) && directCommissions !== 0 ? directCommissions : sourceCommissions,
        locates: Number.isFinite(directLocates) && directLocates !== 0 ? directLocates : sourceLocates,
    };
}

function renderCompareMetricCard({ title, a, b, deltaValue, aClass = '', bClass = '', changeType = 'percent' }) {
    const directionClass = statsDeltaClass(deltaValue || 0);
    const icon = deltaValue > 0 ? '▲' : deltaValue < 0 ? '▼' : '•';
    const deltaLabel = changeType === 'raw'
        ? `${deltaValue >= 0 ? '+' : ''}${deltaValue}`
        : fmtPercentChange(deltaValue);
    return `
        <div class="stats-compare-metric">
            <div class="stats-compare-metric-top">
                <span>${escapeHtml(title)}</span>
                <strong class="stats-compare-change ${directionClass}"><b>${icon}</b>${escapeHtml(deltaLabel)}</strong>
            </div>
            <div class="stats-compare-metric-values">
                <span class="${aClass}">${escapeHtml(a)}</span>
                <span class="${bClass}">${escapeHtml(b)}</span>
            </div>
        </div>
    `;
}

function getStatsScaleFromFilters(filters) {
    const scoped = (filters || []).filter(f => ['year', 'month', 'week'].includes(f.type));
    if (!scoped.length) return 'month';
    return scoped[0].type;
}

function filterEntriesByStatsFilters(entries, filters) {
    const isAllTime = (filters || []).some(f => f.type === 'all-time');
    if (isAllTime) return entries.slice();
    if (!filters || filters.length === 0) {
        const defaultMonths = _monthKeysForFilters([]);
        return entries.filter(entry => defaultMonths.has(`${entry.dateObj.getFullYear()}-${String(entry.dateObj.getMonth() + 1).padStart(2, '0')}`));
    }
    return entries.filter((entry) => {
        return filters.some((filter) => {
            if (filter.type === 'year') return entry.dateObj.getFullYear() == filter.val;
            if (filter.type === 'month') {
                const parts = String(filter.val).split('-');
                return entry.dateObj.getFullYear() == parts[0] && entry.dateObj.getMonth() == parts[1];
            }
            if (filter.type === 'week') {
                const parts = String(filter.val).split('-');
                return entry.dateObj.getFullYear() == parts[0] && entry.dateObj.getMonth() == parts[1] && getWeekOfMonth(entry.dateObj) == parts[2];
            }
            return false;
        });
    });
}

function buildStatsEntriesFromJournal(journal, tradeTypeFilter = null) {
    const entries = [];
    for (let dateStr in journal || {}) {
        const data = journal[dateStr];
        if (!dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
        let pnl;
        if (tradeTypeFilter) {
            const typeData = data.tradeTypesData && data.tradeTypesData[tradeTypeFilter];
            if (!typeData || typeData.pnl === '' || typeData.pnl === undefined || typeData.pnl === null) continue;
            pnl = parseFloat(typeData.pnl);
        } else {
            if (data.pnl === null || data.pnl === undefined || data.pnl === '') continue;
            pnl = parseFloat(data.pnl);
        }
        if (!Number.isNaN(pnl)) {
            const parts = dateStr.split('-');
            entries.push({
                dateStr,
                dateObj: new Date(parts[0], parts[1] - 1, parts[2]),
                pnl,
                data,
                breakevenBand: Number(data.__statsBreakevenBand),
            });
        }
    }
    entries.sort((a, b) => a.dateObj - b.dateObj);
    return entries;
}

function getStatsPeriodLabel(filters, emptyLabel = 'За весь час') {
    if (!filters || filters.length === 0) return emptyLabel;
    if (filters.some(filter => filter.type === 'all-time')) return 'За весь час';
    const labels = filters.map(filter => filter.label).join(', ');
    return labels.length > 36 ? labels.substring(0, 33) + '...' : labels;
}

function buildStatsPeriodTreeHtml(entries, filters, datasetPrefix = 'stats') {
    const tree = {};
    const monthsNames = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
    entries.forEach((entry) => {
        const y = entry.dateObj.getFullYear();
        const m = entry.dateObj.getMonth();
        const w = getWeekOfMonth(entry.dateObj);
        if (!tree[y]) tree[y] = {};
        if (!tree[y][m]) tree[y][m] = new Set();
        tree[y][m].add(w);
    });

    const typeAttr = `data-${datasetPrefix}-filter-type`;
    const valueAttr = `data-${datasetPrefix}-filter-value`;
    const labelAttr = `data-${datasetPrefix}-filter-label`;
    const isAllTimeActive = filters.some(filter => filter.type === 'all-time');
    let html = `<div class="tree-item tree-root ${isAllTimeActive ? 'active-filter' : ''}"><span class="tree-toggle" style="opacity: 0;"></span><span class="tree-label" ${typeAttr}="all" ${valueAttr}="" ${labelAttr}="За весь час">🌍 За весь час</span></div>`;
    html += `<ul class="tree-nav">`;
    Object.keys(tree).sort((a, b) => b - a).forEach((y) => {
        const isYActive = filters.some(filter => filter.type === 'year' && filter.val == y) ? 'active-filter' : '';
        html += `<li><div class="tree-item ${isYActive}"><span class="tree-toggle" data-tree-toggle>▼</span><span class="tree-label" ${typeAttr}="year" ${valueAttr}="${y}" ${labelAttr}="${y} рік">${y}</span></div><ul>`;
        Object.keys(tree[y]).map(Number).sort((a, b) => b - a).forEach((m) => {
            const monthValue = `${y}-${m}`;
            const isMActive = filters.some(filter => filter.type === 'month' && filter.val === monthValue) ? 'active-filter' : '';
            html += `<li><div class="tree-item ${isMActive}"><span class="tree-toggle" data-tree-toggle>▼</span><span class="tree-label" ${typeAttr}="month" ${valueAttr}="${monthValue}" ${labelAttr}="${escapeHtml(monthsNames[m])} ${y}">${escapeHtml(monthsNames[m])}</span></div><ul>`;
            Array.from(tree[y][m]).sort((a, b) => a - b).forEach((w) => {
                const weekValue = `${y}-${m}-${w}`;
                const isWActive = filters.some(filter => filter.type === 'week' && filter.val === weekValue) ? 'active-filter' : '';
                html += `<li><div class="tree-item ${isWActive}"><span class="tree-toggle" style="opacity: 0;"></span><span class="tree-label" ${typeAttr}="week" ${valueAttr}="${weekValue}" ${labelAttr}="${escapeHtml(monthsNames[m])}, Тиждень ${w}">Тиждень ${w}</span></div></li>`;
            });
            html += `</ul></li>`;
        });
        html += `</ul></li>`;
    });
    html += `</ul>`;
    return html;
}

function toggleStatsCompareFilter(type, val, labelName) {
    const filters = state.statsCompareFilters || [];
    if (type === 'all') {
        state.statsCompareFilters = filters.some(filter => filter.type === 'all-time')
            ? []
            : [{ type: 'all-time', val: 'all', label: 'За весь час' }];
        renderStatsTab();
        return;
    }

    let nextFilters = filters.filter(filter => filter.type !== 'all-time');
    if (nextFilters.some(filter => filter.type !== type)) nextFilters = [];
    const index = nextFilters.findIndex(filter => filter.type === type && filter.val === val);
    if (index > -1) {
        nextFilters.splice(index, 1);
    } else {
        nextFilters.push({ type, val, label: labelName });
    }
    state.statsCompareFilters = nextFilters;
    renderStatsTab();
}

function buildComparePaneSummary(entries, settings = {}) {
    let winDays = 0, lossDays = 0, beDays = 0;
    let grossProfit = 0, grossLoss = 0;
    let bestDay = 0, worstDay = 0;
    let totalComm = 0, totalLocates = 0;
    let dayTotals = [0, 0, 0, 0, 0];
    let periodCumData = [];
    let periodLabels = [];
    let periodSum = 0;
    const monthsNamesShort = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];

    entries.forEach((entry) => {
        const pnl = Number(entry.pnl) || 0;
        const entryData = entry.data || {};
        const costs = getEntryCosts(entryData);
        totalComm += costs.commissions;
        totalLocates += costs.locates;
        periodSum += pnl;
        periodCumData.push(parseFloat(periodSum.toFixed(2)));
        periodLabels.push(`${entry.dateObj.getDate()} ${monthsNamesShort[entry.dateObj.getMonth()]}`);
        const day = entry.dateObj.getDay();
        if (day >= 1 && day <= 5) dayTotals[day - 1] += pnl;
        if (pnl > bestDay) bestDay = pnl;
        if (pnl < worstDay) worstDay = pnl;
        const dayClass = classifyStatsPnlDay(pnl, settings, entry.dateStr, entry.breakevenBand);
        if (dayClass === 'win') { winDays++; grossProfit += pnl; }
        else if (dayClass === 'loss') { lossDays++; grossLoss += Math.abs(pnl); }
        else { beDays++; }
    });

    const totalDays = winDays + lossDays + beDays;
    const totalPnl = parseFloat(periodSum.toFixed(2));
    return {
        totalPnl,
        winrate: totalDays ? (winDays / totalDays) * 100 : 0,
        pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
        avgWin: winDays ? grossProfit / winDays : 0,
        avgLoss: lossDays ? grossLoss / lossDays : 0,
        bestDay,
        worstDay,
        totalDays,
        winDays,
        lossDays,
        beDays,
        totalComm,
        totalLocates,
        dayTotals,
        periodLabels,
        periodCumData,
        settings,
    };
}

function fmtSignedNumber(value) {
    if (!Number.isFinite(value)) return '—';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${value.toFixed(1)}`;
}

function setCompareDelta(id, value, options = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    const config = typeof options === 'boolean' ? { type: options ? 'percent-points' : 'percent' } : options;
    const directionValue = config.invert ? -(value || 0) : (value || 0);
    const cls = statsDeltaClass(directionValue);
    const icon = directionValue > 0 ? '▲' : directionValue < 0 ? '▼' : '•';
    const type = config.type || 'percent';
    const label = type === 'money'
        ? fmtMoney(value || 0)
        : type === 'number'
            ? fmtSignedNumber(value || 0)
            : type === 'percent-points'
                ? `${fmtSignedNumber(value || 0)}%`
                : fmtPercentChange(value);
    el.className = `stats-compare-inline-delta ${cls}`;
    el.textContent = `${icon} ${label}`;
    const card = el.closest('.stat-card');
    if (card) {
        card.classList.remove('stats-compare-card-positive', 'stats-compare-card-negative');
        if (cls === 'positive') card.classList.add('stats-compare-card-positive');
        if (cls === 'negative') card.classList.add('stats-compare-card-negative');
    }
}

function destroyCompareCharts() {
    ['comparePnlChartInstance', 'compareDaysChartInstance', 'compareWinLossChartInstance'].forEach((key) => {
        if (state[key]) {
            state[key].destroy();
            state[key] = null;
        }
    });
}

function renderCompareCharts(entries, summary, theme, advancedEquityMode = false) {
    const pnlCanvas = document.getElementById('compare-pnlChart');
    const daysCanvas = document.getElementById('compare-daysChart');
    const pieCanvas = document.getElementById('compare-winLossChart');
    if (!pnlCanvas || !daysCanvas || !pieCanvas) return;

    destroyCompareCharts();
    const equityAnalysis = buildStatsEquityAnalysis(entries, summary.periodCumData, summary.settings || {});
    const longHorizon = !!equityAnalysis.longHorizon;
    const peakEquity = Math.max(...equityAnalysis.rows.map(row => row.equity), 0);
    const worstDrawdownAbs = Math.abs(equityAnalysis.worstDrawdown);
    const advancedPointColors = equityAnalysis.rows.map((row, index) => {
        if (index === equityAnalysis.rows.length - 1) return theme.orange;
        if (row.equity === peakEquity && peakEquity > 0) return theme.profit;
        if (longHorizon) return statsDrawdownColor(row.drawdown, equityAnalysis.worstDrawdown, theme);
        if (row.dayClass === 'win' && (row.isNewHigh || row.positiveRun >= 2)) return theme.profit;
        if (row.dayClass === 'win') return '#14b8a6';
        if (row.drawdown < 0) return row.drawdownAbs >= worstDrawdownAbs * 0.6 ? theme.loss : theme.orange;
        return statsDrawdownColor(row.drawdown, equityAnalysis.worstDrawdown, theme);
    });
    const advancedPointRadius = equityAnalysis.rows.map((row, index) => {
        if (index === equityAnalysis.rows.length - 1) return 5;
        if (row.equity === peakEquity && peakEquity > 0) return 4;
        if (longHorizon) return 0;
        if (row.isNewHigh) return 4;
        if (row.dayClass === 'win') return 3;
        if (row.drawdown < 0 && row.drawdownAbs >= worstDrawdownAbs * 0.6) return 3;
        return summary.periodCumData.length > 70 ? 0 : 2;
    });
    pnlCanvas.$statsEquityZones = advancedEquityMode ? equityAnalysis.zones : [];
    pnlCanvas.$statsEquityRows = advancedEquityMode ? equityAnalysis.rows : [];
    pnlCanvas.$statsChartTheme = theme;
    state.comparePnlChartInstance = new Chart(pnlCanvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: summary.periodLabels,
            datasets: [
            ...(advancedEquityMode ? [{
                role: 'stats-equity-glow',
                data: summary.periodCumData,
                borderColor: (context) => {
                    const area = context.chart.chartArea;
                    if (!area) return statsColorWithAlpha(theme.profit, 0.18);
                    return buildStatsDrawdownGradient(context.chart.ctx, area, equityAnalysis.rows, equityAnalysis.worstDrawdown, theme.isLight ? 0.16 : 0.22, theme);
                },
                borderWidth: theme.isLight ? 7 : 9,
                pointRadius: 0,
                pointHoverRadius: 0,
                fill: false,
                tension: 0.4,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
                order: 2,
            }] : []),
            {
                role: 'stats-equity-main',
                data: summary.periodCumData,
                borderColor: advancedEquityMode
                    ? ((context) => {
                        const area = context.chart.chartArea;
                        if (!area) return theme.accent;
                        return buildStatsDrawdownGradient(context.chart.ctx, area, equityAnalysis.rows, equityAnalysis.worstDrawdown, 1, theme);
                    })
                    : theme.accent,
                backgroundColor: advancedEquityMode
                    ? ((context) => {
                        const area = context.chart.chartArea;
                        if (!area) return statsColorWithAlpha(theme.accent, 0.16);
                        return buildStatsDrawdownGradient(context.chart.ctx, area, equityAnalysis.rows, equityAnalysis.worstDrawdown, theme.isLight ? 0.1 : 0.15, theme);
                    })
                    : statsColorWithAlpha(theme.accent, 0.22),
                borderWidth: advancedEquityMode ? 4 : 2,
                pointRadius: advancedEquityMode ? advancedPointRadius : (summary.periodCumData.length > 60 ? 0 : 3),
                pointBackgroundColor: advancedEquityMode ? advancedPointColors : theme.panel,
                pointBorderColor: advancedEquityMode ? advancedPointColors : theme.accent,
                pointHoverBackgroundColor: advancedEquityMode ? advancedPointColors : theme.accent,
                pointHoverRadius: advancedEquityMode ? 7 : 5,
                pointBorderWidth: advancedEquityMode ? 2 : 1,
                fill: true,
                tension: 0.4,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
                order: 1,
            }]
        },
        plugins: advancedEquityMode ? [statsEquityZonesPlugin, statsZeroLinePlugin, statsFinalPointPlugin, statsKeyLabelsPlugin] : [],
        options: {
            animation: {
                duration: 800,
                easing: 'easeInOutQuart',
                x: { from: 0 }
            },
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: theme.panel,
                    borderColor: statsColorWithAlpha(theme.accent, theme.isLight ? 0.35 : 0.45),
                    borderWidth: 1,
                    titleColor: theme.text,
                    bodyColor: theme.accent,
                    padding: 10,
                    filter: item => item.dataset.role === 'stats-equity-main',
                    callbacks: {
                        label: ctx => ' ' + fmtMoney(ctx.parsed.y),
                        afterLabel: (ctx) => {
                            if (!advancedEquityMode) return '';
                            const row = equityAnalysis.rows[ctx.dataIndex];
                            if (!row) return '';
                            const stateLabel = row.isNewHigh
                                ? 'Новий пік'
                                : row.isRecovery
                                    ? 'Відновлення'
                                    : row.drawdown < 0
                                        ? 'Глобальний відкат'
                                        : 'Нейтрально';
                            return [
                                `День: ${fmtMoney(row.pnl)}`,
                                `Відкат: ${fmtMoneyAbs(row.drawdown)}`,
                                stateLabel,
                            ];
                        }
                    }
                }
            },
            scales: {
                y: {
                    grid: {
                        color: advancedEquityMode
                            ? ((context) => Number(context.tick.value) === 0 ? statsColorWithAlpha(theme.profit, 0.75) : theme.grid)
                            : theme.grid,
                        lineWidth: advancedEquityMode
                            ? ((context) => Number(context.tick.value) === 0 ? 1.6 : 1)
                            : 1,
                    },
                    ticks: { color: theme.muted, callback: v => fmtMoneyAbs(v) }
                },
                x: { grid: { display: false }, ticks: { color: theme.muted, maxTicksLimit: longHorizon ? 8 : 12 } }
            }
        }
    });

    daysCanvas.$statsGlowColor = theme.profit;
    state.compareDaysChartInstance = new Chart(daysCanvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'],
            datasets: [{
                data: summary.dayTotals.map(v => parseFloat(v.toFixed(2))),
                backgroundColor: summary.dayTotals.map(v => v >= 0 ? statsColorWithAlpha(theme.profit, 0.82) : statsColorWithAlpha(theme.loss, 0.82)),
                borderColor: summary.dayTotals.map(v => v >= 0 ? theme.profit : theme.loss),
                borderWidth: 2,
                borderRadius: 5,
                borderSkipped: false,
            }]
        },
        plugins: [statsBarGlowPlugin],
        options: {
            animation: {
                duration: 850,
                easing: 'easeOutQuart',
                delay: (context) => context.type === 'data' ? context.dataIndex * 80 : 0,
            },
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmtMoney(ctx.parsed.y) } } },
            scales: {
                y: { grid: { color: theme.grid }, ticks: { color: theme.muted, callback: v => fmtMoneyAbs(v) } },
                x: { grid: { display: false }, ticks: { color: theme.muted } }
            }
        }
    });

    pieCanvas.$statsGlowColor = theme.profit;
    state.compareWinLossChartInstance = new Chart(pieCanvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Плюс', 'Мінус', 'Нуль'],
            datasets: [{
                data: [summary.winDays, summary.lossDays, summary.beDays],
                backgroundColor: [theme.profit, theme.loss, '#94a3b8'].map(c => statsColorWithAlpha(c, 0.86)),
                borderColor: [theme.panel, theme.panel, theme.panel],
                borderWidth: 2,
                hoverOffset: 8,
            }]
        },
        plugins: [statsBarGlowPlugin],
        options: {
            animation: {
                animateRotate: true,
                animateScale: true,
                duration: 900,
                easing: 'easeOutQuart',
            },
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: theme.muted, boxWidth: 12, boxHeight: 12, padding: 10, font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} дн.` } }
            }
        }
    });
}

function renderStatsComparePanel(validEntries) {
    const toggle = document.getElementById('stats-compare-toggle');
    const shell = document.querySelector('.stats-compare-shell');
    const pane = document.getElementById('stats-compare-pane');
    if (!toggle || !pane || !shell) return;

    toggle.setAttribute('aria-expanded', state.statsCompareMode ? 'true' : 'false');
    toggle.setAttribute('aria-pressed', state.statsCompareMode ? 'true' : 'false');
    toggle.classList.toggle('stats-compare-toggle--active', state.statsCompareMode);
    shell.classList.toggle('stats-compare-shell--active', state.statsCompareMode);
    pane.classList.toggle('initially-hidden', !state.statsCompareMode);
    pane.setAttribute('aria-hidden', state.statsCompareMode ? 'false' : 'true');

    if (!state.statsCompareMode) {
        destroyCompareCharts();
        return;
    }

    normalizeCompareSourceSelection();
    if (!state.statsCompareContext?.journal || Object.keys(state.statsCompareContext.journal).length === 0) {
        state.statsCompareContext = {
            journal: state.currentStatsContext.journal || {},
            label: getStatsSelectionLabel(state.statsCompareSourceSelection.type, state.statsCompareSourceSelection.key),
            tradeTypes: state.currentStatsContext.tradeTypes || state.appData.tradeTypes || [],
            settings: state.currentStatsContext.settings || state.appData.settings || {}
        };
    }

    const sourceTrigger = document.getElementById('stats-compare-source-trigger');
    const sourcePanel = document.getElementById('stats-compare-source-panel');
    const sourceContainer = document.getElementById('stats-compare-source-container');
    if (sourceContainer) {
        sourceContainer.innerHTML = getStatsSourceOptionsHtml(state.statsCompareSourceSelection, 'compare');
        if (!sourceContainer.dataset.compareSourceBound) {
            sourceContainer.dataset.compareSourceBound = 'true';
            sourceContainer.addEventListener('click', (event) => {
                const button = event.target?.closest?.('[data-compare-stats-source-type]');
                if (!button || !sourceContainer.contains(button)) return;
                closeStatsDropdown('compareSource');
                void selectStatsCompareSource(button.dataset.compareStatsSourceType, button.dataset.compareStatsSourceKey || '');
            });
        }
    }
    if (sourceTrigger && sourcePanel && !sourceTrigger.dataset.compareSourceBound) {
        sourceTrigger.dataset.compareSourceBound = 'true';
        sourceTrigger.addEventListener('click', () => {
            const isOpen = !sourcePanel.classList.contains('open');
            closeStatsDropdown();
            setCompareDropdownState('source', isOpen);
        });
    }

    const tradeTypes = state.statsCompareContext.tradeTypes || [];
    if (state.statsCompareTradeTypeFilter && !tradeTypes.includes(state.statsCompareTradeTypeFilter)) {
        state.statsCompareTradeTypeFilter = null;
    }
    const tradeTrigger = document.getElementById('stats-compare-tradetype-trigger');
    const tradePanel = document.getElementById('stats-compare-tradetype-panel');
    const tradeContainer = document.getElementById('stats-compare-tradetype-container');
    if (tradeContainer) {
        const currentTradeType = state.statsCompareTradeTypeFilter;
        tradeContainer.innerHTML = [
            `<button class="stats-source-btn${!currentTradeType ? ' active' : ''}" data-compare-trade-type-filter="">Всі типи</button>`,
            ...tradeTypes.map(type => `<button class="stats-source-btn${currentTradeType === type ? ' active' : ''}" data-compare-trade-type-filter="${escapeHtml(type)}">${escapeHtml(type)}</button>`)
        ].join('');
        if (!tradeContainer.dataset.compareTradeTypeBound) {
            tradeContainer.dataset.compareTradeTypeBound = 'true';
            tradeContainer.addEventListener('click', (event) => {
                const button = event.target?.closest?.('[data-compare-trade-type-filter]');
                if (!button || !tradeContainer.contains(button)) return;
                closeStatsDropdown('compareTradeType');
                selectStatsCompareTradeType(button.dataset.compareTradeTypeFilter || null);
            });
        }
    }
    if (tradeTrigger && tradePanel && !tradeTrigger.dataset.compareTradeTypeBound) {
        tradeTrigger.dataset.compareTradeTypeBound = 'true';
        tradeTrigger.addEventListener('click', () => {
            const isOpen = !tradePanel.classList.contains('open');
            closeStatsDropdown();
            setCompareDropdownState('tradetype', isOpen);
        });
    }

    const compareValidEntries = buildStatsEntriesFromJournal(
        state.statsCompareContext.journal || {},
        state.statsCompareTradeTypeFilter
    );
    state.statsCompareScale = getStatsScaleFromFilters(state.statsCompareFilters);
    const periodTrigger = document.getElementById('stats-compare-period-trigger');
    const periodPanel = document.getElementById('stats-compare-period-panel');
    const periodTree = document.getElementById('stats-compare-tree-container');
    const periodLabel = document.getElementById('stats-compare-period-label');
    const comparePeriodLabel = getStatsPeriodLabel(state.statsCompareFilters, '2 місяці');
    setText('stats-compare-source-label', getStatsSelectionLabel(state.statsCompareSourceSelection.type, state.statsCompareSourceSelection.key));
    setText('stats-compare-tradetype-label', state.statsCompareTradeTypeFilter || 'Всі типи');

    if (periodLabel) periodLabel.textContent = comparePeriodLabel;
    setText('compare-stats-period-title', comparePeriodLabel);
    if (periodTree) {
        periodTree.innerHTML = compareValidEntries.length
            ? buildStatsPeriodTreeHtml(compareValidEntries, state.statsCompareFilters || [], 'compare-stats')
            : '<div class="stats-empty-note">Немає періодів для цього джерела.</div>';
        if (!periodTree.dataset.compareTreeBound) {
            periodTree.dataset.compareTreeBound = 'true';
            periodTree.addEventListener('click', (event) => {
                const toggle = event.target?.closest?.('[data-tree-toggle]');
                if (toggle && periodTree.contains(toggle)) {
                    toggleTree(toggle);
                    return;
                }
                const label = event.target?.closest?.('[data-compare-stats-filter-type]');
                if (!label || !periodTree.contains(label)) return;
                const type = label.dataset.compareStatsFilterType;
                const raw = label.dataset.compareStatsFilterValue || '';
                const value = type === 'year' ? Number(raw) : raw || null;
                toggleStatsCompareFilter(type, value, label.dataset.compareStatsFilterLabel || label.textContent || '');
            });
        }
    }
    if (periodTrigger && periodPanel && !periodTrigger.dataset.comparePeriodBound) {
        periodTrigger.dataset.comparePeriodBound = 'true';
        periodTrigger.addEventListener('click', () => {
            const isOpen = !periodPanel.classList.contains('open');
            closeStatsDropdown();
            setCompareDropdownState('period', isOpen);
        });
    }

    const baseEntries = filterEntriesByStatsFilters(validEntries, state.activeFilters);
    const compareEntries = filterEntriesByStatsFilters(compareValidEntries, state.statsCompareFilters || []);
    const base = buildComparePaneSummary(baseEntries, state.currentStatsContext.settings || state.appData.settings || {});
    const compare = buildComparePaneSummary(compareEntries, state.statsCompareContext.settings || {});
    const pfDelta = compare.pf - base.pf;

    const cssGreen = getComputedStyle(document.documentElement).getPropertyValue('--profit').trim() || '#10b981';
    const cssRed = getComputedStyle(document.documentElement).getPropertyValue('--loss').trim() || '#ef4444';
    const cssGold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#eab308';
    const cssText = getComputedStyle(document.documentElement).getPropertyValue('--text-main').trim() || '#f8fafc';
    const cssAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
    const cssBgPanel = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() || '#1e293b';
    const theme = buildStatsChartTheme(cssGreen, cssRed, cssAccent, cssBgPanel, cssText);
    theme.profit = cssGreen;
    theme.loss = cssRed;
    theme.accent = cssAccent;
    theme.panel = cssBgPanel;
    theme.orange = theme.orange || '#f97316';

    const baseEquity = buildStatsEquityAnalysis(baseEntries, base.periodCumData, state.currentStatsContext.settings || state.appData.settings || {});
    const compareEquity = buildStatsEquityAnalysis(compareEntries, compare.periodCumData, state.statsCompareContext.settings || {});
    const compareAdvancedToggle = document.getElementById('compare-stats-equity-advanced-toggle');
    if (compareAdvancedToggle) compareAdvancedToggle.checked = !!state.statsCompareEquityAdvancedMode;
    setText('compare-stat-total-pnl', fmtMoney(compare.totalPnl));
    setText('compare-stat-winrate', `${compare.winrate.toFixed(1)}%`);
    setText('compare-stat-pf', fmtPlainNumber(compare.pf));
    setText('compare-stat-avg-win', fmtMoney(compare.avgWin));
    setText('compare-stat-avg-loss', compare.lossDays > 0 ? '-' + fmtMoneyAbs(compare.avgLoss) : fmtMoney(0));
    setText('compare-stat-best', fmtMoney(compare.bestDay));
    setText('compare-stat-worst', fmtMoney(compare.worstDay));
    setText('compare-stat-trade-days', String(compare.totalDays));
    setText('compare-stat-max-dd', fmtMoneyAbs(compareEquity.worstDrawdown || 0));
    setText('compare-stat-comm', fmtMoneyAbs(compare.totalComm || 0));
    setText('compare-stat-locates', fmtMoneyAbs(compare.totalLocates || 0));

    const compareCommEl = document.getElementById('compare-stat-comm');
    const compareLocatesEl = document.getElementById('compare-stat-locates');
    if (state.statsCompareTradeTypeFilter) {
        if (compareCommEl) compareCommEl.closest('.stat-card').style.display = 'none';
        if (compareLocatesEl) compareLocatesEl.closest('.stat-card').style.display = 'none';
    } else {
        if (compareCommEl) compareCommEl.closest('.stat-card').style.display = '';
        if (compareLocatesEl) compareLocatesEl.closest('.stat-card').style.display = '';
    }

    const totalPnlEl = document.getElementById('compare-stat-total-pnl');
    if (totalPnlEl) totalPnlEl.style.color = compare.totalPnl >= 0 ? cssGreen : cssRed;
    const comparePfEl = document.getElementById('compare-stat-pf');
    if (comparePfEl) comparePfEl.style.color = compare.pf > 1.5 ? cssGreen : compare.pf < 1 ? cssRed : cssGold;

    setCompareDelta('compare-delta-total-pnl', compare.totalPnl - base.totalPnl, { type: 'money' });
    setCompareDelta('compare-delta-winrate', compare.winrate - base.winrate, { type: 'percent-points' });
    setCompareDelta('compare-delta-pf', Number.isFinite(pfDelta) ? pfDelta : 0, { type: 'number' });
    setCompareDelta('compare-delta-avg-win', compare.avgWin - base.avgWin, { type: 'money' });
    setCompareDelta('compare-delta-avg-loss', compare.avgLoss - base.avgLoss, { type: 'money', invert: true });
    setCompareDelta('compare-delta-best', compare.bestDay - base.bestDay, { type: 'money' });
    setCompareDelta('compare-delta-worst', compare.worstDay - base.worstDay, { type: 'money' });
    setCompareDelta('compare-delta-trade-days', compare.totalDays - base.totalDays, { type: 'number' });
    setCompareDelta('compare-delta-max-dd', Math.abs(compareEquity.worstDrawdown || 0) - Math.abs(baseEquity.worstDrawdown || 0), { type: 'money', invert: true });
    setCompareDelta('compare-delta-comm', (compare.totalComm || 0) - (base.totalComm || 0), { type: 'money', invert: true });
    setCompareDelta('compare-delta-locates', (compare.totalLocates || 0) - (base.totalLocates || 0), { type: 'money', invert: true });
    renderCompareCharts(compareEntries, compare, theme, !!state.statsCompareEquityAdvancedMode);
}

function renderStatsInsights({
    filteredEntries,
    dayTotals,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    totalPnl,
    equityAnalysis,
    settings = {},
}) {
    const insightsEl = document.getElementById('stats-insights-list');
    if (!insightsEl) return;

    const pfNumber = profitFactor === '∞' ? Infinity : parseFloat(profitFactor);
    const winRateNumber = parseFloat(winRate) || 0;
    const avgWinNumber = parseFloat(avgWin) || 0;
    const avgLossNumber = parseFloat(avgLoss) || 0;
    const insights = [];
    const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
    const pnlValues = filteredEntries.map(entry => Number(entry.pnl) || 0);
    const lastFive = pnlValues.slice(-5);
    const prevFive = pnlValues.slice(-10, -5);
    const lastFivePnl = lastFive.reduce((sum, pnl) => sum + pnl, 0);
    const prevFivePnl = prevFive.reduce((sum, pnl) => sum + pnl, 0);
    const maxDayAbs = Math.max(...pnlValues.map(value => Math.abs(value)), 0);
    const avgAbsDay = pnlValues.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, pnlValues.length);
    const lastEquity = equityAnalysis?.rows?.at?.(-1)?.equity || 0;
    const peakEquity = Math.max(...(equityAnalysis?.rows || []).map(row => row.equity), 0);

    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    filteredEntries.forEach((entry) => {
        const pnl = Number(entry.pnl) || 0;
        const dayClass = classifyStatsPnlDay(pnl, settings, entry.dateStr, entry.breakevenBand);
        if (dayClass === 'win') {
            currentWinStreak += 1;
            currentLossStreak = 0;
        } else if (dayClass === 'loss') {
            currentLossStreak += 1;
            currentWinStreak = 0;
        } else {
            currentWinStreak = 0;
            currentLossStreak = 0;
        }
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    });

    if (!filteredEntries.length) {
        insightsEl.innerHTML = '<div class="stats-empty-note">Немає даних для поточного фільтра.</div>';
        return;
    }

    if (filteredEntries.length < 5) {
        insights.push({ tone: 'warn', text: 'Вибірка мала: висновки можуть сильно змінитись після кількох нових днів.' });
    }

    if (Number.isFinite(pfNumber) && pfNumber < 1) insights.push({ tone: 'bad', text: 'Profit Factor нижче 1.00: збитки переважають прибуток.' });
    else if (pfNumber >= 1.5) insights.push({ tone: 'good', text: 'Profit Factor вище 1.50: система має здоровий запас.' });
    else insights.push({ tone: 'warn', text: 'Profit Factor у нейтральній зоні: варто підсилити якість входів.' });

    if (avgLossNumber > avgWinNumber && avgWinNumber > 0) {
        insights.push({ tone: 'bad', text: `Середній мінус більший за середній плюс у ${(avgLossNumber / avgWinNumber).toFixed(1)}x.` });
    } else if (avgWinNumber > 0 && avgLossNumber > 0) {
        insights.push({ tone: 'good', text: `Середній плюс перекриває мінус у ${(avgWinNumber / avgLossNumber).toFixed(1)}x.` });
    }

    if (winRateNumber < 45 && totalPnl < 0) insights.push({ tone: 'bad', text: 'Winrate і PnL одночасно слабкі: потрібен фільтр сетапів.' });
    if (Math.abs(equityAnalysis?.worstDrawdown || 0) > Math.abs(totalPnl) && totalPnl > 0) {
        insights.push({ tone: 'warn', text: 'Max drawdown більший за поточний профіт: результат нестабільний.' });
    }

    if (lastFive.length >= 3) {
        const tone = lastFivePnl > prevFivePnl ? 'good' : lastFivePnl < 0 ? 'bad' : 'warn';
        insights.push({ tone, text: `Останні ${lastFive.length} дн.: ${fmtMoney(lastFivePnl)}${prevFive.length ? ` проти ${fmtMoney(prevFivePnl)} перед цим` : ''}.` });
    }

    if (maxLossStreak >= 3) insights.push({ tone: 'bad', text: `Максимальна серія мінусів: ${maxLossStreak} дн. Варто перевірити stop-rule після 2 збитків.` });
    else if (maxWinStreak >= 3) insights.push({ tone: 'good', text: `Найкраща серія плюсів: ${maxWinStreak} дн. Є періоди стабільного виконання.` });

    if (Array.isArray(dayTotals) && dayTotals.length) {
        const bestIdx = dayTotals.reduce((best, value, index) => value > dayTotals[best] ? index : best, 0);
        const worstIdx = dayTotals.reduce((worst, value, index) => value < dayTotals[worst] ? index : worst, 0);
        if (dayTotals[bestIdx] > 0) insights.push({ tone: 'good', text: `Найсильніший день тижня: ${dayNames[bestIdx]} (${fmtMoney(dayTotals[bestIdx])}).` });
        if (dayTotals[worstIdx] < 0) insights.push({ tone: 'bad', text: `Найслабший день тижня: ${dayNames[worstIdx]} (${fmtMoney(dayTotals[worstIdx])}). Можливо, там потрібен жорсткіший фільтр.` });
    }

    if (avgAbsDay > 0 && maxDayAbs > avgAbsDay * 3 && filteredEntries.length >= 8) {
        insights.push({ tone: 'warn', text: `Результат сильно залежить від одного великого дня (${fmtMoneyAbs(maxDayAbs)}). Перевір стабільність без нього.` });
    }

    if (peakEquity > 0) {
        const distanceFromHigh = peakEquity - lastEquity;
        if (distanceFromHigh <= peakEquity * 0.05) insights.push({ tone: 'good', text: 'Equity близько до максимуму: поточний режим працює без глибокої просадки.' });
        else if (distanceFromHigh > Math.abs(equityAnalysis?.worstDrawdown || 0) * 0.6) insights.push({ tone: 'warn', text: `До equity high ще ${fmtMoneyAbs(distanceFromHigh)}: зараз важлива якість відновлення.` });
    }

    insightsEl.innerHTML = insights.slice(0, 6).map(item => `
        <div class="stats-insight stats-insight--${item.tone}">
            <span class="stats-insight-dot"></span>
            <span>${escapeHtml(item.text)}</span>
        </div>
    `).join('');
}

export function renderStatsTab() {
    if (typeof Chart === 'undefined') {
        ensureChartJs()
            .then(() => renderStatsTab())
            .catch((error) => console.warn('[Stats] Chart.js lazy-load failed:', error));
        return;
    }
    let statsJournal = state.currentStatsContext.journal || {};
    const ttFilter = state.activeTradeTypeFilter;
    const isAllTime = state.activeFilters.some(f => f.type === 'all-time');
    const sel = state.statsSourceSelection;
    let validEntries = [];
    for (let d in statsJournal) {
        let data = statsJournal[d];
        if (!d.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
        let pnl;
        if (ttFilter) {
            let ttVal = data.tradeTypesData && data.tradeTypesData[ttFilter];
            if (!ttVal || ttVal.pnl === '' || ttVal.pnl === undefined || ttVal.pnl === null) continue;
            pnl = parseFloat(ttVal.pnl);
        } else {
            if (data.pnl === null || data.pnl === undefined || data.pnl === '') continue;
            pnl = parseFloat(data.pnl);
        }
        if (!isNaN(pnl)) {
            let parts = d.split('-');
            validEntries.push({
                dateStr: d,
                dateObj: new Date(parts[0], parts[1]-1, parts[2]),
                pnl,
                data,
                breakevenBand: Number(data.__statsBreakevenBand),
            });
        }
    }
    validEntries.sort((a, b) => a.dateObj - b.dateObj);
    renderStatsComparePanel(validEntries);
    
    let cssGreen = getComputedStyle(document.documentElement).getPropertyValue('--profit').trim() || '#10b981';
    let cssRed = getComputedStyle(document.documentElement).getPropertyValue('--loss').trim() || '#ef4444';
    let cssGold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#eab308';
    let cssText = getComputedStyle(document.documentElement).getPropertyValue('--text-main').trim() || '#f8fafc';
    let cssAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
    let cssBgPanel = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() || '#1e293b';

    let filteredEntries = [];
    if (state.activeFilters.length === 0 || isAllTime) {
        filteredEntries = validEntries;
        document.getElementById('stats-period-label').innerText = isAllTime ? 'За весь час' : '2 місяці';
    } else {
        let labels = state.activeFilters.map(f => f.label).join(', '); 
        document.getElementById('stats-period-label').innerText = labels.length > 45 ? labels.substring(0, 42) + '...' : labels;
        for (let e of validEntries) {
            let include = false;
            for (let filter of state.activeFilters) {
                if (filter.type === 'year' && e.dateObj.getFullYear() == filter.val) { include = true; break; }
                if (filter.type === 'month') { let p = filter.val.split('-'); if (e.dateObj.getFullYear() == p[0] && e.dateObj.getMonth() == p[1]) { include = true; break; } }
                if (filter.type === 'week') { let p = filter.val.split('-'); if (e.dateObj.getFullYear() == p[0] && e.dateObj.getMonth() == p[1] && getWeekOfMonth(e.dateObj) == p[2]) { include = true; break; } }
            }
            if (include) filteredEntries.push(e);
        }
    }

    let winDays = 0, lossDays = 0, beDays = 0;
    let grossProfit = 0, grossLoss = 0;
    let bestDay = 0, worstDay = 0;
    let dayTotals = [0, 0, 0, 0, 0]; 
    let totalComm = 0, totalLocates = 0;
    
    let periodLabels = []; let periodCumData = []; let periodSum = 0;
    let monthsNamesShort = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
    let isBroadView = isAllTime || state.activeFilters.length === 0 || state.activeFilters.some(f => f.type === 'year' || f.type === 'all');

    for (let e of filteredEntries) {
        let pnl = e.pnl;
        let entryData = e.data || statsJournal[e.dateStr] || {};
        if (!ttFilter) {
            const costs = getEntryCosts(entryData);
            totalComm += costs.commissions;
            totalLocates += costs.locates;
        }
        
        periodSum += pnl; periodCumData.push(parseFloat(periodSum.toFixed(2)));
        if (isBroadView) { periodLabels.push(`${e.dateObj.getDate()} ${monthsNamesShort[e.dateObj.getMonth()]}`); } else { periodLabels.push(e.dateObj.getDate().toString()); }
        let day = e.dateObj.getDay(); if (day >= 1 && day <= 5) { dayTotals[day-1] += pnl; }
        if (pnl > bestDay) bestDay = pnl;
        if (pnl < worstDay) worstDay = pnl;
        const dayClass = classifyStatsPnlDay(pnl, state.currentStatsContext.settings || {}, e.dateStr, e.breakevenBand);
        if (dayClass === 'win') { winDays++; grossProfit += pnl; }
        else if (dayClass === 'loss') { lossDays++; grossLoss += Math.abs(pnl); }
        else { beDays++; }
    }

    let totalDays = winDays + lossDays + beDays;
    let winRate = totalDays > 0 ? ((winDays / totalDays) * 100).toFixed(1) : 0;
    let profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : '0.00');
    let avgWin = winDays > 0 ? (grossProfit / winDays).toFixed(2) : '0.00';
    let avgLoss = lossDays > 0 ? (grossLoss / lossDays).toFixed(2) : '0.00';
    const totalPnl = parseFloat(periodSum.toFixed(2));
    
    document.getElementById('stat-winrate').innerText = `${winRate}%`;
    document.getElementById('stat-pf').innerText = profitFactor;
    document.getElementById('stat-avg-win').innerText = fmtMoney(parseFloat(avgWin));
    document.getElementById('stat-avg-loss').innerText = lossDays > 0 ? '-' + fmtMoneyAbs(parseFloat(avgLoss)) : fmtMoney(0);
    document.getElementById('stat-best').innerText = fmtMoney(bestDay);
    document.getElementById('stat-worst').innerText = fmtMoney(worstDay);
    setText('stat-trade-days', String(totalDays));
    let stComm = document.getElementById('stat-comm'); 
    let stLoc = document.getElementById('stat-locates');
    if (ttFilter) {
        if (stComm) stComm.closest('.stat-card').style.display = 'none';
        if (stLoc) stLoc.closest('.stat-card').style.display = 'none';
    } else {
        if (stComm) { stComm.closest('.stat-card').style.display = ''; stComm.innerText = fmtMoneyAbs(totalComm); }
        if (stLoc) { stLoc.closest('.stat-card').style.display = ''; stLoc.innerText = fmtMoneyAbs(totalLocates); }
    }

    const totalPnlEl = document.getElementById('stat-total-pnl');
    if (totalPnlEl) {
        if (isAllTime) {
            totalPnlEl.innerText = (ttFilter ? `[${ttFilter}] ` : '') + fmtMoney(totalPnl);
            totalPnlEl.style.color = totalPnl >= 0 ? cssGreen : cssRed;
        } else {
            totalPnlEl.innerText = (ttFilter ? `[${ttFilter}] ` : '') + fmtMoney(totalPnl);
            totalPnlEl.style.color = totalPnl >= 0 ? cssGreen : cssRed;
        }
    }

    let pfEl = document.getElementById('stat-pf');
    if (profitFactor !== '∞' && parseFloat(profitFactor) > 1.5) pfEl.style.color = cssGreen; else if (profitFactor !== '∞' && parseFloat(profitFactor) < 1) pfEl.style.color = cssRed; else pfEl.style.color = cssGold;
    
    const advancedEquityMode = !!state.statsEquityAdvancedMode;
    const advancedToggle = document.getElementById('stats-equity-advanced-toggle');
    if (advancedToggle) advancedToggle.checked = advancedEquityMode;

    const statsChartTheme = buildStatsChartTheme(cssGreen, cssRed, cssAccent, cssBgPanel, cssText);
    const equityAnalysis = buildStatsEquityAnalysis(filteredEntries, periodCumData, state.currentStatsContext.settings || {});
    setText('stat-max-dd', fmtMoneyAbs(equityAnalysis.worstDrawdown || 0));
    renderStatsInsights({
        filteredEntries,
        dayTotals,
        winRate,
        profitFactor,
        avgWin,
        avgLoss,
        totalPnl,
        equityAnalysis,
        settings: state.currentStatsContext.settings || {},
    });
    const longHorizon = !!equityAnalysis.longHorizon;
    const worstDrawdownAbs = Math.abs(equityAnalysis.worstDrawdown);
    const peakEquity = Math.max(...equityAnalysis.rows.map(row => row.equity), 0);
    const advancedPointColors = equityAnalysis.rows.map((row, index) => {
        if (index === equityAnalysis.rows.length - 1) return statsChartTheme.orange;
        if (row.equity === peakEquity && peakEquity > 0) return statsChartTheme.profit;
        if (longHorizon) return statsDrawdownColor(row.drawdown, equityAnalysis.worstDrawdown, statsChartTheme);
        if (row.dayClass === 'win' && (row.isNewHigh || row.positiveRun >= 2)) return statsChartTheme.profit;
        if (row.dayClass === 'win') return '#14b8a6';
        if (row.drawdown < 0) return row.drawdownAbs >= worstDrawdownAbs * 0.6 ? statsChartTheme.loss : statsChartTheme.orange;
        return statsDrawdownColor(row.drawdown, equityAnalysis.worstDrawdown, statsChartTheme);
    });
    const advancedPointRadius = equityAnalysis.rows.map((row, index) => {
        if (index === equityAnalysis.rows.length - 1) return 5;
        if (row.equity === peakEquity && peakEquity > 0) return 4;
        if (longHorizon) return 0;
        if (row.isNewHigh) return 4;
        if (row.dayClass === 'win') return 3;
        if (row.drawdown < 0 && row.drawdownAbs >= worstDrawdownAbs * 0.6) return 3;
        return periodCumData.length > 70 ? 0 : 2;
    });

    const ctxPeriod = document.getElementById('pnlChart').getContext('2d');
    ctxPeriod.canvas.$statsEquityZones = advancedEquityMode ? equityAnalysis.zones : [];
    ctxPeriod.canvas.$statsEquityRows = advancedEquityMode ? equityAnalysis.rows : [];
    ctxPeriod.canvas.$statsChartTheme = statsChartTheme;
    if (state.pnlChartInstance) state.pnlChartInstance.destroy();
    state.pnlChartInstance = new Chart(ctxPeriod, {
        type: 'line',
        data: {
            labels: periodLabels,
            datasets: [
            ...(advancedEquityMode ? [{
                role: 'stats-equity-glow',
                data: periodCumData,
                borderColor: (context) => {
                    const area = context.chart.chartArea;
                    if (!area) return statsColorWithAlpha(statsChartTheme.profit, 0.18);
                    return buildStatsDrawdownGradient(context.chart.ctx, area, equityAnalysis.rows, equityAnalysis.worstDrawdown, statsChartTheme.isLight ? 0.16 : 0.22, statsChartTheme);
                },
                borderWidth: statsChartTheme.isLight ? 7 : 9,
                pointRadius: 0,
                pointHoverRadius: 0,
                fill: false,
                tension: 0.4,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
                order: 2,
            }] : []),
            {
                role: 'stats-equity-main',
                data: periodCumData,
                borderColor: advancedEquityMode
                    ? ((context) => {
                        const area = context.chart.chartArea;
                        if (!area) return cssAccent;
                        return buildStatsDrawdownGradient(context.chart.ctx, area, equityAnalysis.rows, equityAnalysis.worstDrawdown, 1, statsChartTheme);
                    })
                    : cssAccent,
                backgroundColor: advancedEquityMode
                    ? ((context) => {
                        const area = context.chart.chartArea;
                        if (!area) return statsColorWithAlpha(cssAccent, 0.16);
                        return buildStatsDrawdownGradient(context.chart.ctx, area, equityAnalysis.rows, equityAnalysis.worstDrawdown, statsChartTheme.isLight ? 0.1 : 0.15, statsChartTheme);
                    })
                    : cssAccent + '33',
                borderWidth: advancedEquityMode ? 4 : 2,
                pointBackgroundColor: advancedEquityMode ? advancedPointColors : cssBgPanel,
                pointBorderColor: advancedEquityMode ? advancedPointColors : cssAccent,
                pointHoverBackgroundColor: advancedEquityMode ? advancedPointColors : cssAccent,
                pointRadius: advancedEquityMode ? advancedPointRadius : (periodCumData.length > 60 ? 0 : 3),
                pointHoverRadius: advancedEquityMode ? 7 : 5,
                pointBorderWidth: advancedEquityMode ? 2 : 1,
                fill: true,
                tension: 0.4,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
                order: 1,
            }]
        },
        plugins: advancedEquityMode ? [statsEquityZonesPlugin, statsZeroLinePlugin, statsFinalPointPlugin, statsKeyLabelsPlugin] : [],
        options: {
            animation: {
                duration: 800,
                easing: 'easeInOutQuart',
                x: { from: 0 }
            },
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: cssBgPanel,
                    borderColor: statsColorWithAlpha(statsChartTheme.accent, statsChartTheme.isLight ? 0.35 : 0.45),
                    borderWidth: 1,
                    titleColor: statsChartTheme.text,
                    bodyColor: statsChartTheme.accent,
                    padding: 10,
                    filter: item => item.dataset.role === 'stats-equity-main',
                    callbacks: {
                        label: ctx => ' ' + fmtMoney(ctx.parsed.y),
                        afterLabel: (ctx) => {
                            if (!advancedEquityMode) return '';
                            const row = equityAnalysis.rows[ctx.dataIndex];
                            if (!row) return '';
                            const stateLabel = row.isNewHigh
                                ? 'Новий пік'
                                : row.isRecovery
                                    ? 'Відновлення'
                                    : row.drawdown < 0
                                        ? 'Глобальний відкат'
                                        : 'Нейтрально';
                            return [
                                `День: ${fmtMoney(row.pnl)}`,
                                `Відкат: ${fmtMoneyAbs(row.drawdown)}`,
                                stateLabel,
                            ];
                        }
                    }
                }
            },
            scales: {
                y: {
                    grid: {
                        color: advancedEquityMode
                            ? ((context) => Number(context.tick.value) === 0 ? statsColorWithAlpha(statsChartTheme.profit, 0.75) : statsChartTheme.grid)
                            : 'rgba(100,116,139,0.15)',
                        lineWidth: advancedEquityMode
                            ? ((context) => Number(context.tick.value) === 0 ? 1.6 : 1)
                            : 1,
                    },
                    ticks: { color: advancedEquityMode ? statsChartTheme.muted : cssText, callback: v => fmtMoneyAbs(v) }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: advancedEquityMode ? statsChartTheme.muted : cssText, maxTicksLimit: longHorizon ? 8 : 12 }
                }
            }
        }
    });

    const ctxDays = document.getElementById('daysChart').getContext('2d');
    ctxDays.canvas.$statsGlowColor = cssGreen;
    if (state.daysChartInstance) state.daysChartInstance.destroy();
    state.daysChartInstance = new Chart(ctxDays, {
        type: 'bar',
        data: {
            labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'],
            datasets: [{
                data: dayTotals.map(v => parseFloat(v.toFixed(2))),
                backgroundColor: dayTotals.map(v => v >= 0 ? statsColorWithAlpha(cssGreen, 0.82) : statsColorWithAlpha(cssRed, 0.82)),
                borderColor: dayTotals.map(v => v >= 0 ? cssGreen : cssRed),
                borderWidth: 2,
                borderRadius: 5,
                borderSkipped: false,
            }]
        },
        plugins: [statsBarGlowPlugin],
        options: {
            animation: {
                duration: 850,
                easing: 'easeOutQuart',
                delay: (context) => context.type === 'data' ? context.dataIndex * 80 : 0,
            },
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ' ' + fmtMoney(ctx.parsed.y) } }
            },
            scales: {
                y: {
                    grid: { color: statsChartTheme.grid },
                    ticks: { color: statsChartTheme.muted, callback: v => fmtMoneyAbs(v) }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: statsChartTheme.muted }
                }
            }
        }
    });
    
    const ctxPie = document.getElementById('winLossChart').getContext('2d');
    ctxPie.canvas.$statsGlowColor = cssGreen;
    if (state.winLossChartInstance) state.winLossChartInstance.destroy();
    state.winLossChartInstance = new Chart(ctxPie, {
        type: 'doughnut',
        data: {
            labels: ['Плюс', 'Мінус', 'Нуль'],
            datasets: [{
                data: [winDays, lossDays, beDays],
                backgroundColor: [cssGreen, cssRed, '#94a3b8'].map(c => statsColorWithAlpha(c, 0.86)),
                borderColor: [cssBgPanel, cssBgPanel, cssBgPanel],
                borderWidth: 2,
                hoverOffset: 8,
            }]
        },
        plugins: [statsBarGlowPlugin],
        options: {
            animation: {
                animateRotate: true,
                animateScale: true,
                duration: 900,
                easing: 'easeOutQuart',
            },
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: statsChartTheme.muted,
                        boxWidth: 12,
                        boxHeight: 12,
                        padding: 10,
                        font: { size: 11 }
                    }
                },
                tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} дн.` } }
            }
        }
    });

    renderMistakeChart(filteredEntries, cssRed, cssText, cssBgPanel);
}
