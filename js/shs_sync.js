import { fetchWithSession } from './authenticated_fetch.js';
import { getDefaultDayEntry } from './data_utils.js';
import { applyShsDays, buildShsDayMap } from './shs_trades_core.js';
import { state } from './state.js';
import { markJournalDayDirty, saveJournalData, saveSettings } from './storage.js';
import { showToast } from './utils.js';

const LOOKBACK_DAYS = 34;
const CHUNK_DAYS = 7;

function localIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDays(dateStr, delta) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(y, m - 1, d + delta);
    return localIso(dt);
}

function chunks(start, end) {
    const ranges = [];
    let cursor = start;
    while (cursor <= end) {
        const chunkEnd = addDays(cursor, CHUNK_DAYS - 1);
        ranges.push({ start: cursor, end: chunkEnd < end ? chunkEnd : end });
        cursor = addDays(chunkEnd, 1);
    }
    return ranges;
}

function savedNick() {
    return String(state.appData?.settings?.shsTraderNick || '').trim();
}

function setStatus(text) {
    const status = document.getElementById('shs-trader-status');
    if (status) status.textContent = text;
}

export async function loadShsTraderOptions() {
    const select = document.getElementById('shs-trader-nick');
    if (!select) return;
    const owner = state.myUserId || '';
    if (select.dataset.loaded === '1' && select.dataset.owner === owner) return;
    setStatus('Завантажую список імен...');
    try {
        const response = await fetchWithSession('/api/shs-trades?mode=traders');
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || 'list failed');
        const names = Array.isArray(body.traders) ? body.traders : [];
        const saved = savedNick();
        select.replaceChildren();
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Оберіть себе';
        select.appendChild(blank);
        const seen = new Set();
        [...names, saved].filter(Boolean).forEach((name) => {
            const key = name.toUpperCase();
            if (seen.has(key)) return;
            seen.add(key);
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
        select.value = saved && [...select.options].some((option) => option.value === saved) ? saved : '';
        select.dataset.loaded = '1';
        select.dataset.owner = owner;
        setStatus(select.value ? `Запам’ятано: ${select.value}. Кнопка оновлення зверху забере угоди.` : 'Оберіть себе. Нік лишиться збереженим.');
    } catch (error) {
        console.warn('[shs trader list]', error?.message || error);
        setStatus('Список імен зараз не відкрився. Зайдіть на цей екран ще раз.');
    }
}

export async function rememberShsTrader(nick) {
    const clean = String(nick || '').trim();
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.shsTraderNick = clean;
    setStatus(clean ? `Запам’ятано: ${clean}. Кнопка оновлення зверху забере угоди.` : 'Оберіть себе. Нік лишиться збереженим.');
    try {
        await saveSettings();
    } catch (error) {
        showToast('Нік не вдалося зберегти. Спробуйте ще раз.');
        console.warn('[shs nick]', error?.message || error);
    }
}

export async function syncShsIntoJournal() {
    const nick = savedNick();
    if (!nick) return { skipped: true };
    const end = localIso(new Date());
    const start = addDays(end, -LOOKBACK_DAYS);
    const orders = [];
    const locates = [];
    let truncated = false;
    for (const range of chunks(start, end)) {
        const url = `/api/shs-trades?mode=data&trader=${encodeURIComponent(nick)}&start=${range.start}&end=${range.end}`;
        const response = await fetchWithSession(url);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || 'Не вдалося забрати угоди');
        orders.push(...(body.orders || []));
        locates.push(...(body.locates || []));
        if (body.truncated) truncated = true;
    }
    const dayMap = buildShsDayMap(orders, locates, nick);
    const result = applyShsDays(state.appData.journal, dayMap, getDefaultDayEntry);
    result.updated.forEach((date) => markJournalDayDirty(date));
    if (result.updated.length) await saveJournalData();
    console.info(`[Бот] ${nick}: днів ${result.updated.length}, пропущено через PPRO ${result.skippedPpro.length}${truncated ? ', стрічка обрізала надто довгий день' : ''}`);
    return { ...result, truncated };
}
