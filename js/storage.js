// === js/storage.js ===
import { db, storage } from './firebase.js';
import { state } from './state.js';
import { normalizeAppData, normalizeDayEntry, getDefaultAppData } from './data_utils.js';
import { loadPlaybook } from './playbook.js';
import { clearStatsCache } from './stats.js';

// Повертає ключ місяця для дати: '2026-03'
function monthKey(dateStr) {
    return dateStr.slice(0, 7);
}

// Повертає Set місяців які є в journal об'єкті
function getMonthsInJournal(journal) {
    const months = new Set();
    for (const d in journal) months.add(monthKey(d));
    return months;
}

// Черга збережень — запобігає race condition при паралельних викликах
let _saveQueue = Promise.resolve();
export function saveToLocal() {
    _saveQueue = _saveQueue.then(() => _doSave()).catch(e => console.error('saveToLocal queue error:', e));
    return _saveQueue;
}

async function _doSave() {
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        console.log("Режим глядача: базове збереження заблоковано.");
        return;
    }
    try {
        const nick = state.USER_DOC_NAME;
        const journal = state.appData.journal || {};

        // Групуємо дні по місяцях
        const byMonth = {};
        for (const dateStr in journal) {
            const mk = monthKey(dateStr);
            if (!byMonth[mk]) byMonth[mk] = {};
            byMonth[mk][dateStr] = journal[dateStr];
        }

        // Зберігаємо кожен місяць в сабколекцію
        const batch = db.batch();
        for (const mk in byMonth) {
            const ref = db.collection('journal').doc(nick).collection('months').doc(mk);
            batch.set(ref, byMonth[mk]);
        }

        // Зберігаємо мета-дані (все крім journal і playbook) в основний документ
        const { journal: _j, playbook: _p, ...meta } = state.appData;

        // Агрегаційні поля: рахуємо тільки з вже завантажених місяців.
        // loadAllMonths більше не викликається при збереженні — це запобігає
        // зайвим запитам до Firestore при кожному saveToLocal().
        const agg = _computeAggregation(state.appData.journal);
        batch.set(db.collection('journal').doc(nick), { ...meta, ...agg }, { merge: true });

        await batch.commit();
        clearStatsCache(nick);
        console.log("✅ Дані успішно збережено в хмару Firebase!");
    } catch (e) {
        console.error("❌ Помилка збереження в хмару:", e);
    }
}

// Computes all-time aggregation totals from the full in-memory journal.
// Called inside _doSave so the stats doc always stays up-to-date after
// every save — stats.js reads these fields instead of downloading all months.
function _computeAggregation(journal) {
    let allTimePnl = 0, allTimeWinDays = 0, allTimeLossDays = 0, allTimeBeDays = 0;
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
        allTimePnl:      parseFloat(allTimePnl.toFixed(2)),
        allTimeWinDays,
        allTimeLossDays,
        allTimeBeDays,
    };
}

// Завантажує один місяць для поточного юзера і додає в state.appData.journal
export async function loadMonth(nick, mk) {
    if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
    if (state.loadedMonths[nick].has(mk)) {
        console.log(`[LOAD] Кеш: ${mk} вже в пам'яті, запит пропущено`);
        return;
    }
    console.log(`[LOAD] Запит до Firestore: місяць ${mk} для ${nick}`);
    try {
        const doc = await db.collection('journal').doc(nick).collection('months').doc(mk).get();
        if (doc.exists) {
            const days = doc.data();
            for (const dateStr in days) {
                if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                    state.appData.journal[dateStr] = normalizeDayEntry(days[dateStr]);
                }
            }
            console.log(`[LOAD] ✅ ${mk}: завантажено ${Object.keys(doc.data()).length} днів`);
        } else {
            console.log(`[LOAD] ${mk}: документ не існує`);
        }
        state.loadedMonths[nick].add(mk);
    } catch (e) {
        console.error(`❌ Помилка завантаження місяця ${mk}:`, e);
    }
}

// Завантажує всі місяці для поточного юзера
export async function loadAllMonths(nick) {
    const loaded = state.loadedMonths[nick] || new Set();
    // Якщо вже знаємо повний список місяців і всі вони завантажені — жодного запиту
    if (state._monthListLoaded && state._availableMonthKeys) {
        const missing = [...state._availableMonthKeys].filter(mk => !loaded.has(mk));
        if (missing.length === 0) {
            console.log(`[LOAD] loadAllMonths: всі ${loaded.size} місяців вже в пам'яті, запитів немає`);
            return;
        }
        console.log(`[LOAD] loadAllMonths: з кешу списку, завантажуємо ${missing.length} місяців: ${missing.join(', ')}`);
        await Promise.all(missing.map(mk => loadMonth(nick, mk)));
        return;
    }
    console.log(`[LOAD] ⚠️ loadAllMonths: запит списку місяців для ${nick}`);
    try {
        const monthsSnap = await db.collection('journal').doc(nick).collection('months').get();
        console.log(`[LOAD] loadAllMonths: знайдено ${monthsSnap.docs.length} місяців`);
        if (!state.loadedMonths[nick]) state.loadedMonths[nick] = new Set();
        const toLoad = monthsSnap.docs.filter(d => !state.loadedMonths[nick].has(d.id));
        console.log(`[LOAD] loadAllMonths: ${monthsSnap.docs.length - toLoad.length} з кешу, ${toLoad.length} нових`);
        toLoad.forEach(monthDoc => {
            const mk = monthDoc.id;
            const days = monthDoc.data();
            for (const dateStr in days) {
                if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                    state.appData.journal[dateStr] = normalizeDayEntry(days[dateStr]);
                }
            }
            state.loadedMonths[nick].add(mk);
        });
        // Оновлюємо кеш списку
        state._availableMonthKeys = new Set(monthsSnap.docs.map(d => d.id));
        state._monthListLoaded = true;
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
    t.textContent = msg;
    if (withRetry) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block;margin:8px auto 0;padding:6px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:0.9rem;';
        btn.textContent = '\uD83D\uDD04 \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0438';
        btn.addEventListener('click', () => window.retryInitApp?.());
        t.appendChild(btn);
    }
    t.style.opacity = '1';
    t.style.display = 'block';
    if (!persistent) setTimeout(hideLoadingToast, 3000);
}

function hideLoadingToast() {
    const t = document.getElementById('_load-toast');
    if (t) { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }
}

async function fetchWithRetry(docName, retries = 2, timeoutMs = 8000) {
    for (let i = 0; i < retries; i++) {
        try {
            showLoadingToast(i === 0 ? '⏳ Завантаження...' : `🔄 Повторна спроба ${i}/${retries - 1}...`);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs)
            );
            // { source: 'server' } forces a real network fetch, bypassing the
            // Firestore local cache which can itself trigger a Listen stream.
            const doc = await Promise.race([
                db.collection('journal').doc(docName).get({ source: 'server' }),
                timeoutPromise
            ]);
            hideLoadingToast();
            return doc;
        } catch (e) {
            console.warn(`⚠️ Спроба ${i + 1} невдала:`, e.message);
            if (i < retries - 1) await new Promise(r => setTimeout(r, 1500));
        }
    }
    throw new Error('Не вдалось завантажити дані після кількох спроб');
}

export async function initializeApp() {
    console.log("⏳ Завантаження бази даних для:", state.CURRENT_VIEWED_USER);

    // Завантажуємо глобальний конфіг (ключі Gemini тощо)
    try {
        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) state.systemConfig = configDoc.data();
    } catch(e) { console.warn('Не вдалось завантажити system/config:', e); }

    try {
        const nick = state.CURRENT_VIEWED_USER;
        let doc = await fetchWithRetry(nick);

        const rawMeta = doc.exists ? doc.data() : {};
        state.appData = normalizeAppData(rawMeta);
        state.appData.journal = {};
        state.loadedMonths[nick] = new Set();
        state._allMonthsLoaded = false;
        state._monthListLoaded = false;
        state._availableMonthKeys = new Set();

        const now = state.todayObj;
        const currentMk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevMk = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

        // Load current + previous month + playbook in parallel
        console.log(`[LOAD] Завантаження 2 місяців: ${currentMk}, ${prevMk}`);
        await Promise.all([
            loadMonth(nick, currentMk),
            loadMonth(nick, prevMk),
            loadPlaybook(),
        ]);
        console.log(`[LOAD] ✅ Базові 2 місяці завантажено`);

        if (state.selectedDateStr) {
            const selMk = monthKey(state.selectedDateStr);
            if (selMk !== currentMk && selMk !== prevMk) {
                console.log(`[LOAD] Додатковий місяць (вибрана дата): ${selMk}`);
                await loadMonth(nick, selMk);
            }
        }

        state.appData.unassignedImages = Array.isArray(state.appData.unassignedImages) ? state.appData.unassignedImages.map(u => {
            if (u && u.includes('firebasestorage.googleapis.com')) {
                const match = u.match(/\/o\/([^?]+)/);
                if (match) return decodeURIComponent(match[1]);
            }
            return u;
        }) : [];
        console.log("✅ Дані завантажено з хмари!");

        // --- 1. СИНХРОНІЗАЦІЯ ДАНИХ З ІНТЕРФЕЙСОМ ---
        const s = state.appData.settings;
        let themeRadio = document.getElementById('theme-' + (s.theme || 'dark')); if (themeRadio) themeRadio.checked = true;
        let fontRadio = document.getElementById('font-' + (s.font || 'inter')); if (fontRadio) fontRadio.checked = true;
        let daylossInput = document.getElementById('setting-dayloss-limit'); if (daylossInput) daylossInput.value = s.defaultDayloss || -100;

        if (s.theme === 'custom' && s.customTheme) {
            ['bg-main','bg-panel','text-main','accent','profit','loss'].forEach((f, i) => {
                const el = document.getElementById(`ct-${f}`);
                if (el) el.value = s.customTheme[['bgMain','bgPanel','textMain','accent','profit','loss'][i]];
            });
        }

        // --- 2. РЕНДЕР ВСІХ БЛОКІВ ІНТЕРФЕЙСУ ---
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
        showLoadingToast('❌ Не вдалось завантажити дані.', true, true);
    } finally {
        // ALWAYS dismiss the loading overlay — prevents the app from hanging
        // regardless of whether the fetch succeeded or failed.
        hideLoadingToast();
    }
}

// ─── Background Image Persistence ───────────────────────────────────────────

/**
 * Upload a background image file to Firebase Storage, then persist the
 * download URL + activeBackground pointer to the user's Firestore document.
 *
 * @param {File}   file
 * @param {string} userId  state.USER_DOC_NAME
 * @returns {Promise<string>}  The public download URL.
 */
export async function uploadBackground(file, userId) {
    // Sanitise filename: strip spaces, prefix with timestamp to avoid collisions.
    const safeName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
    const storagePath = `backgrounds/${userId}/${safeName}`;

    const ref = storage.ref(storagePath);
    const uploadTask = await ref.put(file, {
        customMetadata: { type: 'background' },
    });

    const downloadURL = await uploadTask.ref.getDownloadURL();

    // Persist URL into the user's Firestore document.
    await db.collection('journal').doc(userId).set({
        backgrounds:      firebase.firestore.FieldValue.arrayUnion(downloadURL),
        activeBackground: downloadURL,
    }, { merge: true });

    // Keep in-memory state in sync.
    if (!Array.isArray(state.appData.backgrounds)) state.appData.backgrounds = [];
    if (!state.appData.backgrounds.includes(downloadURL)) {
        state.appData.backgrounds.push(downloadURL);
    }
    state.appData.activeBackground = downloadURL;

    return downloadURL;
}

/**
 * Set an already-uploaded URL as the active background in Firestore + state.
 * @param {string} url
 * @param {string} userId
 */
export async function setActiveBackground(url, userId) {
    await db.collection('journal').doc(userId).set(
        { activeBackground: url },
        { merge: true }
    );
    state.appData.activeBackground = url;
}

/**
 * Remove a background URL from Storage + Firestore.
 * If it was the active background, activeBackground is cleared.
 * @param {string} url
 * @param {string} userId
 */
export async function deleteBackground(url, userId) {
    // Delete from Storage (best-effort — ignore 404).
    try {
        await storage.refFromURL(url).delete();
    } catch (e) {
        if (e.code !== 'storage/object-not-found') console.warn('[BgDelete]', e);
    }

    const updates = {
        backgrounds: firebase.firestore.FieldValue.arrayRemove(url),
    };
    if (state.appData.activeBackground === url) {
        updates.activeBackground = firebase.firestore.FieldValue.delete();
        state.appData.activeBackground = null;
    }
    await db.collection('journal').doc(userId).update(updates);

    state.appData.backgrounds = (state.appData.backgrounds || []).filter(u => u !== url);
}

/**
 * Render the background gallery into #bg-gallery-list.
 * Reads from state.appData.backgrounds (already loaded by initializeApp).
 */
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
    showLoadingToast('⏳ Підготовка експорту...', true);
    await loadAllMonths(state.USER_DOC_NAME);
    hideLoadingToast();
    const exportData = { ...state.appData };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData));
    const dl = document.createElement('a');
    dl.setAttribute("href", dataStr);
    dl.setAttribute("download", "trader_app_backup.json");
    document.body.appendChild(dl); dl.click(); dl.remove();
}

export function importData(event) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            let imported = JSON.parse(e.target.result);
            state.appData = normalizeAppData(imported);
            // Скидаємо кеш завантажених місяців щоб імпортовані дані не перезаписались
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
    reader.readAsText(file); event.target.value = '';
}
