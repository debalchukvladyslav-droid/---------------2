// === js/storage.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { normalizeAppData, normalizeDayEntry, getDefaultAppData } from './data_utils.js';
import { loadPlaybook } from './playbook.js';
import { clearStatsCache } from './stats.js';
import { uploadToSupabaseStorage, deleteFromSupabaseStorage, getSupabaseStorageUrl } from './supabase_storage.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';

function monthKey(dateStr) {
    return dateStr.slice(0, 7);
}

function getMonthsInJournal(journal) {
    const months = new Set();
    for (const d in journal) months.add(monthKey(d));
    return months;
}

function getMonthRange(mk) {
    const [year, month] = mk.split('-').map(Number);
    const start = `${mk}-01`;
    const end = `${mk}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
    return { start, end };
}

function getUserScopedStorageKey(key, userId) {
    return `pj:${userId || 'anon'}:${key}`;
}

async function getCurrentSupabaseUser() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    return user || null;
}

const _profileIdCache = new Map();

export function setCurrentViewedUserId(userId) {
    const normalizedUserId = userId || null;
    state.currentViewedUserId = normalizedUserId;
    if (typeof window !== 'undefined') window.currentViewedUserId = normalizedUserId;
    return normalizedUserId;
}

export function getCurrentViewedUserId(userId = null) {
    const resolvedUserId = userId
        || state.currentViewedUserId
        || (typeof window !== 'undefined' ? window.currentViewedUserId : null)
        || null;

    if (resolvedUserId !== state.currentViewedUserId) {
        setCurrentViewedUserId(resolvedUserId);
    } else if (typeof window !== 'undefined' && window.currentViewedUserId !== resolvedUserId) {
        window.currentViewedUserId = resolvedUserId;
    }

    return resolvedUserId;
}

export async function resolveViewedUserId(docName = state.CURRENT_VIEWED_USER, options = {}) {
    if (!docName) return setCurrentViewedUserId(null);

    const { force = false, syncGlobal = true } = options;
    if (!force && _profileIdCache.has(docName)) {
        const cachedUserId = _profileIdCache.get(docName) || null;
        if (syncGlobal) setCurrentViewedUserId(cachedUserId);
        return cachedUserId;
    }

    const nick = String(docName).replace(/_stats$/, '');
    const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('nick', nick)
        .maybeSingle();

    if (error) throw error;

    const resolvedUserId = data?.id || null;
    _profileIdCache.set(docName, resolvedUserId);
    if (syncGlobal) setCurrentViewedUserId(resolvedUserId);
    return resolvedUserId;
}

async function getCurrentUserContext() {
    const user = await getCurrentSupabaseUser();
    return {
        user,
        userId: user?.id || null,
        email: user?.email || ''
    };
}

function dayEntryToJournalRow(userId, tradeDate, entry) {
    const day = normalizeDayEntry(entry);

    return {
        user_id: userId,
        trade_date: tradeDate,
        pnl: day.pnl,
        gross_pnl: day.gross_pnl,
        commissions: day.commissions,
        locates: day.locates,
        kf: day.kf,
        notes: day.notes || '',
        mentor_comment: typeof day.mentor_comment === 'string' ? day.mentor_comment : '',
        ai_advice: typeof day.ai_advice === 'string' ? day.ai_advice : '',
        daily_metrics: {
            errors: Array.isArray(day.errors) ? day.errors : [],
            checkedParams: Array.isArray(day.checkedParams) ? day.checkedParams : [],
            sliders: day.sliders && typeof day.sliders === 'object' ? day.sliders : {},
            tradeTypesData: day.tradeTypesData && typeof day.tradeTypesData === 'object' ? day.tradeTypesData : {},
            screenshots: day.screenshots && typeof day.screenshots === 'object'
                ? day.screenshots
                : { good: [], normal: [], bad: [], error: [] },
            tickers: day.tickers && typeof day.tickers === 'object' ? day.tickers : {},
            traded_tickers: Array.isArray(day.traded_tickers) ? day.traded_tickers : [],
            fondexx: day.fondexx && typeof day.fondexx === 'object'
                ? day.fondexx
                : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            ppro: day.ppro && typeof day.ppro === 'object'
                ? day.ppro
                : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            sessionGoal: day.sessionGoal ?? '',
            sessionPlan: day.sessionPlan ?? '',
            sessionReadiness: day.sessionReadiness ?? null,
            sessionSetups: Array.isArray(day.sessionSetups) ? day.sessionSetups : [],
            sessionAiResult: day.sessionAiResult ?? '',
            sessionDone: day.sessionDone ?? false,
            trades: Array.isArray(day.trades) ? day.trades : [],
            review_requests: day.review_requests && typeof day.review_requests === 'object' ? day.review_requests : {},
        }
    };
}

function journalRowToDayEntry(row) {
    const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};

    return normalizeDayEntry({
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
        fondexx: metrics.fondexx,
        ppro: metrics.ppro,
        sessionGoal: metrics.sessionGoal,
        sessionPlan: metrics.sessionPlan,
        sessionReadiness: metrics.sessionReadiness,
        sessionSetups: metrics.sessionSetups || [],
        sessionAiResult: metrics.sessionAiResult,
        sessionDone: metrics.sessionDone,
        trades: metrics.trades || [],
        review_requests: metrics.review_requests && typeof metrics.review_requests === 'object' ? metrics.review_requests : {},
    });
}

function journalRowToMonthEntry(row) {
    return {
        ...normalizeDayEntry({
            pnl: row?.pnl ?? null,
            gross_pnl: row?.gross_pnl ?? null
        }),
        id: row?.id ?? null,
        user_id: row?.user_id ?? null,
        trade_date: row?.trade_date ?? null,
        __detailsLoaded: false
    };
}

function markDayEntryDetailsLoaded(entry, loaded) {
    return {
        ...normalizeDayEntry(entry),
        __detailsLoaded: loaded
    };
}

let _journalSaveQueue = Promise.resolve();
let _settingsSaveQueue = Promise.resolve();
const _dirtyJournalDates = new Set();
const _dayDetailsPromises = new Map();
const _tradeDaysLoadedFor = new Set();

export function saveToLocal() {
    return Promise.all([saveJournalData(), saveSettingsQueued()])
        .catch(e => console.error('saveToLocal queue error:', e));
}

export function saveJournalData(opts = {}) {
    const run = _journalSaveQueue
        .catch(() => {})
        .then(() => _doSave(opts));

    _journalSaveQueue = run.catch(e => {
        console.error('saveJournalData queue error:', e);
    });

    return run;
}

export function markJournalDayDirty(dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
        _dirtyJournalDates.add(dateStr);
    }
}

export function markJournalDaysDirty(dateStrs = []) {
    dateStrs.forEach(markJournalDayDirty);
}

export function markAllJournalDirty() {
    const journal = state.appData?.journal || {};
    Object.keys(journal).forEach(markJournalDayDirty);
}

function saveSettingsQueued() {
    _settingsSaveQueue = _settingsSaveQueue
        .then(() => saveSettings())
        .catch(e => console.error('saveSettings queue error:', e));
    return _settingsSaveQueue;
}

export async function saveSettings() {
    try {
        const { user } = await getCurrentUserContext();
        if (!user) return;
        const settingsPayload = {
            ...state.appData.settings,
            aiChatHistory: Array.isArray(state.appData.aiChatHistory) ? state.appData.aiChatHistory : [],
            aiSavedChats: Array.isArray(state.appData.aiSavedChats) ? state.appData.aiSavedChats : [],
            errorTypes: Array.isArray(state.appData.errorTypes) ? state.appData.errorTypes : [],
            learnCache: state.appData.learnCache && typeof state.appData.learnCache === 'object' ? state.appData.learnCache : null,
            tickers: state.appData.tickers && typeof state.appData.tickers === 'object' ? state.appData.tickers : {},
            tradeTypes: Array.isArray(state.appData.tradeTypes) ? state.appData.tradeTypes : [],
            unassignedImages: Array.isArray(state.appData.unassignedImages) ? state.appData.unassignedImages : [],
            screenTags: state.appData.screenTags && typeof state.appData.screenTags === 'object' ? state.appData.screenTags : {},
            screenDiscipline:
                state.appData.screenDiscipline && typeof state.appData.screenDiscipline === 'object'
                    ? state.appData.screenDiscipline
                    : {},
            weeklyComments:
                state.appData.weeklyComments && typeof state.appData.weeklyComments === 'object' ? state.appData.weeklyComments : {},
        };
        const { error } = await supabase
            .from('profiles')
            .update({ settings: settingsPayload })
            .eq('id', user.id);
        if (error) throw error;
        console.log('✅ Settings збережено в Supabase');
    } catch (e) {
        console.error('❌ Помилка збереження settings:', e);
    }
}

export async function loadSettings() {
    try {
        const { user } = await getCurrentUserContext();
        if (!user) return;
        const { data, error } = await supabase
            .from('profiles')
            .select('settings')
            .eq('id', user.id)
            .single();
        if (error) throw error;
        if (data?.settings && typeof data.settings === 'object') {
            const incoming = { ...data.settings };
            if (Array.isArray(incoming.unassignedImages)) {
                state.appData.unassignedImages = incoming.unassignedImages;
                delete incoming.unassignedImages;
            }
            if (Array.isArray(incoming.aiChatHistory)) {
                state.appData.aiChatHistory = incoming.aiChatHistory;
                delete incoming.aiChatHistory;
            }
            if (Array.isArray(incoming.aiSavedChats)) {
                state.appData.aiSavedChats = incoming.aiSavedChats;
                delete incoming.aiSavedChats;
            }
            if (Array.isArray(incoming.errorTypes)) {
                state.appData.errorTypes = incoming.errorTypes;
                delete incoming.errorTypes;
            }
            if (incoming.learnCache && typeof incoming.learnCache === 'object') {
                state.appData.learnCache = incoming.learnCache;
                delete incoming.learnCache;
            }
            if (incoming.tickers && typeof incoming.tickers === 'object') {
                state.appData.tickers = incoming.tickers;
                delete incoming.tickers;
            }
            if (Array.isArray(incoming.tradeTypes)) {
                state.appData.tradeTypes = incoming.tradeTypes;
                delete incoming.tradeTypes;
            }
            if (incoming.screenTags && typeof incoming.screenTags === 'object') {
                state.appData.screenTags = incoming.screenTags;
                delete incoming.screenTags;
            }
            if (incoming.screenDiscipline && typeof incoming.screenDiscipline === 'object') {
                state.appData.screenDiscipline = incoming.screenDiscipline;
                delete incoming.screenDiscipline;
            }
            if (incoming.weeklyComments && typeof incoming.weeklyComments === 'object') {
                state.appData.weeklyComments = incoming.weeklyComments;
                delete incoming.weeklyComments;
            }
            state.appData.settings = { ...state.appData.settings, ...incoming };
            console.log('✅ Settings завантажено з Supabase');
        }
    } catch (e) {
        console.error('❌ Помилка завантаження settings:', e);
    }
}

export async function saveMonth() {
    markAllJournalDirty();
    return saveJournalData();
}

async function _doSave(opts = {}) {
    const forceFull = !!opts.forceFull;
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        console.log('Режим глядача: базове збереження заблоковано.');
        return;
    }

    try {
        const { user, userId, email } = await getCurrentUserContext();
        if (!user || !userId) throw new Error('Немає авторизованого користувача Supabase');

        const journal = state.appData.journal || {};
        const dirtyDates = [..._dirtyJournalDates].filter(dateStr => journal[dateStr]?.__detailsLoaded !== false);

        if (!forceFull && dirtyDates.length === 0) {
            console.log('[journal] немає «брудних» днів — upsert у journal_days пропущено');
            return;
        }

        const sourceEntries = forceFull
            ? Object.entries(journal)
            : dirtyDates.map((dateStr) => [dateStr, journal[dateStr]]);

        const entries = sourceEntries
            .filter(([dateStr, entry]) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && entry?.__detailsLoaded !== false);

        const rows = entries.map(([dateStr, entry]) => {
            const row = dayEntryToJournalRow(userId, dateStr, entry);
            row.daily_metrics.user_email = email;
            return row;
        });

        for (let i = 0; i < rows.length; i += 200) {
            const { error } = await supabase
                .from('journal_days')
                .upsert(rows.slice(i, i + 200), { onConflict: 'user_id,trade_date' });

            if (error) throw error;
        }

        clearStatsCache(state.USER_DOC_NAME);
        entries.forEach(([dateStr]) => _dirtyJournalDates.delete(dateStr));
        if (forceFull) _dirtyJournalDates.clear();
        state._availableMonthKeys = getMonthsInJournal(journal);
        state._monthListLoaded = true;
        console.log('✅ Дані днів успішно збережено в Supabase!');
    } catch (e) {
        console.error('❌ Помилка збереження днів у Supabase:', e);
        throw e;
    }
}

function _computeAggregation(journal) {
    let allTimePnl = 0;
    let allTimeWinDays = 0;
    let allTimeLossDays = 0;
    let allTimeBeDays = 0;

    for (const dateStr in journal) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
        const pnl = parseFloat(journal[dateStr]?.pnl);
        if (isNaN(pnl) || journal[dateStr]?.pnl === '' || journal[dateStr]?.pnl === null) continue;

        allTimePnl += pnl;
        if (pnl > 0) allTimeWinDays++;
        else if (pnl < 0) allTimeLossDays++;
        else allTimeBeDays++;
    }

    return {
        allTimePnl: parseFloat(allTimePnl.toFixed(2)),
        allTimeWinDays,
        allTimeLossDays,
        allTimeBeDays,
    };
}

export async function loadMonth(nick, mk, userId = null) {
    if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
    if (state.loadedMonths[nick].has(mk)) {
        console.log(`[LOAD] Кеш: ${mk} вже в пам'яті, запит пропущено`);
        return;
    }

    const targetUserId = getCurrentViewedUserId(userId) || await resolveViewedUserId(nick);
    if (!targetUserId) { console.warn('[LOAD] loadMonth: currentViewedUserId не встановлено'); return; }

    try {
        const { start, end } = getMonthRange(mk);
        const { data, error } = await supabase
            .from('journal_days')
            .select('id, user_id, trade_date, pnl, gross_pnl')
            .eq('user_id', targetUserId)
            .gte('trade_date', start)
            .lte('trade_date', end)
            .order('trade_date', { ascending: true });

        if (error) throw error;

        (data || []).forEach(row => {
            const dateStr = row.trade_date;
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                state.appData.journal[dateStr] = journalRowToMonthEntry(row);
            }
        });

        state.loadedMonths[nick].add(mk);
        if (!state._availableMonthKeys) state._availableMonthKeys = new Set();
        state._availableMonthKeys.add(mk);
        console.log(`[LOAD] ✅ ${mk}: завантажено ${(data || []).length} днів із Supabase`);
    } catch (e) {
        console.error(`❌ Помилка завантаження місяця ${mk}:`, e);
    }
}

export async function loadDayDetails(dateStr, userId = null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

    const existing = state.appData.journal[dateStr];
    if (existing?.__detailsLoaded) return existing;

    const targetUserId = getCurrentViewedUserId(userId) || await resolveViewedUserId(state.CURRENT_VIEWED_USER);
    if (!targetUserId) {
        console.warn(`[LOAD] loadDayDetails: missing userId for ${dateStr}`);
        return existing || null;
    }

    const requestKey = `${targetUserId}:${dateStr}`;
    if (_dayDetailsPromises.has(requestKey)) {
        return _dayDetailsPromises.get(requestKey);
    }

    const request = (async () => {
        const user = true;
        const userId = targetUserId;
        try {
            if (!user || !userId) throw new Error('РќРµРјР°С” Р°РІС‚РѕСЂРёР·РѕРІР°РЅРѕРіРѕ РєРѕСЂРёСЃС‚СѓРІР°С‡Р° Supabase');

            const { data, error } = await supabase
                .from('journal_days')
                .select('*')
                .eq('user_id', targetUserId)
                .eq('trade_date', dateStr)
                .maybeSingle();

            if (error) throw error;

            if (!data) {
                const fallbackEntry = markDayEntryDetailsLoaded(existing || {}, true);
                state.appData.journal[dateStr] = fallbackEntry;
                return fallbackEntry;
            }

            const fullEntry = {
                ...journalRowToDayEntry(data),
                id: data?.id ?? null,
                user_id: data?.user_id ?? null,
                trade_date: data?.trade_date ?? dateStr,
                __detailsLoaded: true
            };

            state.appData.journal[dateStr] = fullEntry;
            return fullEntry;
        } catch (e) {
            console.error(`[LOAD] Day details failed for ${dateStr}:`, e);
            return existing || null;
        } finally {
            _dayDetailsPromises.delete(requestKey);
        }
    })();

    _dayDetailsPromises.set(requestKey, request);
    return request;
}

export async function loadAllMonths(nick, userId = null) {
    const targetUserId = getCurrentViewedUserId(userId) || await resolveViewedUserId(nick);
    if (!targetUserId) { console.warn('[LOAD] loadAllMonths: currentViewedUserId не встановлено'); return; }

    try {
        const { data, error } = await supabase
            .from('journal_days')
            .select('*')
            .eq('user_id', targetUserId)
            .gte('trade_date', '2024-01-01')
            .lte('trade_date', '2030-12-31')
            .order('trade_date', { ascending: true });

        if (error) throw error;

        if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
        state._availableMonthKeys = new Set();

        (data || []).forEach(row => {
            const dateStr = row.trade_date;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

            state.appData.journal[dateStr] = markDayEntryDetailsLoaded(journalRowToDayEntry(row), true);
            const mk = monthKey(dateStr);
            state.loadedMonths[nick].add(mk);
            state._availableMonthKeys.add(mk);
        });

        state._monthListLoaded = true;
        console.log(`[LOAD] loadAllMonths: завантажено ${(data || []).length} днів із Supabase`);
    } catch (e) {
        console.error(`Помилка завантаження всіх місяців для ${nick}:`, e);
    }
}

export async function loadTradeDays(nick = state.CURRENT_VIEWED_USER, userId = null, options = {}) {
    const targetUserId = getCurrentViewedUserId(userId) || await resolveViewedUserId(nick);
    if (!targetUserId) { console.warn('[LOAD] loadTradeDays: currentViewedUserId не встановлено'); return; }

    const cacheKey = `${targetUserId}:trade-days`;
    if (!options.force && _tradeDaysLoadedFor.has(cacheKey)) return;

    try {
        const { data, error } = await supabase
            .from('journal_days')
            .select('*')
            .eq('user_id', targetUserId)
            .gte('trade_date', '2024-01-01')
            .lte('trade_date', '2030-12-31')
            .order('trade_date', { ascending: true });

        if (error) throw error;

        if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
        if (!state._availableMonthKeys) state._availableMonthKeys = new Set();

        (data || []).forEach(row => {
            const dateStr = row.trade_date;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

            const fullEntry = markDayEntryDetailsLoaded(journalRowToDayEntry(row), true);
            if (!Array.isArray(fullEntry.trades) || fullEntry.trades.length === 0) return;

            const currentEntry = state.appData.journal[dateStr];
            if (Array.isArray(currentEntry?.trades) && currentEntry.trades.length > 0 && currentEntry.__detailsLoaded !== false) {
                return;
            }

            state.appData.journal[dateStr] = {
                ...(currentEntry || {}),
                ...fullEntry,
            };

            const mk = monthKey(dateStr);
            state.loadedMonths[nick].add(mk);
            state._availableMonthKeys.add(mk);
        });

        _tradeDaysLoadedFor.add(cacheKey);
        console.log(`[LOAD] loadTradeDays: завантажено ${(data || []).length} рядків, угоди змерджено у state`);
    } catch (e) {
        console.error('[LOAD] Помилка завантаження днів з угодами:', e);
    }
}

function showLoadingToast(msg, persistent = false, withRetry = false) {
    let t = document.getElementById('_load-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = '_load-toast';
        t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid var(--border);color:var(--text-main);padding:10px 20px;border-radius:8px;z-index:99999;font-size:0.9rem;transition:opacity 0.3s;text-align:center;';
        document.body.appendChild(t);
    }

    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));

    if (withRetry) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block;margin:8px auto 0;padding:6px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:0.9rem;';
        btn.textContent = '🔄 Повторити';
        btn.addEventListener('click', () => window.retryInitApp?.());
        t.appendChild(btn);
    }

    t.style.opacity = '1';
    t.style.display = 'block';
    if (!persistent) setTimeout(hideLoadingToast, 3000);
}

function hideLoadingToast() {
    const t = document.getElementById('_load-toast');
    if (t) {
        t.style.opacity = '0';
        setTimeout(() => { t.style.display = 'none'; }, 300);
    }
}

export async function initializeApp() {
    console.log('⏳ Завантаження бази даних для:', state.CURRENT_VIEWED_USER);
    showGlobalLoader('app-init', 'Завантаження журналу...');

    try {
        const nick = state.CURRENT_VIEWED_USER;
        const viewedUserId = getCurrentViewedUserId() || await resolveViewedUserId(nick, { force: true });
        if (!viewedUserId) throw new Error(`Не вдалося визначити userId для ${nick}`);
        const previousAppData = state.appData && typeof state.appData === 'object' ? state.appData : {};

        state.appData = normalizeAppData({
            ...getDefaultAppData(),
            ...previousAppData,
            journal: {}
        });

        state.loadedMonths[nick] = new Set();
        state._allMonthsLoaded = false;
        state._monthListLoaded = false;
        state._availableMonthKeys = new Set();

        const now = state.todayObj;
        const currentMk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevMk = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

        await Promise.all([
            loadSettings(),
            loadMonth(nick, currentMk, viewedUserId),
            loadMonth(nick, prevMk, viewedUserId),
            loadPlaybook(),
        ]);

        if (state.selectedDateStr) {
            const selMk = monthKey(state.selectedDateStr);
            if (selMk !== currentMk && selMk !== prevMk) {
                await loadMonth(nick, selMk, viewedUserId);
            }
        }

        state.appData.unassignedImages = Array.isArray(state.appData.unassignedImages)
            ? state.appData.unassignedImages
            : [];

        const s = state.appData.settings;
        const themeRadio = document.getElementById('theme-' + (s.theme || 'dark'));
        const fontRadio = document.getElementById('font-' + (s.font || 'inter'));
        const daylossInput = document.getElementById('setting-dayloss-limit');

        if (themeRadio) themeRadio.checked = true;
        if (fontRadio) fontRadio.checked = true;
        if (daylossInput) daylossInput.value = s.defaultDayloss || -100;

        if (s.theme === 'custom' && s.customTheme) {
            ['bg-main', 'bg-panel', 'text-main', 'accent', 'profit', 'loss'].forEach((f, i) => {
                const el = document.getElementById(`ct-${f}`);
                if (el) el.value = s.customTheme[['bgMain', 'bgPanel', 'textMain', 'accent', 'profit', 'loss'][i]];
            });
        }

        if (window.initSelectors) window.initSelectors();
        state.statsSourceSelection = { type: 'current', key: state.CURRENT_VIEWED_USER };
        if (window.applyTheme) window.applyTheme();
        if (window.updateAutoFlags) window.updateAutoFlags().then(() => { if (window.renderView) window.renderView(); });
        if (window.renderErrorsList) window.renderErrorsList();
        if (window.renderSettingsChecklist) window.renderSettingsChecklist();
        if (window.renderSettingsSliders) window.renderSettingsSliders();
        if (window.renderMyTradeTypes) window.renderMyTradeTypes();
        if (window.loadImages) window.loadImages();
        if (window.renderView) window.renderView();
        if (window.selectDate) window.selectDate(state.selectedDateStr);
        if (window.applyAccessRights) window.applyAccessRights();
        if (window.updateDriveUI) window.updateDriveUI();
    } catch (e) {
        console.error('Data load failed:', e);
        state.appData = normalizeAppData(getDefaultAppData());
        showLoadingToast('❌ Не вдалося завантажити дані.', true, true);
    } finally {
        hideGlobalLoader('app-init');
        hideLoadingToast();
    }
}

export async function uploadBackground(file, userId) {
    const safeName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
    const storagePath = `backgrounds/${userId}/${safeName}`;
    await uploadToSupabaseStorage(storagePath, file);

    if (!Array.isArray(state.appData.backgrounds)) state.appData.backgrounds = [];
    if (!state.appData.backgrounds.includes(storagePath)) {
        state.appData.backgrounds.push(storagePath);
    }
    state.appData.activeBackground = storagePath;

    localStorage.setItem(getUserScopedStorageKey('backgrounds', userId), JSON.stringify(state.appData.backgrounds));
    localStorage.setItem(getUserScopedStorageKey('activeBackground', userId), storagePath);

    return storagePath;
}

export async function setActiveBackground(url, userId) {
    state.appData.activeBackground = url;
    localStorage.setItem(getUserScopedStorageKey('activeBackground', userId), url);
}

export async function deleteBackground(url, userId) {
    try {
        await deleteFromSupabaseStorage(url);
    } catch (e) {
        console.warn('[BgDelete]', e);
    }

    state.appData.backgrounds = (state.appData.backgrounds || []).filter(u => u !== url);
    if (state.appData.activeBackground === url) {
        state.appData.activeBackground = null;
    }

    localStorage.setItem(getUserScopedStorageKey('backgrounds', userId), JSON.stringify(state.appData.backgrounds));
    if (state.appData.activeBackground) {
        localStorage.setItem(getUserScopedStorageKey('activeBackground', userId), state.appData.activeBackground);
    } else {
        localStorage.removeItem(getUserScopedStorageKey('activeBackground', userId));
    }
}

export function loadBackgroundGallery() {
    const container = document.getElementById('bg-gallery-list');
    if (!container) return;

    const urls = state.appData.backgrounds || [];
    const active = state.appData.activeBackground || '';

    if (!urls.length) {
        container.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem;">Немає збережених фонів</span>';
        return;
    }

    container.innerHTML = '';
    urls.forEach(url => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;flex-shrink:0;';

        const img = document.createElement('img');
        img.src = '';
        img.title = 'Натисніть, щоб встановити';
        img.style.cssText = [
            'width:72px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;',
            'border:2px solid', url === active ? 'var(--accent)' : 'transparent', ';',
            'transition:border-color 0.2s;',
        ].join('');
        img.onclick = () => window._setActiveBackground?.(url);
        getSupabaseStorageUrl(url).then(src => {
            img.src = src;
        }).catch(() => {
            img.src = url;
        });

        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = 'Видалити';
        del.style.cssText = [
            'position:absolute;top:-6px;right:-6px;',
            'background:var(--loss);color:#fff;border:none;border-radius:50%;',
            'width:18px;height:18px;font-size:0.65rem;cursor:pointer;',
            'display:flex;align-items:center;justify-content:center;line-height:1;',
        ].join('');
        del.onclick = (e) => { e.stopPropagation(); window._deleteBackground?.(url); };

        wrap.appendChild(img);
        wrap.appendChild(del);
        container.appendChild(wrap);
    });
}

export async function exportData() {
    const targetDocName = state.CURRENT_VIEWED_USER || state.USER_DOC_NAME;
    const nick = targetDocName.replace(/_stats$/, '');

    showLoadingToast('⏳ Підготовка експорту...', true);
    showGlobalLoader('export-data', 'Підготовка експорту...');

    try {
        // Отримуємо user_id для поточного профілю що переглядається
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('nick', nick)
            .maybeSingle();

        if (profileError) throw profileError;
        if (!profile?.id) throw new Error(`Профіль "${nick}" не знайдено`);

        const targetUserId = profile.id;

        const { data: rows, error: rowsError } = await supabase
            .from('journal_days')
            .select('*')
            .eq('user_id', targetUserId)
            .gte('trade_date', '2024-01-01')
            .lte('trade_date', '2030-12-31')
            .order('trade_date', { ascending: true });

        if (rowsError) throw rowsError;

        const journal = {};
        (rows || []).forEach(row => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(row.trade_date)) {
                journal[row.trade_date] = journalRowToDayEntry(row);
            }
        });

        const year = new Date().getFullYear();
        const payload = { nick, exportedAt: new Date().toISOString(), journal };
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
        const dl = document.createElement('a');
        dl.setAttribute('href', dataStr);
        dl.setAttribute('download', `export_${nick}_${year}.json`);
        document.body.appendChild(dl);
        dl.click();
        dl.remove();
    } catch (e) {
        console.error('❌ Помилка експорту:', e);
        showGlobalLoader('export-data', 'Помилка експорту', { type: 'error' });
        hideGlobalLoader('export-data', 2600);
        showLoadingToast('❌ Помилка експорту: ' + (e?.message || 'Невідома помилка'));
        setTimeout(hideLoadingToast, 3000);
        return;
    }

    showGlobalLoader('export-data', 'Експорт готовий', { type: 'success' });
    hideGlobalLoader('export-data', 1400);
    hideLoadingToast();
}

export function importData(event) {
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        alert('❌ Імпорт заборонено: ви переглядаєте чужий профіль.');
        event.target.value = '';
        return;
    }

    const file = event.target.files[0];
    if (!file) return;
    showGlobalLoader('import-data', 'Читання файлу імпорту...');

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            showGlobalLoader('import-data', 'Імпорт даних у Supabase...');
            const imported = JSON.parse(e.target.result);
            state.appData = normalizeAppData(imported);
            state.loadedMonths = {};
            markAllJournalDirty();
            await saveToLocal();
            await initializeApp();
            showGlobalLoader('import-data', 'Дані імпортовано', { type: 'success' });
            hideGlobalLoader('import-data', 1600);
            setTimeout(() => showLoadingToast('✅ Дані успішно імпортовано!'), 300);
            setTimeout(hideLoadingToast, 3300);
        } catch (err) {
            showGlobalLoader('import-data', 'Помилка імпорту', { type: 'error' });
            hideGlobalLoader('import-data', 2600);
            showLoadingToast('❌ Помилка файлу.');
            setTimeout(hideLoadingToast, 2500);
        }
    };
    reader.onerror = function() {
        showGlobalLoader('import-data', 'Не вдалося прочитати файл', { type: 'error' });
        hideGlobalLoader('import-data', 2600);
    };

    reader.readAsText(file);
    event.target.value = '';
}
