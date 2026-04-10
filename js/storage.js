// === js/storage.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { normalizeAppData, normalizeDayEntry, getDefaultAppData } from './data_utils.js';
import { loadPlaybook } from './playbook.js';
import { clearStatsCache } from './stats.js';
import { uploadToSupabaseStorage, deleteFromSupabaseStorage } from './supabase_storage.js';

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
            trades: Array.isArray(day.trades) ? day.trades : []
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
        trades: metrics.trades || []
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

let _saveQueue = Promise.resolve();
const _dayDetailsPromises = new Map();

export function saveToLocal() {
    _saveQueue = _saveQueue.then(() => Promise.all([_doSave(), saveSettings()])).catch(e => console.error('saveToLocal queue error:', e));
    return _saveQueue;
}

export async function saveSettings() {
    try {
        const { user } = await getCurrentUserContext();
        if (!user) return;
        const { error } = await supabase
            .from('profiles')
            .update({ settings: state.appData.settings })
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
            state.appData.settings = { ...state.appData.settings, ...data.settings };
            console.log('✅ Settings завантажено з Supabase');
        }
    } catch (e) {
        console.error('❌ Помилка завантаження settings:', e);
    }
}

export async function saveMonth() {
    return _doSave();
}

async function _doSave() {
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        console.log('Режим глядача: базове збереження заблоковано.');
        return;
    }

    try {
        const { user, userId, email } = await getCurrentUserContext();
        if (!user || !userId) throw new Error('Немає авторизованого користувача Supabase');

        const journal = state.appData.journal || {};
        const entries = Object.entries(journal)
            .filter(([dateStr]) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr));

        for (const [dateStr, entry] of entries) {
            const row = dayEntryToJournalRow(userId, dateStr, entry);
            row.daily_metrics.user_email = email;

            const { error } = await supabase
                .from('journal_days')
                .upsert(row, { onConflict: 'user_id,trade_date' });

            if (error) throw error;
        }

        clearStatsCache(state.USER_DOC_NAME);
        state._availableMonthKeys = getMonthsInJournal(journal);
        state._monthListLoaded = true;
        console.log('✅ Дані днів успішно збережено в Supabase!');
    } catch (e) {
        console.error('❌ Помилка збереження днів у Supabase:', e);
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

export async function loadMonth(nick, mk) {
    if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
    if (state.loadedMonths[nick].has(mk)) {
        console.log(`[LOAD] Кеш: ${mk} вже в пам'яті, запит пропущено`);
        return;
    }

    try {
        const { user, userId } = await getCurrentUserContext();
        if (!user || !userId) throw new Error('Немає авторизованого користувача Supabase');

        const { start, end } = getMonthRange(mk);
        const { data, error } = await supabase
            .from('journal_days')
            .select('id, user_id, trade_date, pnl, gross_pnl')
            .eq('user_id', userId)
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

export async function loadDayDetails(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

    const existing = state.appData.journal[dateStr];
    if (existing?.__detailsLoaded) return existing;

    const requestKey = `${state.CURRENT_VIEWED_USER}:${dateStr}`;
    if (_dayDetailsPromises.has(requestKey)) {
        return _dayDetailsPromises.get(requestKey);
    }

    const request = (async () => {
        try {
            const { user, userId } = await getCurrentUserContext();
            if (!user || !userId) throw new Error('РќРµРјР°С” Р°РІС‚РѕСЂРёР·РѕРІР°РЅРѕРіРѕ РєРѕСЂРёСЃС‚СѓРІР°С‡Р° Supabase');

            const { data, error } = await supabase
                .from('journal_days')
                .select('*')
                .eq('user_id', userId)
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

export async function loadAllMonths(nick) {
    try {
        const { user, userId } = await getCurrentUserContext();
        if (!user || !userId) throw new Error('Немає авторизованого користувача Supabase');

        const { data, error } = await supabase
            .from('journal_days')
            .select('*')
            .eq('user_id', userId)
            .gte('trade_date', '2024-01-01')
            .lte('trade_date', '2030-12-31')
            .order('trade_date', { ascending: true });

        if (error) throw error;

        if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
        state._availableMonthKeys = new Set();

        (data || []).forEach(row => {
            const dateStr = row.trade_date;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

            state.appData.journal[dateStr] = journalRowToDayEntry(row);
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

    try {
        const nick = state.CURRENT_VIEWED_USER;
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
            loadMonth(nick, currentMk),
            loadMonth(nick, prevMk),
            loadPlaybook(),
        ]);

        if (state.selectedDateStr) {
            const selMk = monthKey(state.selectedDateStr);
            if (selMk !== currentMk && selMk !== prevMk) {
                await loadMonth(nick, selMk);
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
        if (window.renderGeminiKeys) window.renderGeminiKeys();
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
        hideLoadingToast();
    }
}

export async function uploadBackground(file, userId) {
    const safeName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
    const storagePath = `backgrounds/${userId}/${safeName}`;
    const downloadURL = await uploadToSupabaseStorage(storagePath, file);

    if (!Array.isArray(state.appData.backgrounds)) state.appData.backgrounds = [];
    if (!state.appData.backgrounds.includes(downloadURL)) {
        state.appData.backgrounds.push(downloadURL);
    }
    state.appData.activeBackground = downloadURL;

    localStorage.setItem(getUserScopedStorageKey('backgrounds', userId), JSON.stringify(state.appData.backgrounds));
    localStorage.setItem(getUserScopedStorageKey('activeBackground', userId), downloadURL);

    return downloadURL;
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
        img.src = url;
        img.title = 'Натисніть, щоб встановити';
        img.style.cssText = [
            'width:72px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;',
            'border:2px solid', url === active ? 'var(--accent)' : 'transparent', ';',
            'transition:border-color 0.2s;',
        ].join('');
        img.onclick = () => window._setActiveBackground?.(url);

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
        showLoadingToast('❌ Помилка експорту: ' + (e?.message || 'Невідома помилка'));
        setTimeout(hideLoadingToast, 3000);
        return;
    }

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

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            state.appData = normalizeAppData(imported);
            state.loadedMonths = {};
            await saveToLocal();
            await initializeApp();
            setTimeout(() => showLoadingToast('✅ Дані успішно імпортовано!'), 300);
            setTimeout(hideLoadingToast, 3300);
        } catch (err) {
            showLoadingToast('❌ Помилка файлу.');
            setTimeout(hideLoadingToast, 2500);
        }
    };

    reader.readAsText(file);
    event.target.value = '';
}
