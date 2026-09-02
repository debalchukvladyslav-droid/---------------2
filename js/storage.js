// === js/storage.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { normalizeAppData, normalizeDayEntry, getDefaultAppData, normalizeTradeTypesList } from './data_utils.js';
import { clearStatsCache } from './stats.js';
import { ensureSupabaseStorageUser, uploadToSupabaseStorage, deleteFromSupabaseStorage, getSupabaseStorageUrl } from './supabase_storage.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';
import { createCompressedBackup } from './backups.js';
import {
    cacheJournalRows, cacheValue, markJournalRowsSynced, publishSyncState,
    readCachedDay, readCachedMonth, readCachedValue, readDirtyJournalRows,
} from './local_data_store.js';

let tradeEmbeddingQueue = Promise.resolve();
let tradeEmbeddingTimer = null;
let pendingEmbeddingDays = [];

async function syncTradeEmbeddings(savedDays) {
    const ids = [...new Set((savedDays || []).map((row) => row?.id).filter(Boolean))];
    // gte-small is CPU intensive. One durable journal day per invocation keeps
    // the Edge worker below its resource ceiling; unchanged trades are skipped
    // by the function using their content hash.
    for (let i = 0; i < ids.length; i += 1) {
        const { error } = await supabase.functions.invoke('embed-trade', {
            body: { journal_day_ids: [ids[i]] },
        });
        if (error) throw error;
        if (i < ids.length - 1) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

function enqueueTradeEmbeddingSync(savedDays) {
    pendingEmbeddingDays.push(...(savedDays || []));
    clearTimeout(tradeEmbeddingTimer);
    tradeEmbeddingTimer = setTimeout(() => {
        const unique = [...new Map(pendingEmbeddingDays.map((row) => [row?.id, row])).values()].filter((row) => row?.id);
        pendingEmbeddingDays = [];
        tradeEmbeddingQueue = tradeEmbeddingQueue
            .catch(() => undefined)
            .then(() => syncTradeEmbeddings(unique))
            .catch((error) => {
                // Embeddings are optional derived data. Edge overloads (546),
                // timeouts and provider failures must never become an unhandled
                // rejection or affect journal synchronization.
                console.warn('[trade-memory] background sync deferred:', error?.message || error);
                return undefined;
            });
    }, 30000);
    return tradeEmbeddingQueue;
}

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

export function resetRuntimeDataForAccountSwitch() {
    _dirtyJournalDates.clear();
    _journalDateRevisions.clear();
    _dayDetailsPromises.clear();
    _tradeDaysLoadedFor.clear();
    state.appData = normalizeAppData(getDefaultAppData());
    state.currentUnassignedImages = [];
    state.unassignedVisibleCount = 5;
    state.currentZoomedSrc = '';
    state.loadedMonths = {};
    state.statsDocCache = {};
    state.currentStatsContext = { journal: {}, label: 'Мій профіль' };
    state.statsCompareContext = { journal: {}, label: 'Мій профіль', tradeTypes: [] };
    state.statsSourceSelection = { type: 'current', key: '' };
    state.statsCompareSourceSelection = { type: 'current', key: '' };
    state.activeTradeTypeFilter = null;
    state.statsCompareTradeTypeFilter = null;
    state.statsComparePeriodKey = '';
    state._allMonthsLoaded = false;
    state._monthListLoaded = false;
    state._availableMonthKeys = new Set();
    state.autoFlagsCache = { records: new Set(), absoluteRecord: null };
    clearStatsCache();
}

// Journal requests and dirty-date protection are global runtime state. They must
// not survive a switch to another team member, otherwise matching calendar dates
// from the previous profile can suppress the newly loaded rows.
export function resetJournalLoadStateForProfileSwitch() {
    _dirtyJournalDates.clear();
    _journalDateRevisions.clear();
    _dayDetailsPromises.clear();
    _tradeDaysLoadedFor.clear();
    state.loadedMonths = {};
    state._allMonthsLoaded = false;
    state._monthListLoaded = false;
    state._availableMonthKeys = new Set();
}

function isCurrentProfileRequest(nick, userId) {
    return state.CURRENT_VIEWED_USER === nick && getCurrentViewedUserId() === userId;
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
            sheetSync: {
                grossSource: day.sheetGrossSource || '',
                grossValue: day.sheetGrossValue ?? null,
                tradeTypesSource: day.sheetTradeTypesSource || '',
                calendarOnly: day.sheetCalendarOnly === true,
                legacyPnlSource: day.sheetPnlSource || '',
                tradeTypesEnabled: day.sheetTradeTypesSyncEnabled === true,
            },
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
            fondexxSource: typeof day.fondexxSource === 'string' ? day.fondexxSource : '',
            pproSource: typeof day.pproSource === 'string' ? day.pproSource : '',
            traderAbsent: day.traderAbsent === true,
            demoTrading: day.demoTrading === true,
            sessionGoal: day.sessionGoal ?? '',
            sessionPlan: day.sessionPlan ?? '',
            sessionReadiness: day.sessionReadiness ?? null,
            sessionSetups: Array.isArray(day.sessionSetups) ? day.sessionSetups : [],
            sessionAiResult: day.sessionAiResult ?? '',
            sessionDone: day.sessionDone ?? false,
            sessionStartRecorded: day.sessionStartRecorded === true,
            nextSessionImprovement: day.nextSessionImprovement ?? '',
            sessionReviewDone: day.sessionReviewDone ?? false,
            sessionEndRecorded: day.sessionEndRecorded === true,
            sessionReviewCompletedAt: day.sessionReviewCompletedAt ?? '',
            trades: Array.isArray(day.trades) ? day.trades : [],
            tradePolygons: day.tradePolygons && typeof day.tradePolygons === 'object' ? day.tradePolygons : {},
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
        sheetGrossSource: metrics.sheetSync?.grossSource || '',
        sheetGrossValue: metrics.sheetSync?.grossValue ?? null,
        sheetTradeTypesSource: metrics.sheetSync?.tradeTypesSource || '',
        sheetCalendarOnly: metrics.sheetSync?.calendarOnly === true,
        sheetPnlSource: metrics.sheetSync?.legacyPnlSource || '',
        sheetTradeTypesSyncEnabled: metrics.sheetSync?.tradeTypesEnabled === true,
        screenshots: metrics.screenshots || { good: [], normal: [], bad: [], error: [] },
        tickers: metrics.tickers || {},
        traded_tickers: metrics.traded_tickers || [],
        fondexx: metrics.fondexx,
        fondexxSource: metrics.fondexxSource,
        ppro: metrics.ppro,
        pproSource: metrics.pproSource,
        traderAbsent: metrics.traderAbsent === true,
        demoTrading: metrics.demoTrading === true,
        sessionGoal: metrics.sessionGoal,
        sessionPlan: metrics.sessionPlan,
        sessionReadiness: metrics.sessionReadiness,
        sessionSetups: metrics.sessionSetups || [],
        sessionAiResult: metrics.sessionAiResult,
        sessionDone: metrics.sessionDone,
        sessionStartRecorded: metrics.sessionStartRecorded === true || metrics.sessionDone === true
            || String(metrics.sessionGoal || '').trim() !== '' || String(metrics.sessionPlan || '').trim() !== '',
        nextSessionImprovement: metrics.nextSessionImprovement,
        sessionReviewDone: metrics.sessionReviewDone,
        sessionEndRecorded: metrics.sessionEndRecorded === true || metrics.sessionReviewDone === true
            || String(metrics.sessionReviewCompletedAt || '').trim() !== '',
        sessionReviewCompletedAt: metrics.sessionReviewCompletedAt,
        trades: metrics.trades || [],
        tradePolygons: metrics.tradePolygons && typeof metrics.tradePolygons === 'object' ? metrics.tradePolygons : {},
        review_requests: metrics.review_requests && typeof metrics.review_requests === 'object' ? metrics.review_requests : {},
    });
}

function journalRowToMonthEntry(row) {
    const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
    return {
        ...normalizeDayEntry({
            pnl: row?.pnl ?? null,
            gross_pnl: row?.gross_pnl ?? null,
            commissions: row?.commissions ?? null,
            locates: row?.locates ?? null,
            notes: row?.notes ?? '',
            mentor_comment: row?.mentor_comment ?? '',
            ai_advice: row?.ai_advice ?? '',
            errors: metrics.errors || [],
            tradeTypesData: metrics.tradeTypesData || {},
            sheetGrossSource: metrics.sheetSync?.grossSource || '',
            sheetGrossValue: metrics.sheetSync?.grossValue ?? null,
            sheetTradeTypesSource: metrics.sheetSync?.tradeTypesSource || '',
            sheetCalendarOnly: metrics.sheetSync?.calendarOnly === true,
            sheetPnlSource: metrics.sheetSync?.legacyPnlSource || '',
            sheetTradeTypesSyncEnabled: metrics.sheetSync?.tradeTypesEnabled === true,
            screenshots: metrics.screenshots || { good: [], normal: [], bad: [], error: [] },
            tickers: metrics.tickers || {},
            traded_tickers: metrics.traded_tickers || [],
            fondexx: metrics.fondexx,
            fondexxSource: metrics.fondexxSource,
            ppro: metrics.ppro,
            pproSource: metrics.pproSource,
            traderAbsent: metrics.traderAbsent === true,
            demoTrading: metrics.demoTrading === true,
            sessionStartRecorded: metrics.sessionStartRecorded === true || metrics.sessionDone === true
                || String(metrics.sessionGoal || '').trim() !== '' || String(metrics.sessionPlan || '').trim() !== '',
            sessionEndRecorded: metrics.sessionEndRecorded === true || metrics.sessionReviewDone === true
                || String(metrics.sessionReviewCompletedAt || '').trim() !== '',
            trades: metrics.trades || [],
            tradePolygons: metrics.tradePolygons && typeof metrics.tradePolygons === 'object' ? metrics.tradePolygons : {},
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
let _journalSaveTimer = null;
let _journalSaveDeferred = null;
let _journalSaveOptions = {};
let _journalSaveFirstRequestedAt = 0;
let _settingsSavePromise = null;
let _settingsSaveRequested = false;
const _dirtyJournalDates = new Set();
const _journalDateRevisions = new Map();
const _dayDetailsPromises = new Map();
const _tradeDaysLoadedFor = new Set();
const _recentlySavedDays = new Map();

export function wasDayRecentlySaved(dateStr, windowMs = 2500) {
    return Date.now() - (_recentlySavedDays.get(dateStr) || 0) < windowMs;
}

export function saveToLocal(opts = {}) {
    return Promise.all([saveJournalData(opts), saveSettings()])
        .catch(e => console.error('saveToLocal queue error:', e));
}

export function saveJournalData(opts = {}) {
    _journalSaveOptions = {
        ..._journalSaveOptions,
        ...opts,
        forceFull: _journalSaveOptions.forceFull === true || opts.forceFull === true,
        skipEmbedding: _journalSaveOptions.skipEmbedding === true || opts.skipEmbedding === true,
    };
    if (!_journalSaveDeferred) {
        _journalSaveFirstRequestedAt = Date.now();
        let resolve;
        let reject;
        const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
        _journalSaveDeferred = { promise, resolve, reject };
    }

    clearTimeout(_journalSaveTimer);
    const elapsed = Date.now() - _journalSaveFirstRequestedAt;
    const delay = opts.immediate === true || elapsed >= 800 ? 0 : 180;
    _journalSaveTimer = setTimeout(() => {
        const deferred = _journalSaveDeferred;
        const runOptions = _journalSaveOptions;
        _journalSaveDeferred = null;
        _journalSaveOptions = {};
        _journalSaveFirstRequestedAt = 0;
        const run = _journalSaveQueue.catch(() => {}).then(() => _doSave(runOptions));
        _journalSaveQueue = run.catch(e => console.error('saveJournalData queue error:', e));
        run.then(deferred.resolve, deferred.reject);
    }, delay);

    return _journalSaveDeferred.promise;
}

if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        if (state.USER_DOC_NAME && state.CURRENT_VIEWED_USER === state.USER_DOC_NAME) {
            void saveJournalData({ immediate: true, skipEmbedding: true }).catch(() => {});
        }
    });
}

export function markJournalDayDirty(dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
        _dirtyJournalDates.add(dateStr);
        _journalDateRevisions.set(dateStr, (_journalDateRevisions.get(dateStr) || 0) + 1);
        const userId = state.myUserId || getCurrentViewedUserId();
        const entry = state.appData?.journal?.[dateStr];
        if (userId && entry?.__detailsLoaded !== false) {
            void cacheJournalRows(userId, [dayEntryToJournalRow(userId, dateStr, entry)], { dirty: true });
            publishSyncState('local', { pending: _dirtyJournalDates.size });
        }
    }
}

const LOCALLY_AUTHORITATIVE_DAY_KEYS = [
    'pnl', 'gross_pnl', 'commissions', 'locates', 'kf', 'notes', 'mentor_comment', 'ai_advice',
    'tradeTypesData', 'sheetGrossSource', 'sheetGrossValue', 'sheetTradeTypesSource',
    'sheetCalendarOnly', 'sheetPnlSource', 'fondexx', 'fondexxSource', 'ppro', 'pproSource',
    'traderAbsent', 'demoTrading', 'trades', 'tradePolygons', 'traded_tickers', 'tickers',
];

function mergeServerDayWithNewerLocal(serverEntry, localEntry) {
    if (!localEntry || typeof localEntry !== 'object') return serverEntry;
    if (localEntry.__detailsLoaded === true) return { ...serverEntry, ...localEntry, __detailsLoaded: true };
    const merged = { ...serverEntry };
    LOCALLY_AUTHORITATIVE_DAY_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(localEntry, key)) merged[key] = localEntry[key];
    });
    merged.__detailsLoaded = true;
    return merged;
}

export function markJournalDaysDirty(dateStrs = []) {
    dateStrs.forEach(markJournalDayDirty);
}

export function markAllJournalDirty() {
    const journal = state.appData?.journal || {};
    Object.keys(journal).forEach(markJournalDayDirty);
}

async function performSettingsSave() {
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
            screenMeta: state.appData.screenMeta && typeof state.appData.screenMeta === 'object' ? state.appData.screenMeta : {},
            tradeTypes: Array.isArray(state.appData.tradeTypes) ? state.appData.tradeTypes : [],
            unassignedImages: Array.isArray(state.appData.unassignedImages) ? state.appData.unassignedImages : [],
            screenTags: state.appData.screenTags && typeof state.appData.screenTags === 'object' ? state.appData.screenTags : {},
            screenDiscipline:
                state.appData.screenDiscipline && typeof state.appData.screenDiscipline === 'object'
                    ? state.appData.screenDiscipline
                    : {},
            sheetRows: state.appData.sheetRows && typeof state.appData.sheetRows === 'object' ? state.appData.sheetRows : {},
            cumulativeSheetRows:
                state.appData.cumulativeSheetRows && typeof state.appData.cumulativeSheetRows === 'object'
                    ? state.appData.cumulativeSheetRows
                    : {},
            weeklyComments:
                state.appData.weeklyComments && typeof state.appData.weeklyComments === 'object' ? state.appData.weeklyComments : {},
        };
        await cacheValue(user.id, 'settings', settingsPayload);
        publishSyncState('syncing', { kind: 'settings' });
        const { error } = await supabase
            .from('profiles')
            .update({ settings: settingsPayload })
            .eq('id', user.id);
        if (error) throw error;
        publishSyncState('synced', { kind: 'settings' });
        console.log('✅ Settings збережено в Supabase');
    } catch (e) {
        console.error('❌ Помилка збереження settings:', e);
    }
}

export function saveSettings() {
    _settingsSaveRequested = true;
    if (_settingsSavePromise) return _settingsSavePromise;
    _settingsSavePromise = (async () => {
        while (_settingsSaveRequested) {
            _settingsSaveRequested = false;
            await performSettingsSave();
        }
    })().finally(() => { _settingsSavePromise = null; });
    return _settingsSavePromise;
}

export async function loadSettings() {
    try {
        const { user } = await getCurrentUserContext();
        if (!user) return;
        const cached = await readCachedValue(user.id, 'settings');
        if (cached?.value && typeof cached.value === 'object') {
            state.appData.settings = { ...state.appData.settings, ...cached.value };
        }
        const { data, error } = await supabase
            .from('profiles')
            .select('settings')
            .eq('id', user.id)
            .single();
        if (error) throw error;
        if (data?.settings && typeof data.settings === 'object') {
            await cacheValue(user.id, 'settings', data.settings);
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
            if (incoming.screenMeta && typeof incoming.screenMeta === 'object') {
                state.appData.screenMeta = incoming.screenMeta;
                delete incoming.screenMeta;
            }
            if (Array.isArray(incoming.tradeTypes)) {
                state.appData.tradeTypes = normalizeTradeTypesList(incoming.tradeTypes);
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
            if (incoming.sheetRows && typeof incoming.sheetRows === 'object') {
                state.appData.sheetRows = incoming.sheetRows;
                delete incoming.sheetRows;
            }
            if (incoming.cumulativeSheetRows && typeof incoming.cumulativeSheetRows === 'object') {
                state.appData.cumulativeSheetRows = incoming.cumulativeSheetRows;
                delete incoming.cumulativeSheetRows;
            }
            if (incoming.weeklyComments && typeof incoming.weeklyComments === 'object') {
                state.appData.weeklyComments = incoming.weeklyComments;
                delete incoming.weeklyComments;
            }
            state.appData.settings = { ...state.appData.settings, ...incoming };
            try {
                const cachedTheme = JSON.parse(localStorage.getItem(`theme:${user.id}`) || 'null');
                const cachedAt = Date.parse(cachedTheme?.updatedAt || 0);
                const remoteAt = Date.parse(state.appData.settings.themeUpdatedAt || 0);
                if (cachedTheme?.theme && cachedAt > remoteAt) {
                    state.appData.settings.theme = cachedTheme.theme;
                    state.appData.settings.font = cachedTheme.font || state.appData.settings.font;
                    state.appData.settings.customTheme = cachedTheme.customTheme || state.appData.settings.customTheme;
                    state.appData.settings.themeUpdatedAt = cachedTheme.updatedAt;
                }
            } catch {}
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
        const durableDirty = await readDirtyJournalRows(userId);
        durableDirty.forEach((record) => {
            if (record?.tradeDate && record?.row && !journal[record.tradeDate]) {
                journal[record.tradeDate] = markDayEntryDetailsLoaded(journalRowToDayEntry(record.row), true);
            }
            if (record?.tradeDate) _dirtyJournalDates.add(record.tradeDate);
        });
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
        const revisionsAtSave = new Map(entries.map(([dateStr]) => [dateStr, _journalDateRevisions.get(dateStr) || 0]));

        if (forceFull && entries.length) {
            await createCompressedBackup({ reason: forceFull ? 'full-save' : 'sync', requireServer: true });
        }

        const rows = entries.map(([dateStr, entry]) => {
            const row = dayEntryToJournalRow(userId, dateStr, entry);
            row.daily_metrics.user_email = email;
            return row;
        });

        await cacheJournalRows(userId, rows, { dirty: true });
        publishSyncState('syncing', { pending: rows.length, kind: 'journal' });

        const savedDays = [];
        for (let i = 0; i < rows.length; i += 200) {
            const batch = rows.slice(i, i + 200);
            const rpc = await supabase.rpc('sync_journal_days_batch', { payload: batch });
            if (!rpc.error) {
                savedDays.push(...(rpc.data || []));
                continue;
            }
            // Older/staging databases can keep using the existing Data API
            // until the additive local-first migration is installed.
            if (!['PGRST202', '42883'].includes(String(rpc.error.code || ''))) throw rpc.error;
            const fallback = await supabase
                .from('journal_days')
                .upsert(batch, { onConflict: 'user_id,trade_date' })
                .select('id,trade_date');
            if (fallback.error) throw fallback.error;
            savedDays.push(...(fallback.data || []));
        }

        // Semantic memory is derived after the durable journal write. A temporary
        // inference failure must never roll back or block the trader's save flow.
        if (!opts.skipEmbedding) {
            void enqueueTradeEmbeddingSync(savedDays).catch((error) => {
                console.warn('[trade-memory] embedding sync deferred:', error?.message || error);
            });
        } else {
            console.log(`[trade-memory] skipped for bulk import: ${savedDays.length} days`);
        }

        clearStatsCache(state.USER_DOC_NAME);
        const confirmedDates = entries
            .map(([dateStr]) => dateStr)
            .filter((dateStr) => (_journalDateRevisions.get(dateStr) || 0) === revisionsAtSave.get(dateStr));
        await markJournalRowsSynced(userId, confirmedDates);
        confirmedDates.forEach((dateStr) => {
            _recentlySavedDays.set(dateStr, Date.now());
            _dirtyJournalDates.delete(dateStr);
        });
        const changedDuringSave = entries
            .map(([dateStr]) => dateStr)
            .filter((dateStr) => !confirmedDates.includes(dateStr));
        if (changedDuringSave.length) {
            const latestRows = changedDuringSave.map((dateStr) => dayEntryToJournalRow(userId, dateStr, journal[dateStr]));
            await cacheJournalRows(userId, latestRows, { dirty: true });
            changedDuringSave.forEach((dateStr) => _dirtyJournalDates.add(dateStr));
            queueMicrotask(() => void saveJournalData({ skipEmbedding: opts.skipEmbedding === true }).catch(() => {}));
        }
        state._availableMonthKeys = getMonthsInJournal(journal);
        state._monthListLoaded = true;
        publishSyncState('synced', { pending: _dirtyJournalDates.size, kind: 'journal' });
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

async function loadBootstrapJournal(nick, userId, months) {
    const ordered = [...new Set(months)].sort();
    if (!userId || !ordered.length) return false;
    const first = getMonthRange(ordered[0]).start;
    const last = getMonthRange(ordered.at(-1)).end;
    const { data, error } = await supabase.rpc('get_app_bootstrap', {
        target_user_id: userId,
        date_from: first,
        date_to: last,
    });
    if (error) {
        console.warn('[LOAD] bootstrap unavailable, using month queries:', error.message);
        return false;
    }
    if (!isCurrentProfileRequest(nick, userId)) return false;
    const rows = Array.isArray(data?.journal_days) ? data.journal_days : [];
    await cacheJournalRows(userId, rows.filter((row) => !_dirtyJournalDates.has(row.trade_date)), { dirty: false });
    rows.forEach((row) => {
        const dateStr = row?.trade_date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) || _dirtyJournalDates.has(dateStr)) return;
        state.appData.journal[dateStr] = markDayEntryDetailsLoaded(journalRowToDayEntry(row), true);
    });
    if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
    if (!state._availableMonthKeys) state._availableMonthKeys = new Set();
    ordered.forEach((mk) => {
        state.loadedMonths[nick].add(mk);
        state._availableMonthKeys.add(mk);
    });
    console.log(`[LOAD] bootstrap: ${rows.length} days in one request`);
    return true;
}

async function hydrateLocalJournal(userId, months) {
    const groups = await Promise.all(months.map((mk) => readCachedMonth(userId, mk)));
    let restored = 0;
    groups.flat().forEach((record) => {
        const dateStr = record?.tradeDate;
        if (!record?.row || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return;
        state.appData.journal[dateStr] = markDayEntryDetailsLoaded(journalRowToDayEntry(record.row), true);
        if (record.dirty) _dirtyJournalDates.add(dateStr);
        restored += 1;
    });
    return restored;
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
        const cachedRows = await readCachedMonth(targetUserId, mk);
        cachedRows.forEach((record) => {
            const dateStr = record.tradeDate;
            if (!record?.row || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
            state.appData.journal[dateStr] = markDayEntryDetailsLoaded(journalRowToDayEntry(record.row), true);
            if (record.dirty) _dirtyJournalDates.add(dateStr);
        });
        if (cachedRows.length) {
            if (!state._availableMonthKeys) state._availableMonthKeys = new Set();
            state._availableMonthKeys.add(mk);
            console.log(`[LOAD] local ${mk}: ${cachedRows.length} days`);
        }
        const { start, end } = getMonthRange(mk);
        const { data, error } = await supabase
            .from('journal_days')
            .select('id, user_id, trade_date, pnl, gross_pnl, commissions, locates, notes, mentor_comment, ai_advice, daily_metrics')
            .eq('user_id', targetUserId)
            .gte('trade_date', start)
            .lte('trade_date', end)
            .order('trade_date', { ascending: true });

        if (error) throw error;
        await cacheJournalRows(targetUserId, (data || []).filter((row) => !_dirtyJournalDates.has(row.trade_date)), { dirty: false });

        if (!isCurrentProfileRequest(nick, targetUserId)) {
            console.info(`[LOAD] ${mk}: застарілу відповідь іншого профілю пропущено`);
            return;
        }

        (data || []).forEach(row => {
            const dateStr = row.trade_date;
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                if (_dirtyJournalDates.has(dateStr)) return;
                // The month query already includes daily_metrics, so keeping a
                // deliberately partial entry only made saved fields appear after
                // the user clicked the day and triggered a second request.
                state.appData.journal[dateStr] = markDayEntryDetailsLoaded(
                    journalRowToDayEntry(row),
                    true
                );
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

export async function loadDayDetails(dateStr, userId = null, options = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

    const existing = state.appData.journal[dateStr];
    if (!options.force && existing?.__detailsLoaded) return existing;
    const revisionAtStart = _journalDateRevisions.get(dateStr) || 0;
    const dirtyAtStart = _dirtyJournalDates.has(dateStr);

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
            if (!user || !userId) throw new Error('Немає авторизованого користувача Supabase');

            const { data, error } = await supabase
                .from('journal_days')
                .select('*')
                .eq('user_id', targetUserId)
                .eq('trade_date', dateStr)
                .maybeSingle();

            if (error) throw error;

            if (getCurrentViewedUserId() !== targetUserId) {
                console.info(`[LOAD] ${dateStr}: застарілі деталі іншого профілю пропущено`);
                return existing || null;
            }

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

            if (!_dirtyJournalDates.has(dateStr)) {
                await cacheJournalRows(targetUserId, [data], { dirty: false });
            }

            const localNow = state.appData.journal[dateStr];
            const changedWhileLoading = (_journalDateRevisions.get(dateStr) || 0) !== revisionAtStart;
            const keepLocal = dirtyAtStart || changedWhileLoading || _dirtyJournalDates.has(dateStr);
            const resolvedEntry = keepLocal
                ? mergeServerDayWithNewerLocal(fullEntry, localNow)
                : fullEntry;
            state.appData.journal[dateStr] = resolvedEntry;
            return resolvedEntry;
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
        await cacheJournalRows(targetUserId, (data || []).filter((row) => !_dirtyJournalDates.has(row.trade_date)), { dirty: false });

        if (!isCurrentProfileRequest(nick, targetUserId)) {
            console.info('[LOAD] loadAllMonths: застарілу відповідь іншого профілю пропущено');
            return;
        }

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
        await cacheJournalRows(targetUserId, (data || []).filter((row) => !_dirtyJournalDates.has(row.trade_date)), { dirty: false });

        if (!isCurrentProfileRequest(nick, targetUserId)) {
            console.info('[LOAD] loadTradeDays: застарілу відповідь іншого профілю пропущено');
            return;
        }

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
        const isViewingOwnProfile = nick === state.USER_DOC_NAME;
        const viewedUserId = getCurrentViewedUserId() || await resolveViewedUserId(nick, { force: true });
        if (!viewedUserId) throw new Error(`Не вдалося визначити userId для ${nick}`);
        const previousAppData = state.appData && typeof state.appData === 'object' ? state.appData : {};
        const baseAppData = getDefaultAppData();
        if (!isViewingOwnProfile) {
            baseAppData.settings = {
                ...baseAppData.settings,
                ...(previousAppData.settings && typeof previousAppData.settings === 'object' ? previousAppData.settings : {})
            };
        }
        state.appData = normalizeAppData({ ...baseAppData, journal: {} });

        state.loadedMonths[nick] = new Set();
        state._allMonthsLoaded = false;
        state._monthListLoaded = false;
        state._availableMonthKeys = new Set();

        const now = state.todayObj;
        const currentMk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevMk = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

        const restoredLocalDays = await hydrateLocalJournal(viewedUserId, [prevMk, currentMk]);
        if (restoredLocalDays) {
            console.log(`[LOAD] local-first: rendered ${restoredLocalDays} cached days before server sync`);
            if (window.renderView) await window.renderView();
            if (window.selectDate) window.selectDate(state.selectedDateStr);
        }

        const [bootstrapLoaded] = await Promise.all([
            loadBootstrapJournal(nick, viewedUserId, [prevMk, currentMk]),
            isViewingOwnProfile ? loadSettings() : Promise.resolve(),
        ]);
        if (!bootstrapLoaded) {
            await Promise.all([
                loadMonth(nick, currentMk, viewedUserId),
                loadMonth(nick, prevMk, viewedUserId),
            ]);
        }

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
        const daylossMonthInput = document.getElementById('setting-dayloss-month');

        if (themeRadio) themeRadio.checked = true;
        if (fontRadio) fontRadio.checked = true;
        if (daylossInput) daylossInput.value = s.defaultDayloss || -1000;
        if (daylossMonthInput) daylossMonthInput.value = state.selectedDateStr?.slice(0, 7) || new Date().toISOString().slice(0, 7);

        if (s.theme === 'custom' && s.customTheme) {
            ['bg-main', 'bg-panel', 'text-main', 'accent', 'profit', 'loss'].forEach((f, i) => {
                const el = document.getElementById(`ct-${f}`);
                if (el) el.value = s.customTheme[['bgMain', 'bgPanel', 'textMain', 'accent', 'profit', 'loss'][i]];
            });
        }

        if (window.initSelectors) window.initSelectors();
        state.statsSourceSelection = { type: 'current', key: state.CURRENT_VIEWED_USER };
        if (window.applyTheme) window.applyTheme(true);
        if (window.updateAutoFlags) await window.updateAutoFlags();
        if (window.renderErrorsList) window.renderErrorsList();
        if (window.renderSettingsChecklist) window.renderSettingsChecklist();
        if (window.renderSettingsSliders) window.renderSettingsSliders();
        if (window.renderDaylossSettings) window.renderDaylossSettings();
        if (window.renderMyTradeTypes) window.renderMyTradeTypes();
        if (window.renderView) await window.renderView();
        if (window.selectDate) window.selectDate(state.selectedDateStr);
        if (window.renderJournalScore) void window.renderJournalScore();
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
    const storageUser = await ensureSupabaseStorageUser();
    state.myUserId = storageUser.id;
    const safeName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
    const storagePath = `backgrounds/${storageUser.id}/${safeName}`;
    await uploadToSupabaseStorage(storagePath, file, { bucket: 'backgrounds' });

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
    const isSelfExport = targetDocName === state.USER_DOC_NAME;
    const canExportOther = state.myRole === 'admin' || state.IS_MENTOR_MODE;

    if (!isSelfExport && !canExportOther) {
        showLoadingToast('Експорт чужого профілю доступний лише ментору або адміну.');
        return;
    }

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

export async function exportProfileData(userId, nick = 'profile') {
    if (!userId) throw new Error('Не вказано профіль для експорту');

    const safeNick = String(nick || 'profile').replace(/_stats$/, '') || 'profile';
    const { data: rows, error: rowsError } = await supabase
        .from('journal_days')
        .select('*')
        .eq('user_id', userId)
        .gte('trade_date', '2024-01-01')
        .lte('trade_date', '2030-12-31')
        .order('trade_date', { ascending: true });

    if (rowsError) throw rowsError;

    const journal = {};
    (rows || []).forEach((row) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(row.trade_date)) {
            journal[row.trade_date] = journalRowToDayEntry(row);
        }
    });

    const payload = { nick: safeNick, exportedAt: new Date().toISOString(), journal };
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    const dl = document.createElement('a');
    dl.setAttribute('href', dataStr);
    dl.setAttribute('download', `export_${safeNick}_${new Date().getFullYear()}.json`);
    document.body.appendChild(dl);
    dl.click();
    dl.remove();
}

export async function resetProfileData(userId, nick = '') {
    if (!userId) throw new Error('Не вказано профіль для очищення');

    const { error: journalError } = await supabase
        .from('journal_days')
        .delete()
        .eq('user_id', userId);
    if (journalError) throw journalError;

    const clean = getDefaultAppData();
    const { error: profileError } = await supabase
        .from('profiles')
        .update({
            settings: {
                ...clean.settings,
                aiChatHistory: [],
                aiSavedChats: [],
                errorTypes: clean.errorTypes,
                learnCache: null,
                tickers: {},
                screenMeta: {},
                tradeTypes: clean.tradeTypes,
                unassignedImages: [],
                screenTags: {},
                screenDiscipline: {},
                weeklyComments: {},
            },
        })
        .eq('id', userId);
    if (profileError) throw profileError;

    if (nick) clearStatsCache(`${String(nick).replace(/_stats$/, '')}_stats`);
    if (userId === getCurrentViewedUserId()) {
        state.appData = normalizeAppData(getDefaultAppData());
        state.loadedMonths = {};
        state._availableMonthKeys = new Set();
        state._monthListLoaded = false;
        state._allMonthsLoaded = false;
    }
}

export async function restoreProfileData(userId, appData, nick = '') {
    if (!userId) throw new Error('Не вказано профіль для відновлення');
    const restored = normalizeAppData(appData || {});
    const journal = restored.journal && typeof restored.journal === 'object' ? restored.journal : {};
    const rows = Object.entries(journal)
        .filter(([date, entry]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && entry?.__detailsLoaded !== false)
        .map(([date, entry]) => dayEntryToJournalRow(userId, date, entry));

    const { error: deleteError } = await supabase.from('journal_days').delete().eq('user_id', userId);
    if (deleteError) throw deleteError;
    for (let i = 0; i < rows.length; i += 200) {
        const { error } = await supabase.from('journal_days').upsert(rows.slice(i, i + 200), { onConflict: 'user_id,trade_date' });
        if (error) throw error;
    }

    const settings = {
        ...restored.settings,
        aiChatHistory: Array.isArray(restored.aiChatHistory) ? restored.aiChatHistory : [],
        aiSavedChats: Array.isArray(restored.aiSavedChats) ? restored.aiSavedChats : [],
        errorTypes: Array.isArray(restored.errorTypes) ? restored.errorTypes : [],
        learnCache: restored.learnCache && typeof restored.learnCache === 'object' ? restored.learnCache : null,
        tickers: restored.tickers && typeof restored.tickers === 'object' ? restored.tickers : {},
        screenMeta: restored.screenMeta && typeof restored.screenMeta === 'object' ? restored.screenMeta : {},
        tradeTypes: Array.isArray(restored.tradeTypes) ? restored.tradeTypes : [],
        unassignedImages: Array.isArray(restored.unassignedImages) ? restored.unassignedImages : [],
        screenTags: restored.screenTags && typeof restored.screenTags === 'object' ? restored.screenTags : {},
        screenDiscipline: restored.screenDiscipline && typeof restored.screenDiscipline === 'object' ? restored.screenDiscipline : {},
        sheetRows: restored.sheetRows && typeof restored.sheetRows === 'object' ? restored.sheetRows : {},
        cumulativeSheetRows: restored.cumulativeSheetRows && typeof restored.cumulativeSheetRows === 'object' ? restored.cumulativeSheetRows : {},
        weeklyComments: restored.weeklyComments && typeof restored.weeklyComments === 'object' ? restored.weeklyComments : {},
    };
    const { error: profileError } = await supabase.from('profiles').update({ settings }).eq('id', userId);
    if (profileError) throw profileError;
    if (nick) clearStatsCache(`${String(nick).replace(/_stats$/, '')}_stats`);
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
