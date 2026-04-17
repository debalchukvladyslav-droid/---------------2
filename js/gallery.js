// === js/gallery.js ===
import { state, SCREEN_CATS } from './state.js';
import { saveJournalData, markJournalDayDirty, saveSettings } from './storage.js';
import { showToast } from './utils.js';
import { getDefaultDayEntry } from './data_utils.js';
import { deleteFromSupabaseStorage, getSupabaseStorageUrl, uploadToSupabaseStorage } from './supabase_storage.js';
import { buildScreenshotPath } from './storage_paths.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';

export function openZoom(src) {
    state.currentZoomedSrc = src;
    const preview = document.getElementById('image-preview');
    preview.querySelector('img').src = src;
    preview.style.display = 'flex';
}

export function closeZoom(e) {
    if (e.target.id === 'image-preview') {
        document.getElementById('image-preview').style.display = 'none';
    }
}

export function openOriginal(e) {
    if(e) e.stopPropagation();
    document.getElementById('image-preview').style.display = 'none';
    window.open(state.currentZoomedSrc, '_blank');
}

export function getImgUrl(path) { 
    return decodeURIComponent(path); 
}

// Кеш свіжих URL з інвалідацією (Firebase URL живуть ~1 год)
const _memUrlCache = {};
const URL_CACHE_TTL = 50 * 60 * 1000; // 50 хвилин

function _getCachedUrl(path) {
    if (_memUrlCache[path] && Date.now() - _memUrlCache[path].ts < URL_CACHE_TTL) return _memUrlCache[path].url;
    try {
        const raw = localStorage.getItem('sc:' + path);
        if (raw) {
            const e = JSON.parse(raw);
            if (Date.now() - e.ts < URL_CACHE_TTL) { _memUrlCache[path] = e; return e.url; }
            localStorage.removeItem('sc:' + path);
        }
    } catch (_) {}
    return null;
}

function _setCachedUrl(path, url) {
    const e = { url, ts: Date.now() };
    _memUrlCache[path] = e;
    try { localStorage.setItem('sc:' + path, JSON.stringify(e)); } catch (_) {}
}

export async function getStorageUrl(pathOrUrl) {
    if (!pathOrUrl) return '';
    if (pathOrUrl.startsWith('http') && !pathOrUrl.includes('firebasestorage')) return pathOrUrl;
    let storagePath = pathOrUrl;
    if (pathOrUrl.includes('firebasestorage.googleapis.com')) {
        const match = pathOrUrl.match(/\/o\/([^?]+)/);
        if (match) storagePath = decodeURIComponent(match[1]);
    }
    const cached = _getCachedUrl(storagePath);
    if (cached) return cached;
    try {
        const url = await getSupabaseStorageUrl(storagePath);
        _setCachedUrl(storagePath, url);
        return url;
    } catch(e) {
        console.warn('Storage URL error:', e.message);
        return pathOrUrl;
    }
}

// Гарантує, що в об'єкті дня є правильна структура
export function ensureDayStructure(d) {
    if (!state.appData.journal[d]) {
        state.appData.journal[d] = getDefaultDayEntry();
    }
}

export async function renderUnassignedUI() {
    let container = document.getElementById('unassigned-container');
    let titleEl = document.getElementById('unassigned-title');
    if (!titleEl) return;

    let hintHTML = '<span style="font-size: 0.85rem; color: var(--text-muted); font-weight: normal; margin-left: 10px;">(або вставте картинку через Ctrl+V)</span>';

    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        titleEl.style.display = 'none';
        container.style.display = 'none';
        return;
    }
    titleEl.style.display = '';
    container.style.display = '';
    
    titleEl.innerHTML = "Ваші нерозподілені скріншоти: " + hintHTML;

    if (state.currentUnassignedImages.length === 0) {
        const driveConnected = !!state.appData.settings.driveFolderId;
        container.innerHTML = driveConnected
            ? '<div style="color:var(--text-muted); padding: 10px;">Всі скріншоти розсортовані або папка порожня.</div>'
            : '<div style="color:var(--text-muted); padding: 20px; text-align:center; border: 1px dashed var(--border); border-radius:8px;">'
              + '☁️ Підключіть <strong>Google Drive</strong> в Налаштуваннях для автосинхронізації скріншотів, '
              + 'або вставте зображення через <strong>Ctrl+V</strong>.</div>';
        return;
    }
    const imagesToShow = state.currentUnassignedImages.slice(0, state.unassignedVisibleCount);
    const leftCount = state.currentUnassignedImages.length - state.unassignedVisibleCount;
    container.innerHTML = '';
    await Promise.all(imagesToShow.map(async (img) => {
        let encodedPath = encodeURIComponent(img);
        let cleanId = 'ticker-' + img.replace(/[^a-zA-Z0-9]/g, '');
        const item = document.createElement('div');
        item.className = 'unassigned-item';

        const zoomWrapper = document.createElement('div');
        zoomWrapper.className = 'img-zoom-wrapper';
        const badge = document.createElement('div');
        badge.className = 'ticker-badge';
        badge.id = cleanId;
        const imgEl = document.createElement('img');
        imgEl.src = '';
        imgEl.dataset.path = encodedPath;
        imgEl.title = 'Клікніть, щоб збільшити';
        zoomWrapper.appendChild(badge);
        zoomWrapper.appendChild(imgEl);

        const btns = document.createElement('div');
        btns.className = 'assign-btns';
        [['good', '+ Хороший'], ['normal', '+ Норм'], ['bad', '+ Поганий'], ['error', '+ Помилка']].forEach(([cat, label]) => {
            const btn = document.createElement('button');
            btn.className = `assign-btn ${cat}`;
            btn.textContent = label;
            btn.addEventListener('click', () => assignImage(encodedPath, cat));
            btns.appendChild(btn);
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'assign-btn delete';
        delBtn.textContent = '🗑️ Видалити назавжди';
        delBtn.addEventListener('click', () => deleteFileFromPC(encodedPath));
        btns.appendChild(delBtn);

        item.appendChild(zoomWrapper);
        item.appendChild(btns);
        container.appendChild(item);

        if (window.updateBadgeUI) window.updateBadgeUI(encodedPath);
        getStorageUrl(img).then(src => {
            imgEl.src = src;
            imgEl.onclick = () => openZoom(src);
        });
        if ((!state.appData.tickers[img] || state.appData.tickers[img] === '???') && window.runOCR) window.runOCR(encodedPath);
    }));
    if (leftCount > 0) {
        const moreBtn = document.createElement('div');
        moreBtn.style.cssText = 'width:100%;display:flex;justify-content:center;padding:10px 0;flex-basis:100%;';
        const btn = document.createElement('button');
        btn.className = 'btn-secondary';
        btn.style.cssText = 'width:auto;border:2px dashed var(--accent);color:var(--accent);padding:10px 24px;font-size:1rem;cursor:pointer;';
        btn.textContent = `➕ Показати ще 5`;
        const hint = document.createElement('span');
        hint.style.cssText = 'font-size:0.85rem;color:var(--text-muted);';
        hint.textContent = ` (залишилось: ${leftCount})`;
        btn.appendChild(hint);
        btn.addEventListener('click', () => loadMoreUnassigned());
        moreBtn.appendChild(btn);
        container.appendChild(moreBtn);
    }
}

export function loadMoreUnassigned() { 
    state.unassignedVisibleCount += 5; 
    renderUnassignedUI(); 
    let imagesToShow = state.currentUnassignedImages.slice(0, state.unassignedVisibleCount); 
    for (let img of imagesToShow) { 
        let encodedPath = encodeURIComponent(img); 
        if (!state.appData.tickers[img] && window.runOCR) window.runOCR(encodedPath); 
    } 
}

export async function renderAssignedScreens() {
    let screens = state.appData.journal[state.selectedDateStr]?.screenshots || { good:[], normal:[], bad:[], error:[] }; 
    const assignedContainer = document.getElementById('assigned-container');
    assignedContainer.innerHTML = '';
    let count = 0; let currentDayImages = [];

    // Презавантажуємо blob URL для Firebase Storage
    const allFilenames = SCREEN_CATS.flatMap(cat => screens[cat.id] || []);
    const srcMap = {};
    await Promise.all(allFilenames.map(async f => {
        srcMap[f] = await getStorageUrl(f);
    }));
    
    SCREEN_CATS.forEach(cat => {
        const list = screens[cat.id] || []; count += list.length;
        if (list.length === 0) return;

        const catDiv = document.createElement('div');
        catDiv.className = 'big-screen-cat';
        const catTitle = document.createElement('h4');
        catTitle.style.color = cat.color;
        catTitle.textContent = cat.name;
        catDiv.appendChild(catTitle);

        list.forEach(filename => {
            const encodedPath = encodeURIComponent(filename);
            const src = srcMap[filename] || getImgUrl(filename);
            const cleanId = 'ticker-' + filename.replace(/[^a-zA-Z0-9]/g, '');
            currentDayImages.push(encodedPath);
            const tags = (state.appData.screenTags && state.appData.screenTags[filename]) || [];
            const discipline = (state.appData.screenDiscipline && state.appData.screenDiscipline[filename]) ?? 5;
            const discColor = discipline <= 3 ? 'var(--profit)' : discipline >= 8 ? 'var(--loss)' : 'var(--gold)';

            const item = document.createElement('div');
            item.className = 'big-screen-item';

            // Image
            const zoomWrap = document.createElement('div');
            zoomWrap.className = 'img-zoom-wrapper';
            const badge = document.createElement('div');
            badge.className = 'ticker-badge'; badge.id = cleanId;
            const imgEl = document.createElement('img');
            imgEl.src = src; imgEl.title = 'Клікніть, щоб збільшити';
            imgEl.addEventListener('click', () => openZoom(src));
            zoomWrap.appendChild(badge); zoomWrap.appendChild(imgEl);

            // Action buttons
            const actRow = document.createElement('div');
            actRow.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-start;align-items:center;gap:10px;margin-top:15px;';
            const aiBtn = document.createElement('button');
            aiBtn.className = 'btn-ai'; aiBtn.style.cssText = 'width:auto;margin:0;padding:8px 15px;';
            aiBtn.textContent = '👁️ AI Аналіз графіку';
            aiBtn.addEventListener('click', () => window.analyzeChart?.(encodedPath, cleanId));
            const rrBtn = document.createElement('button');
            rrBtn.type = 'button';
            rrBtn.className = 'btn-secondary rr-screen-btn rr-toggle-btn rr-exempt-access';
            rrBtn.setAttribute('data-screen-path', encodedPath);
            rrBtn.textContent = '📩 Запит розбору';
            rrBtn.addEventListener('click', () => window.submitReviewRequest?.('screen_item', encodedPath));
            const retBtn = document.createElement('button');
            retBtn.className = 'btn-secondary rr-exempt-access'; retBtn.style.width = 'auto';
            retBtn.textContent = '↩️ Повернути наверх';
            retBtn.addEventListener('click', () => removeAssignedImage(encodedPath, cat.id));
            actRow.appendChild(aiBtn); actRow.appendChild(rrBtn); actRow.appendChild(retBtn);

            // Discipline slider
            const discWrap = document.createElement('div');
            discWrap.style.marginTop = '12px';
            const discLabels = document.createElement('div');
            discLabels.style.cssText = 'display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;';
            const lLeft = document.createElement('span'); lLeft.style.color = 'var(--profit)'; lLeft.textContent = '✅ Системний';
            const lMid = document.createElement('span'); lMid.style.cssText = `color:${discColor};font-weight:bold;`; lMid.textContent = `${discipline}/10`;
            const lRight = document.createElement('span'); lRight.style.color = 'var(--loss)'; lRight.textContent = '🔥 Емоційний';
            discLabels.appendChild(lLeft); discLabels.appendChild(lMid); discLabels.appendChild(lRight);
            const sliderEl = document.createElement('input');
            sliderEl.type = 'range'; sliderEl.min = '1'; sliderEl.max = '10'; sliderEl.value = String(discipline);
            sliderEl.className = 'discipline-slider'; sliderEl.style.cssText = `width:100%;accent-color:${discColor};`;
            sliderEl.addEventListener('input', () => window.updateDisciplineUI?.(encodedPath, sliderEl.value, sliderEl));
            sliderEl.addEventListener('change', () => window.saveDiscipline?.(encodedPath, sliderEl.value, sliderEl));
            discWrap.appendChild(discLabels); discWrap.appendChild(sliderEl);

            // Tags
            const tagsWrap = document.createElement('div'); tagsWrap.className = 'screen-tags-wrap';
            const tagsList = document.createElement('div'); tagsList.className = 'screen-tags-list';
            tags.forEach(tag => {
                const span = document.createElement('span'); span.className = 'screen-tag';
                span.textContent = `${tag} ✕`;
                span.addEventListener('click', () => window.removeScreenTag?.(encodedPath, tag));
                tagsList.appendChild(span);
            });
            const tagInputRow = document.createElement('div');
            tagInputRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;position:relative;';
            const tagInput = document.createElement('input');
            tagInput.type = 'text'; tagInput.className = 'screen-tag-input';
            tagInput.dataset.path = encodedPath; tagInput.placeholder = '+ тег';
            tagInput.addEventListener('input', () => window.showTagSuggestions?.(tagInput, encodedPath));
            tagInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    window.addScreenTag?.(encodedPath, tagInput);
                    tagInput.parentElement.querySelector('.tag-suggestions')?.style.setProperty('display', 'none');
                }
            });
            tagInput.addEventListener('blur', () => setTimeout(() => {
                tagInput.parentElement.querySelector('.tag-suggestions')?.style.setProperty('display', 'none');
            }, 150));
            const tagAddBtn = document.createElement('button');
            tagAddBtn.className = 'btn-secondary'; tagAddBtn.style.cssText = 'width:auto;padding:4px 10px;margin:0;';
            tagAddBtn.textContent = '+';
            tagAddBtn.addEventListener('click', () => window.addScreenTag?.(encodedPath, tagInput));
            tagInputRow.appendChild(tagInput); tagInputRow.appendChild(tagAddBtn);
            tagsWrap.appendChild(tagsList); tagsWrap.appendChild(tagInputRow);

            // AI vision box
            const aiBox = document.createElement('div');
            aiBox.id = `ai-vision-${cleanId}`; aiBox.className = 'ai-response-box';
            aiBox.style.cssText = 'margin-top:15px;display:none;';

            item.appendChild(zoomWrap); item.appendChild(actRow); item.appendChild(discWrap);
            item.appendChild(tagsWrap); item.appendChild(aiBox);
            catDiv.appendChild(item);
        });
        assignedContainer.appendChild(catDiv);
    });
    if (!assignedContainer.hasChildNodes()) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-muted);font-size:1.1rem;margin-top:20px;';
        empty.textContent = 'Немає скріншотів для цього дня.';
        assignedContainer.appendChild(empty);
    }
    
    document.getElementById('big-screen-date').innerText = state.selectedDateStr; 
    const infoEl = document.getElementById('sidebar-screen-info'); if (infoEl) infoEl.innerText = `Скріншотів додано: ${count}`;
    
    currentDayImages.forEach(encodedPath => { if(window.updateBadgeUI) window.updateBadgeUI(encodedPath) });

    if (window.refreshReviewRequestButtons) window.refreshReviewRequestButtons();
}

export async function loadImages() {
    showGlobalLoader('screens-load', 'Завантаження скріншотів...');
    if (!state.appData.unassignedImages) state.appData.unassignedImages = [];
    state.currentUnassignedImages = [...state.appData.unassignedImages].reverse();
    state.unassignedVisibleCount = 5; 
    try {
        renderUnassignedUI();
        await renderAssignedScreens();
    } finally {
        hideGlobalLoader('screens-load');
    }
}

function showConfirmModal(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:24px 28px;max-width:320px;width:90%;text-align:center;';
    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 20px;color:var(--text-main,#f8fafc);font-size:1rem;';
    msg.textContent = message;
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
    const btnYes = document.createElement('button');
    btnYes.textContent = 'Так';
    btnYes.style.cssText = 'padding:8px 22px;border-radius:8px;border:none;background:var(--loss,#ef4444);color:#fff;cursor:pointer;font-size:0.95rem;';
    btnYes.onclick = () => { overlay.remove(); onConfirm(); };
    const btnNo = document.createElement('button');
    btnNo.textContent = 'Скасувати';
    btnNo.style.cssText = 'padding:8px 22px;border-radius:8px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-main,#f8fafc);cursor:pointer;font-size:0.95rem;';
    btnNo.onclick = () => overlay.remove();
    btnRow.appendChild(btnYes); btnRow.appendChild(btnNo);
    box.appendChild(msg); box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

async function deleteFromStorage(path) {
    try {
        await deleteFromSupabaseStorage(path);
    } catch(e) {
        console.warn('Storage delete error:', e.message);
    }
}

function addToBlacklist(url) {
    if (!state.appData.settings.driveIgnored) state.appData.settings.driveIgnored = [];
    if (!state.appData.settings.driveIgnored.includes(url)) state.appData.settings.driveIgnored.push(url);
}

export function deleteFileFromPC(encodedPath) {
    const url = decodeURIComponent(encodedPath);
    showConfirmModal('Видалити цей скріншот назавжди?', async () => {
        const idx = state.appData.unassignedImages.indexOf(url);
        if (idx > -1) state.appData.unassignedImages.splice(idx, 1);
        addToBlacklist(url);
        await deleteFromStorage(url);
        saveSettings().then(() => loadImages());
    });
}

export function deleteAssignedImage(encodedPath, category) {
    const url = decodeURIComponent(encodedPath);
    showConfirmModal('Видалити цей скріншот назавжди?', async () => {
        const arr = state.appData.journal[state.selectedDateStr]?.screenshots?.[category];
        if (arr) { const i = arr.indexOf(url); if (i > -1) arr.splice(i, 1); }
        addToBlacklist(url);
        await deleteFromStorage(url);
        markJournalDayDirty(state.selectedDateStr);
        saveJournalData()
            .then(() => saveSettings())
            .then(() => { loadImages(); if(window.renderView) window.renderView(); });
    });
}

export function assignImage(encodedPath, category) { 
    let url = decodeURIComponent(encodedPath); 
    ensureDayStructure(state.selectedDateStr); 
    if (!state.appData.journal[state.selectedDateStr].screenshots) {
        state.appData.journal[state.selectedDateStr].screenshots = { good:[], normal:[], bad:[], error:[] }; 
    }
    
    state.appData.journal[state.selectedDateStr].screenshots[category].push(url); 
    
    let unassignedIdx = state.appData.unassignedImages.indexOf(url);
    if(unassignedIdx > -1) state.appData.unassignedImages.splice(unassignedIdx, 1);
    
    markJournalDayDirty(state.selectedDateStr);
    saveJournalData()
        .then(() => saveSettings())
        .then(() => { 
        loadImages(); 
        if(window.renderView) window.renderView(); 
        let viewStats = document.getElementById('view-stats');
        if(viewStats && viewStats.classList.contains('active') && window.refreshStatsView) window.refreshStatsView(); 
    }); 
}

export function removeAssignedImage(encodedPath, category) { 
    let url = decodeURIComponent(encodedPath);
    const dayData = state.appData.journal[state.selectedDateStr];
    if (!dayData?.screenshots?.[category]) return;
    let arr = dayData.screenshots[category]; 
    let idx = arr.indexOf(url); 
    if(idx > -1) { 
        arr.splice(idx, 1); 
        if (!state.appData.unassignedImages) state.appData.unassignedImages = [];
        if (!state.appData.unassignedImages.includes(url)) state.appData.unassignedImages.push(url);
        
        markJournalDayDirty(state.selectedDateStr);
        saveJournalData()
            .then(() => saveSettings())
            .then(() => { 
            loadImages(); 
            if(window.renderView) window.renderView(); 
            let viewStats = document.getElementById('view-stats');
            if(viewStats && viewStats.classList.contains('active') && window.refreshStatsView) window.refreshStatsView(); 
        }); 
    } 
}

window.updateDisciplineUI = function(encodedPath, value, slider) {
    const v = parseInt(value);
    const color = v <= 3 ? '#10b981' : v >= 8 ? '#ef4444' : '#f59e0b';
    slider.style.accentColor = color;
    const wrap = slider.closest('div[style*="margin-top:12px"]');
    if (wrap) {
        const valLabel = wrap.querySelector('span:nth-child(2)');
        if (valLabel) { valLabel.textContent = `${v}/10`; valLabel.style.color = color; }
    }
};

let _disciplineSaveTimer = null;
window.saveDiscipline = function(encodedPath, value, slider) {
    const filename = decodeURIComponent(encodedPath);
    if (!state.appData.screenDiscipline) state.appData.screenDiscipline = {};
    state.appData.screenDiscipline[filename] = parseInt(value) || 5;
    window.updateDisciplineUI(encodedPath, value, slider);
    clearTimeout(_disciplineSaveTimer);
    _disciplineSaveTimer = setTimeout(() => void saveSettings(), 500);
};

window.addScreenTag = function(encodedPath, input) {
    const tag = input.value.trim();
    if (!tag) return;
    const filename = decodeURIComponent(encodedPath);
    if (!state.appData.screenTags) state.appData.screenTags = {};
    if (!state.appData.screenTags[filename]) state.appData.screenTags[filename] = [];
    if (!state.appData.screenTags[filename].includes(tag)) {
        state.appData.screenTags[filename].push(tag);
        saveSettings().then(() => renderAssignedScreens());
    }
    input.value = '';
    const dl = input.nextElementSibling?.id === input.id + '-dl' ? input.nextElementSibling : document.getElementById(input.id + '-dl');
    if (dl) dl.style.display = 'none';
};

window.showTagSuggestions = function(input, encodedPath) {
    const val = input.value.toLowerCase();
    const allTags = new Set();
    if (state.appData.screenTags) {
        Object.values(state.appData.screenTags).forEach(tags => tags.forEach(t => allTags.add(t)));
    }
    const filtered = [...allTags].filter(t => t.toLowerCase().includes(val) && val.length > 0);
    let dl = input.parentElement.querySelector('.tag-suggestions');
    if (!dl) {
        dl = document.createElement('div');
        dl.className = 'tag-suggestions';
        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(dl);
    }
    if (filtered.length === 0) { dl.style.display = 'none'; return; }
    dl.textContent = '';
    filtered.forEach(t => {
        const item = document.createElement('div');
        item.className = 'tag-suggestion-item';
        item.textContent = t;
        item.addEventListener('mousedown', e => {
            e.preventDefault();
            const tagInput = document.querySelector(`.screen-tag-input[data-path="${encodedPath}"]`);
            if (tagInput) { tagInput.value = t; window.addScreenTag(encodedPath, tagInput); }
        });
        dl.appendChild(item);
    });
    dl.style.display = 'block';
};


window.removeScreenTag = function(encodedPath, tag) {
    const filename = decodeURIComponent(encodedPath);
    if (!state.appData.screenTags?.[filename]) return;
    state.appData.screenTags[filename] = state.appData.screenTags[filename].filter(t => t !== tag);
    saveSettings().then(() => renderAssignedScreens());
};

window.toggleTagSearch = function() {
    const panel = document.getElementById('tag-search-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

window.showTagSearchSuggestions = function(input) {
    const val = input.value.toLowerCase();
    const allTags = new Set();
    if (state.appData.screenTags) {
        Object.values(state.appData.screenTags).forEach(tags => tags.forEach(t => allTags.add(t)));
    }
    const dl = document.getElementById('tag-search-suggestions');
    if (!dl) return;
    const filtered = val.length > 0 ? [...allTags].filter(t => t.toLowerCase().includes(val)) : [...allTags];
    if (filtered.length === 0) { dl.style.display = 'none'; return; }
    dl.textContent = '';
    filtered.forEach(t => {
        const item = document.createElement('div');
        item.className = 'tag-suggestion-item';
        item.textContent = t;
        item.addEventListener('mousedown', e => {
            e.preventDefault();
            document.getElementById('tag-search-input').value = t;
            dl.style.display = 'none';
        });
        dl.appendChild(item);
    });
    dl.style.display = 'block';
};

window.runTagSearch = function() {
    const tag = document.getElementById('tag-search-input').value.trim().toLowerCase();
    const from = document.getElementById('tag-search-from').value;
    const to   = document.getElementById('tag-search-to').value;
    const limitEl = document.getElementById('tag-search-limit');
    const limit = limitEl ? (parseInt(limitEl.value) || 50) : 50;
    const resultsEl = document.getElementById('tag-search-results');
    resultsEl.innerHTML = '';

    const screenTags = state.appData.screenTags || {};
    const journal    = state.appData.journal    || {};
    const results    = [];
    // Track filenames already added to avoid duplicates when iterating journal
    const seen = new Set();

    if (tag) {
        // Tag filter: only files that have a matching tag
        for (const [filename, tags] of Object.entries(screenTags)) {
            if (!tags.some(t => t.toLowerCase().includes(tag))) continue;
            for (const [date, dayData] of Object.entries(journal)) {
                if (from && date < from) continue;
                if (to   && date > to)   continue;
                const screens = dayData.screenshots || {};
                let cat = null;
                if ((screens.good  ||[]).includes(filename)) cat = '✅ Хороший';
                else if ((screens.normal||[]).includes(filename)) cat = '🟡 Норм';
                else if ((screens.bad   ||[]).includes(filename)) cat = '🟠 Поганий';
                else if ((screens.error ||[]).includes(filename)) cat = '🔴 Помилка';
                if (!cat) continue;
                const matchedTags = tags.filter(t => t.toLowerCase().includes(tag));
                results.push({ date, pnl: parseFloat(dayData.pnl) || 0, filename, cat, tags: matchedTags });
            }
        }
    } else {
        // No tag filter: collect ALL screenshots from journal, ordered by date desc
        const sortedDates = Object.keys(journal).sort((a, b) => b.localeCompare(a));
        for (const date of sortedDates) {
            if (from && date < from) continue;
            if (to   && date > to)   continue;
            const dayData = journal[date];
            const screens = dayData.screenshots || {};
            const catMap = [
                [screens.good   || [], '✅ Хороший'],
                [screens.normal || [], '🟡 Норм'],
                [screens.bad    || [], '🟠 Поганий'],
                [screens.error  || [], '🔴 Помилка'],
            ];
            for (const [list, cat] of catMap) {
                for (const filename of list) {
                    if (seen.has(filename)) continue;
                    seen.add(filename);
                    const tags = screenTags[filename] || [];
                    results.push({ date, pnl: parseFloat(dayData.pnl) || 0, filename, cat, tags });
                }
            }
        }
    }

    if (results.length === 0) {
        const empty = document.createElement('span');
        empty.style.color = 'var(--text-muted)';
        empty.textContent = 'Нічого не знайдено';
        resultsEl.appendChild(empty);
        return;
    }

    // Already sorted by date desc for the empty-tag path; re-sort for tag path
    if (tag) results.sort((a, b) => b.date.localeCompare(a.date));
    const limited = results.slice(0, limit);

    const totalPnl  = limited.reduce((s, r) => s + r.pnl, 0);
    const minusDays = new Set(limited.filter(r => r.pnl < 0).map(r => r.date)).size;
    const totalDays = new Set(limited.map(r => r.date)).size;

    const summaryDiv = document.createElement('div');
    summaryDiv.style.cssText = 'margin-bottom:12px;padding:10px;background:var(--bg-panel);border-radius:8px;display:flex;gap:20px;flex-wrap:wrap;';
    const mkStat = (text, value, color) => {
        const s = document.createElement('span'); s.style.color = color || '';
        s.textContent = text;
        const b = document.createElement('strong'); b.textContent = value;
        s.appendChild(b); return s;
    };
    summaryDiv.appendChild(mkStat('📅 Днів: ',   String(totalDays)));
    summaryDiv.appendChild(mkStat('📸 Скрінів: ', String(limited.length) + (results.length > limit ? ' / ' + results.length + ' (ліміт)' : '')));
    summaryDiv.appendChild(mkStat('💰 PnL: ', `${totalPnl.toFixed(2)}$`, totalPnl >= 0 ? 'var(--profit)' : 'var(--loss)'));
    summaryDiv.appendChild(mkStat('❌ Мінусових днів: ', String(minusDays), 'var(--loss)'));
    resultsEl.appendChild(summaryDiv);

    limited.forEach(r => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:12px; align-items:flex-start; padding:10px; background:var(--bg-panel); border-radius:8px; margin-bottom:8px; border:1px solid var(--border);';

        const img = document.createElement('img');
        img.style.cssText = 'width:120px; height:80px; object-fit:cover; border-radius:6px; cursor:pointer; flex-shrink:0;';
        getStorageUrl(r.filename).then(src => {
            img.src = src;
            img.onclick = () => openZoom(src);
        });

        const info    = document.createElement('div');
        const dateDiv = document.createElement('div');
        dateDiv.style.cssText = 'font-weight:bold; margin-bottom:4px;';
        dateDiv.textContent = `${r.date}  ${r.cat}`;

        const pnlDiv = document.createElement('div');
        pnlDiv.style.cssText = `color:${r.pnl >= 0 ? 'var(--profit)' : 'var(--loss)'}; margin-bottom:6px;`;
        pnlDiv.textContent = `PnL: ${r.pnl.toFixed(2)}$`;

        const tagsDiv = document.createElement('div');
        tagsDiv.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px;';
        r.tags.forEach(t => {
            const span = document.createElement('span');
            span.className = 'screen-tag';
            span.style.cursor = 'default';
            span.textContent = t;
            tagsDiv.appendChild(span);
        });

        info.appendChild(dateDiv);
        info.appendChild(pnlDiv);
        info.appendChild(tagsDiv);
        row.appendChild(img);
        row.appendChild(info);
        resultsEl.appendChild(row);
    });
};

window.viewLeaderScreens = async function() {
    const date = state.selectedDateStr;
    if (!date) return;

    const allNicks = [];
    for (let group in state.TEAM_GROUPS) {
        state.TEAM_GROUPS[group].forEach(t => {
            const nick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t;
            if (!allNicks.includes(nick)) allNicks.push(nick);
        });
    }
    // Додаємо себе
    const myNick = state.USER_DOC_NAME.replace('_stats', '');
    if (myNick && !allNicks.includes(myNick)) allNicks.push(myNick);

    if (!allNicks.length) { showToast('Немає трейдерів у команді'); return; }

    showToast('⏳ Шукаємо лідера...');

    // Для кожного беремо з кешу або завантажуємо
    const entries = await Promise.all(allNicks.map(async nick => {
        const docKey = `${nick}_stats`;
        // Свої дані завжди актуальні
        if (docKey === state.USER_DOC_NAME) return { nick, data: state.appData };
        let data = state.statsDocCache[docKey];
        if (!data) {
            try {
                const { getStatsDocData } = await import('./stats.js');
                data = await getStatsDocData(docKey, [
                    {
                        type: 'month',
                        val: `${state.todayObj.getFullYear()}-${state.todayObj.getMonth()}`,
                        label: state.selectedDateStr.slice(0, 7)
                    }
                ]);
                state.statsDocCache[docKey] = data;
            } catch(e) { data = null; }
        }
        return { nick, data };
    }));

    let leader = null;
    let bestScore = -Infinity;

    // Перевіряємо чи є КФ хоч у когось
    const anyHasKf = entries.some(({ data }) => {
        const dayData = (data?.journal || {})[date];
        if (!dayData) return false;
        const kf = parseFloat(dayData.kf);
        return !isNaN(kf) && dayData.kf !== null && dayData.kf !== '';
    });

    entries.forEach(({ nick, data }) => {
        if (!data) return;
        const dayData = (data.journal || {})[date];
        if (!dayData) return;
        const kf = parseFloat(dayData.kf);
        const pnl = parseFloat(dayData.pnl);
        const hasKf = !isNaN(kf) && dayData.kf !== null && dayData.kf !== '';
        // Якщо хоч у когось є КФ — всі по КФ (хто не заповнив — ігнорується)
        // Якщо ні у кого немає КФ — всі по PnL
        let score;
        if (anyHasKf) {
            if (!hasKf) return;
            score = kf;
        } else {
            if (isNaN(pnl)) return;
            score = pnl;
        }
        console.log(`[Leader] ${nick}: kf=${kf}, pnl=${pnl}, score=${score}`);
        if (score > bestScore) { bestScore = score; leader = nick; }
    });

    if (!leader) { showToast(`Немає даних за ${date}`); return; }

    showToast(`🏆 Лідер дня: ${leader} (${bestScore.toFixed(2)})`);
    if (window.switchUser) window.switchUser(leader);
    if (window.switchMainTab) window.switchMainTab('screens');
};

window.clearTagSearch = function() {
    document.getElementById('tag-search-input').value = '';
    document.getElementById('tag-search-from').value = '';
    document.getElementById('tag-search-to').value = '';
    document.getElementById('tag-search-results').innerHTML = '';
    document.getElementById('tag-search-panel').style.display = 'none';
};

// Завантаження через Ctrl+V
window.addEventListener('paste', async function(e) {
    let items = (e.clipboardData || e.originalEvent.clipboardData).items;
    let file = null;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) { file = items[i].getAsFile(); break; }
    }
    if (!file) return;

    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        showToast('Ви не можете завантажувати скріншоти в чужий профіль!');
        return;
    }

    const titleEl = document.getElementById('unassigned-title');
    if (!titleEl) return;
    const originalText = titleEl.innerHTML;
    titleEl.innerHTML = '⏳ Завантаження картинки в хмару...';

    try {
        showGlobalLoader('upload-screen', 'Завантаження картинки в хмару...');
        const ext = file.type.includes('png') ? 'png' : 'jpg';
        const filename = buildScreenshotPath(`${Date.now()}.${ext}`);
        await uploadToSupabaseStorage(filename, file);
        // Зберігаємо шлях файлу (не URL) — URL генеруємо динамічно через SDK

        if (!state.appData.unassignedImages) state.appData.unassignedImages = [];
        state.appData.unassignedImages.push(filename);
        await saveSettings();
        loadImages();
        showGlobalLoader('upload-screen', 'Скріншот завантажено', { type: 'success' });
        hideGlobalLoader('upload-screen', 1200);
    } catch(err) {
        console.error('Помилка завантаження:', err);
        showGlobalLoader('upload-screen', 'Помилка завантаження', { type: 'error' });
        hideGlobalLoader('upload-screen', 2600);
        showToast('❌ Помилка завантаження: ' + err.message);
    } finally {
        titleEl.innerHTML = originalText;
    }
});
