// === js/stats.js ===
import { db } from './firebase.js';
import { state } from './state.js';
import { normalizeAppData, getDefaultAppData } from './data_utils.js';
import { loadMonth } from './storage.js';

// ─── STATS CACHE ───────────────────────────────────────────────────────────────────────────────
// Module-level Map survives filter switches and profile switches within the
// same session. Key = "docName|mk1,mk2,..." or "docName|all-time".
// Value = { journal: {}, ts: Date.now() }. TTL = 24 h.
const _statsCache = new Map();
const _CACHE_TTL = 24 * 60 * 60 * 1000;

function _cacheGet(key) {
    const entry = _statsCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > _CACHE_TTL) { _statsCache.delete(key); return null; }
    return entry.journal;
}

function _cacheSet(key, journal) {
    _statsCache.set(key, { journal, ts: Date.now() });
}

// Wipes all entries for a given docName. Call after any write to Firestore
// so the next stats open re-fetches fresh data for that user only.
export function clearStatsCache(docName) {
    for (const key of _statsCache.keys()) {
        if (key.startsWith(`${docName}|`)) _statsCache.delete(key);
    }
}

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
// Uses { source: 'server' } on every read — no cache, no WebChannel.
async function fetchMonthsForPeriod(docName, filters) {
    const monthKeys = _monthKeysForFilters(filters);
    const cacheKey = `${docName}|${[...monthKeys].sort().join(',')}`;

    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const journal = {};
    const fetches = [...monthKeys].map(mk =>
        db.collection('journal').doc(docName).collection('months').doc(mk)
            .get({ source: 'server' })
            .then(doc => {
                if (!doc.exists) return;
                const days = doc.data();
                for (const dateStr in days) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) journal[dateStr] = days[dateStr];
                }
            })
            .catch(e => console.warn(`fetchMonthsForPeriod: ${docName}/${mk}:`, e.message))
    );
    await Promise.all(fetches);

    _cacheSet(cacheKey, journal);
    return journal;
}

// Reads the aggregation document for a trader (journal/{docName}_stats fields:
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

export async function getStatsDocData(docName, filters) {
    if (!docName) return getDefaultAppData();
    if (docName === state.CURRENT_VIEWED_USER) {
        const data = normalizeAppData(state.appData);
        const needed = _monthKeysForFilters(filters); // null = all-time
        if (needed) {
            await Promise.all([...needed].map(mk => loadMonth(docName, mk)));
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
        const [metaDoc, journal] = await Promise.all([
            db.collection('journal').doc(docName).get({ source: 'server' }),
            fetchMonthsForPeriod(docName, filters),
        ]);
        const data = normalizeAppData(metaDoc.exists ? metaDoc.data() : {});
        data.journal = journal;
        return data;
    } catch (e) {
        console.error('getStatsDocData error:', e);
        return getDefaultAppData();
    }
}

function getStatsSourceButtonClass(type, key) {
    const sel = state.statsSourceSelection;
    if (sel.type === type && String(sel.key) === String(key)) return 'stats-source-btn active';
    return 'stats-source-btn';
}

export function renderStatsSourceSelector() {
    let wrapEl = document.getElementById('stats-source-dropdown-wrap');
    let container = document.getElementById('stats-source-container');
    let triggerLabel = document.getElementById('stats-source-trigger-label');
    if (!wrapEl || !container || !triggerLabel) return;

    triggerLabel.innerText = getStatsSelectionLabel(state.statsSourceSelection.type, state.statsSourceSelection.key);

    let currentKey = state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '';
    let html = `<button class="${getStatsSourceButtonClass('current', currentKey)}" onclick="selectStatsSource('current', '${(currentKey || '').replace(/'/g, "\\'")}')">🏠 Мій профіль</button>`;

    html += `<button class="${getStatsSourceButtonClass('all', '')}" onclick="selectStatsSource('all', '')">🌍 Всі трейдери разом</button>`;

    Object.keys(state.TEAM_GROUPS || {}).sort((a, b) => a.localeCompare(b, 'uk')).forEach(groupName => {
        let escapedGroup = groupName.replace(/'/g, "\\'");
        html += `<div class="stats-group-title">${groupName}</div>`;
        html += `<button class="${getStatsSourceButtonClass('team', groupName)}" onclick="selectStatsSource('team', '${escapedGroup}')">📚 Весь кущ</button>`;
        (state.TEAM_GROUPS[groupName] || []).slice().sort((a, b) => String(a).localeCompare(String(b), 'uk')).forEach(nick => {
            let cleanNick = (nick.includes('(') && nick.includes(')')) ? nick.split('(')[1].replace(')', '').trim() : nick;
            // Не показуємо себе в списку
            if (`${cleanNick}_stats` === state.USER_DOC_NAME) return;
            let escapedNick = (cleanNick || nick).replace(/'/g, "\\'").replace(/"/g, '&quot;');
            html += `<button class="${getStatsSourceButtonClass('trader', cleanNick)}" onclick="selectStatsSource('trader', '${escapedNick}')">👤 ${nick}</button>`;
        });
    });

    container.innerHTML = html;
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

    let html = `<button class="stats-source-btn${!current ? ' active' : ''}" onclick="selectTradeTypeFilter(null)">Всі типи</button>`;
    types.forEach(t => {
        const esc = t.replace(/'/g, "\\'");
        html += `<button class="stats-source-btn${current === t ? ' active' : ''}" onclick="selectTradeTypeFilter('${esc}')">${t}</button>`;
    });
    container.innerHTML = html;
}

export function selectTradeTypeFilter(type) {
    state.activeTradeTypeFilter = type || null;
    renderTradeTypeSelector();
    if (window.closeStatsDropdown) window.closeStatsDropdown('tradetype');
    renderStatsTab();
}

// Maps each logical dropdown name to its panel-id and trigger-id.
const _DROPDOWN_IDS = {
    source:    ['stats-source-panel',    'stats-source-trigger'],
    period:    ['stats-period-panel',    'stats-period-trigger'],
    tradetype: ['stats-tradetype-panel', 'stats-tradetype-trigger'],
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
            if (!merged[d]) merged[d] = { pnl: 0, commissions: 0, locates: 0 };
            merged[d].pnl = (parseFloat(merged[d].pnl) || 0) + (parseFloat(entry.pnl) || 0);
            merged[d].commissions = (parseFloat(merged[d].commissions) || 0) + (parseFloat(entry.commissions) || 0);
            merged[d].locates = (parseFloat(merged[d].locates) || 0) + (parseFloat(entry.locates) || 0);
        }
    }
    return merged;
}

export async function refreshStatsView() {
    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    let requestId = ++state.statsLoadRequestId;

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
            if (isAllTime) {
                if (loadingText) loadingText.textContent = 'Завантаження всіх місяців...';
                const { loadAllMonths } = await import('./storage.js');
                await loadAllMonths(state.CURRENT_VIEWED_USER);
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
                    console.log(`[STATS] Запит до Firestore: не вистачає місяців: ${missing.join(', ')}`);
                    if (loadingText) loadingText.textContent = 'Завантаження даних...';
                    const data = await getStatsDocData(nick, filters);
                    journal = data.journal || {};
                }
            }

        } else if (sel.type === 'all') {
            if (loadingText) loadingText.textContent = 'Завантаження трейдерів...';
            const allNicks = [];
            for (const group in state.TEAM_GROUPS) {
                for (const t of state.TEAM_GROUPS[group]) {
                    const nick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t;
                    if (!allNicks.includes(nick)) allNicks.push(nick);
                }
            }
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
                            if (c) return { journal: c };
                            const j = {};
                            const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                            snap.forEach(d => { Object.assign(j, d.data()); });
                            _cacheSet(k, j);
                            return { journal: j };
                        })
                    );
                    journal = mergeJournals(journals);
                    _cacheSet(allTimeCacheKey, journal);
                }
            } else {
                const journals = await Promise.all(
                    allNicks.map(nick => fetchMonthsForPeriod(`${nick}_stats`, filters))
                );
                journal = mergeJournals(journals.map(j => ({ journal: j })));
            }

        } else if (sel.type === 'team' && state.TEAM_GROUPS[sel.key]) {
            if (loadingText) loadingText.textContent = `Завантаження куща ${sel.key}...`;
            const traders = state.TEAM_GROUPS[sel.key];
            if (isAllTime) {
                const teamCacheKey = `__team__${sel.key}|all-time`;
                const cachedTeam = _cacheGet(teamCacheKey);
                if (cachedTeam) {
                    journal = cachedTeam;
                } else {
                    const journals = await Promise.all(
                        traders.map(async t => {
                            const nick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t;
                            const k = `${nick}_stats|all-time`;
                            const c = _cacheGet(k);
                            if (c) return { journal: c };
                            const j = {};
                            const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                            snap.forEach(d => { Object.assign(j, d.data()); });
                            _cacheSet(k, j);
                            return { journal: j };
                        })
                    );
                    journal = mergeJournals(journals);
                    _cacheSet(teamCacheKey, journal);
                }
            } else {
                const journals = await Promise.all(
                    traders.map(t => {
                        const nick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t;
                        return fetchMonthsForPeriod(`${nick}_stats`, filters);
                    })
                );
                journal = mergeJournals(journals.map(j => ({ journal: j })));
            }

        } else if (sel.type === 'trader') {
            if (loadingText) loadingText.textContent = `Завантаження ${sel.key}...`;
            const nick = (sel.key.includes('(') && sel.key.includes(')')) ? sel.key.split('(')[1].replace(')', '').trim() : sel.key;
            if (isAllTime) {
                const k = `${nick}_stats|all-time`;
                const cached = _cacheGet(k);
                if (cached) {
                    journal = cached;
                } else {
                    const snap = await db.collection('journal').doc(`${nick}_stats`).collection('months').get({ source: 'server' });
                    snap.forEach(d => { Object.assign(journal, d.data()); });
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
    if (sel.type === 'current') {
        contextTradeTypes = state.appData.tradeTypes || [];
    } else if (sel.type === 'trader') {
        const nick = (sel.key.includes('(') && sel.key.includes(')')) ? sel.key.split('(')[1].replace(')', '').trim() : sel.key;
        const data = await getStatsDocData(`${nick}_stats`, filters);
        contextTradeTypes = data.tradeTypes || [];
    } else {
        const seen = new Set();
        for (const d in journal) {
            const entry = journal[d];
            if (entry.tradeTypesData) Object.keys(entry.tradeTypesData).forEach(t => seen.add(t));
        }
        contextTradeTypes = Array.from(seen);
    }

    if (requestId !== state.statsLoadRequestId) { if (overlay) overlay.style.display = 'none'; return; }

    state.currentStatsContext = { label: getStatsSelectionLabel(sel.type, sel.key), journal, tradeTypes: contextTradeTypes };

    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    if (window.renderTradeTypeSelector) window.renderTradeTypeSelector();
    buildStatsTree();
    updateStatsPeriodTriggerLabel();
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
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';

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

export function buildStatsTree() {
    // Для current: дерево будується з _availableMonthKeys (список ID документів без завантаження даних)
    // для інших — з поточного контексту журналу
    const sel = state.statsSourceSelection;
    let tree = {};

    if (sel.type === 'current' && state._availableMonthKeys && state._availableMonthKeys.size > 0) {
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
    let html = `<div class="tree-item tree-root ${isAllTimeActive ? 'active-filter' : ''}"><span class="tree-toggle" style="opacity: 0;"></span><span class="tree-label" onclick="toggleStatsFilter('all', null, this.parentElement, event, 'За весь час')">🌍 За весь час</span></div>`;
    let monthsNames = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
    let years = Object.keys(tree).sort((a,b)=>b-a);
    html += `<ul class="tree-nav">`;
    for(let y of years) {
        let isYActive = state.activeFilters.some(f => f.type === 'year' && f.val == y) ? 'active-filter' : '';
        html += `<li><div class="tree-item ${isYActive}"><span class="tree-toggle" onclick="toggleTree(this)">▼</span><span class="tree-label" onclick="toggleStatsFilter('year', ${y}, this.parentElement, event, '${y} рік')">${y}</span></div><ul>`;
        let months = Object.keys(tree[y]).map(Number).sort((a,b)=>b-a);
        for(let m of months) {
            let mVal = `${y}-${m}`; let isMActive = state.activeFilters.some(f => f.type === 'month' && f.val === mVal) ? 'active-filter' : '';
            html += `<li><div class="tree-item ${isMActive}"><span class="tree-toggle" onclick="toggleTree(this)">▼</span><span class="tree-label" onclick="toggleStatsFilter('month', '${mVal}', this.parentElement, event, '${monthsNames[m]} ${y}')">${monthsNames[m]}</span></div><ul>`;
            let weeks = Array.from(tree[y][m]).sort((a,b)=>a-b); 
            for(let w of weeks) {
                let wVal = `${y}-${m}-${w}`; let isWActive = state.activeFilters.some(f => f.type === 'week' && f.val === wVal) ? 'active-filter' : '';
                html += `<li><div class="tree-item ${isWActive}"><span class="tree-toggle" style="opacity: 0;"></span><span class="tree-label" onclick="toggleStatsFilter('week', '${wVal}', this.parentElement, event, '${monthsNames[m]}, Тиждень ${w}')">Тиждень ${w}</span></div></li>`;
            }
            html += `</ul></li>`;
        }
        html += `</ul></li>`;
    }
    html += `</ul>`;
    document.getElementById('stats-tree-container').innerHTML = html;
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

export function renderStatsTab() {
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
            validEntries.push({ dateStr: d, dateObj: new Date(parts[0], parts[1]-1, parts[2]), pnl, data });
        }
    }
    validEntries.sort((a, b) => a.dateObj - b.dateObj);
    
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
            totalComm += parseFloat(entryData.commissions) || 0;
            totalLocates += parseFloat(entryData.locates) || 0;
        }
        
        periodSum += pnl; periodCumData.push(parseFloat(periodSum.toFixed(2)));
        if (isBroadView) { periodLabels.push(`${e.dateObj.getDate()} ${monthsNamesShort[e.dateObj.getMonth()]}`); } else { periodLabels.push(e.dateObj.getDate().toString()); }
        let day = e.dateObj.getDay(); if (day >= 1 && day <= 5) { dayTotals[day-1] += pnl; }
        if (pnl > 0) { winDays++; grossProfit += pnl; if (pnl > bestDay) bestDay = pnl; } else if (pnl < 0) { lossDays++; grossLoss += Math.abs(pnl); if (pnl < worstDay) worstDay = pnl; } else { beDays++; }
    }

    let totalDays = winDays + lossDays + beDays;
    let winRate = totalDays > 0 ? ((winDays / totalDays) * 100).toFixed(1) : 0;
    let profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : '0.00');
    let avgWin = winDays > 0 ? (grossProfit / winDays).toFixed(2) : '0.00';
    let avgLoss = lossDays > 0 ? (grossLoss / lossDays).toFixed(2) : '0.00';
    
    document.getElementById('stat-winrate').innerText = `${winRate}%`;
    document.getElementById('stat-pf').innerText = profitFactor;
    document.getElementById('stat-avg-win').innerText = fmtMoney(parseFloat(avgWin));
    document.getElementById('stat-avg-loss').innerText = lossDays > 0 ? '-' + fmtMoneyAbs(parseFloat(avgLoss)) : fmtMoney(0);
    document.getElementById('stat-best').innerText = fmtMoney(bestDay);
    document.getElementById('stat-worst').innerText = fmtMoney(worstDay);
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
        const totalPnl = parseFloat((grossProfit - grossLoss).toFixed(2));
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
    
    const ctxPeriod = document.getElementById('pnlChart').getContext('2d');
    if (state.pnlChartInstance) state.pnlChartInstance.destroy();
    state.pnlChartInstance = new Chart(ctxPeriod, { type: 'line', data: { labels: periodLabels, datasets: [{ data: periodCumData, borderColor: cssAccent, backgroundColor: cssAccent + '33', borderWidth: 2, pointBackgroundColor: cssBgPanel, pointBorderColor: cssAccent, pointHoverBackgroundColor: cssAccent, pointRadius: periodCumData.length > 60 ? 0 : 3, fill: true, tension: 0.3 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmtMoney(ctx.parsed.y) } } }, scales: { y: { grid: { color: 'rgba(100, 116, 139, 0.2)' }, ticks: { color: cssText, callback: v => fmtMoneyAbs(v) } }, x: { grid: { display: false }, ticks: { color: cssText, maxTicksLimit: 12 } } } } });

    const ctxDays = document.getElementById('daysChart').getContext('2d');
    if (state.daysChartInstance) state.daysChartInstance.destroy();
    state.daysChartInstance = new Chart(ctxDays, { type: 'bar', data: { labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'], datasets: [{ data: dayTotals.map(v => parseFloat(v.toFixed(2))), backgroundColor: dayTotals.map(v => v >= 0 ? cssGreen : cssRed), borderColor: dayTotals.map(v => v >= 0 ? cssGreen : cssRed), borderWidth: 2, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmtMoney(ctx.parsed.y) } } }, scales: { y: { grid: { color: 'rgba(100, 116, 139, 0.2)' }, ticks: { color: cssText, callback: v => fmtMoneyAbs(v) } }, x: { grid: { display: false }, ticks: { color: cssText } } } } });
    
    const ctxPie = document.getElementById('winLossChart').getContext('2d');
    if (state.winLossChartInstance) state.winLossChartInstance.destroy();
    state.winLossChartInstance = new Chart(ctxPie, { type: 'doughnut', data: { labels: ['Плюс', 'Мінус', 'Нуль'], datasets: [{ data: [winDays, lossDays, beDays], backgroundColor: [cssGreen, cssRed, '#94a3b8'], borderColor: ['rgba(0,0,0,0.1)', 'rgba(0,0,0,0.1)', 'rgba(0,0,0,0.1)'], borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: cssText, boxWidth: 12, boxHeight: 12, padding: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} дн.` } } } } });

    renderMistakeChart(filteredEntries, cssRed, cssText, cssBgPanel);
}