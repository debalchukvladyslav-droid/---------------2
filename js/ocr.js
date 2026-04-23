// === js/ocr.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { getImgUrl, getStorageUrl } from './gallery.js';

export function setupOCRDrawing() {
    let container = document.getElementById('ocr-setup-container'); 
    let wrapper = document.getElementById('ocr-zoom-wrapper');
    let img = document.getElementById('ocr-setup-img'); 
    let box = document.getElementById('ocr-selection-box');
    let isDraggingOCR = false, dragStartX = 0, dragStartY = 0;
    
    container.addEventListener('contextmenu', e => e.preventDefault());
    
    container.addEventListener('wheel', (e) => {
        e.preventDefault(); let rect = container.getBoundingClientRect();
        let mouseX = e.clientX - rect.left; let mouseY = e.clientY - rect.top;
        let targetX = (mouseX - state.ocrTranslateX) / state.ocrScale; let targetY = (mouseY - state.ocrTranslateY) / state.ocrScale;
        let delta = e.deltaY < 0 ? 1.1 : 0.9;
        let newScale = Math.max(state.ocrMinScale, Math.min(8.0, state.ocrScale * delta));
        if (newScale <= state.ocrMinScale + 0.01) {
            state.ocrTranslateX = (rect.width - img.naturalWidth * newScale) / 2; state.ocrTranslateY = (rect.height - img.naturalHeight * newScale) / 2; newScale = state.ocrMinScale;
        } else {
            state.ocrTranslateX = mouseX - targetX * newScale; state.ocrTranslateY = mouseY - targetY * newScale;
        }
        state.ocrScale = newScale; wrapper.style.transform = `translate(${state.ocrTranslateX}px, ${state.ocrTranslateY}px) scale(${state.ocrScale})`;
    });

    wrapper.addEventListener('mousedown', (e) => {
        let rect = container.getBoundingClientRect(); let mouseX = e.clientX - rect.left; let mouseY = e.clientY - rect.top;
        if (e.button === 2) { 
            isDraggingOCR = true; dragStartX = mouseX - state.ocrTranslateX; dragStartY = mouseY - state.ocrTranslateY; container.style.cursor = 'grabbing';
        } else if (e.button === 0) { 
            state.isDrawingOCR = true; state.ocrStartX = (mouseX - state.ocrTranslateX) / state.ocrScale; state.ocrStartY = (mouseY - state.ocrTranslateY) / state.ocrScale;
            box.style.left = state.ocrStartX + 'px'; box.style.top = state.ocrStartY + 'px'; box.style.width = '0px'; box.style.height = '0px'; box.style.display = 'block';
        }
    });

    window.addEventListener('mousemove', (e) => {
        let rect = container.getBoundingClientRect(); let mouseX = e.clientX - rect.left; let mouseY = e.clientY - rect.top;
        if (isDraggingOCR) {
            state.ocrTranslateX = mouseX - dragStartX; state.ocrTranslateY = mouseY - dragStartY; wrapper.style.transform = `translate(${state.ocrTranslateX}px, ${state.ocrTranslateY}px) scale(${state.ocrScale})`;
        } else if (state.isDrawingOCR) {
            let currentX = (mouseX - state.ocrTranslateX) / state.ocrScale; let currentY = (mouseY - state.ocrTranslateY) / state.ocrScale;
            currentX = Math.max(0, Math.min(currentX, img.naturalWidth)); currentY = Math.max(0, Math.min(currentY, img.naturalHeight));
            let width = Math.abs(currentX - state.ocrStartX); let height = Math.abs(currentY - state.ocrStartY);
            let left = Math.min(currentX, state.ocrStartX); let top = Math.min(currentY, state.ocrStartY);
            box.style.left = left + 'px'; box.style.top = top + 'px'; box.style.width = width + 'px'; box.style.height = height + 'px';
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (e.button === 2 && isDraggingOCR) { isDraggingOCR = false; container.style.cursor = 'crosshair'; }
        if (e.button === 0 && state.isDrawingOCR) {
            state.isDrawingOCR = false; let boxWidth = parseFloat(box.style.width); let boxHeight = parseFloat(box.style.height);
            if (boxWidth < 10) return;
            state.pendingOCRRect = { left: Math.round(parseFloat(box.style.left)), top: Math.round(parseFloat(box.style.top)), width: Math.round(boxWidth), height: Math.round(boxHeight) };
            document.getElementById('ocr-setup-status').innerText = `Нова зона: Зліва: ${state.pendingOCRRect.left}px. Зверху: ${state.pendingOCRRect.top}px. Натисніть кнопку нижче.`;
        }
    });
}

export async function loadLatestImageForOCR() {
    try {
        let latestImg = null;
        if (state.appData.unassignedImages && state.appData.unassignedImages.length > 0) {
            latestImg = state.appData.unassignedImages[state.appData.unassignedImages.length - 1]; 
        } else if (state.appData.journal[state.selectedDateStr] && state.appData.journal[state.selectedDateStr].screenshots) {
            let sc = state.appData.journal[state.selectedDateStr].screenshots;
            let assigned = [...sc.good, ...sc.normal, ...sc.bad, ...sc.error];
            if (assigned.length > 0) latestImg = assigned[assigned.length - 1];
        }

        let ocrContainer = document.getElementById('ocr-setup-container');
        let statusEl = document.getElementById('ocr-setup-status');

        function showNoImage(msg) {
            if (ocrContainer) ocrContainer.style.display = 'none';
            if (statusEl) statusEl.innerText = msg;
        }

        if (latestImg) {
            let src = await getStorageUrl(latestImg);
            let imgEl = document.getElementById('ocr-setup-img');

            imgEl.onerror = function() {
                imgEl.src = '';
                showNoImage('⚠️ Не вдалося завантажити скріншот. Додайте новий і поверніться сюди.');
            };

            imgEl.onload = function() {
                if (ocrContainer) ocrContainer.style.display = '';
                let rectContainer = ocrContainer.getBoundingClientRect();
                let scaleX = rectContainer.width / imgEl.naturalWidth;
                let scaleY = rectContainer.height / imgEl.naturalHeight;
                state.ocrMinScale = Math.min(1.0, Math.min(scaleX, scaleY));
                state.ocrScale = state.ocrMinScale;
                state.ocrTranslateX = (rectContainer.width - imgEl.naturalWidth * state.ocrScale) / 2;
                state.ocrTranslateY = (rectContainer.height - imgEl.naturalHeight * state.ocrScale) / 2;
                document.getElementById('ocr-zoom-wrapper').style.transform = `translate(${state.ocrTranslateX}px, ${state.ocrTranslateY}px) scale(${state.ocrScale})`;

                let box = document.getElementById('ocr-selection-box');
                let rect = state.appData.settings.ocrRect;
                box.style.left = rect.left + 'px'; box.style.top = rect.top + 'px'; box.style.width = rect.width + 'px'; box.style.height = rect.height + 'px'; box.style.display = 'block';
                state.pendingOCRRect = Object.assign({}, rect);
                if (statusEl) statusEl.innerText = 'Коліщатко — зум. Права кнопка — тягати. Ліва кнопка — виділяти.';
            };
            imgEl.src = src;
        } else {
            showNoImage('⚠️ Скріншотів немає. Додайте хоча б один і поверніться сюди.');
        }
    } catch (e) {
        console.error('Помилка завантаження OCR скріна:', e);
        const ocrContainer = document.getElementById('ocr-setup-container');
        const statusEl = document.getElementById('ocr-setup-status');
        if (ocrContainer) ocrContainer.style.display = 'none';
        if (statusEl) statusEl.innerText = '⚠️ Не вдалося завантажити скріншот. Додайте новий і поверніться сюди.';
    }
}

function showToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);color:var(--text-main,#f8fafc);padding:10px 22px;border-radius:10px;font-size:0.95rem;z-index:99999;pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function showPromptModal(labelText, defaultValue, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:24px 28px;max-width:320px;width:90%;';
    const label = document.createElement('p');
    label.style.cssText = 'margin:0 0 12px;color:var(--text-main,#f8fafc);font-size:1rem;';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#334155);background:var(--bg,#0f172a);color:var(--text-main,#f8fafc);font-size:0.95rem;margin-bottom:16px;';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;';
    const btnOk = document.createElement('button');
    btnOk.textContent = 'OK';
    btnOk.style.cssText = 'padding:8px 22px;border-radius:8px;border:none;background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:0.95rem;';
    btnOk.onclick = () => { overlay.remove(); onConfirm(input.value); };
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Скасувати';
    btnCancel.style.cssText = 'padding:8px 22px;border-radius:8px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-main,#f8fafc);cursor:pointer;font-size:0.95rem;';
    btnCancel.onclick = () => overlay.remove();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') btnOk.click(); if (e.key === 'Escape') overlay.remove(); });
    btnRow.appendChild(btnCancel); btnRow.appendChild(btnOk);
    box.appendChild(label); box.appendChild(input); box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    input.focus(); input.select();
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
    btnYes.style.cssText = 'padding:8px 22px;border-radius:8px;border:none;background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:0.95rem;';
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

export function saveVisualOCRSettings() {
    if (state.pendingOCRRect) {
        state.appData.settings.ocrRect = state.pendingOCRRect;
        saveToLocal().then(() => {
            showToast('Зону успішно збережено!');
            let imagesToShow = state.currentUnassignedImages.slice(0, state.unassignedVisibleCount);
            for (let img of imagesToShow) { 
                let encodedPath = encodeURIComponent(img); let cleanPath = decodeURIComponent(encodedPath); 
                state.appData.tickers[cleanPath] = null; 
                runOCR(encodedPath, true); 
            }
            if (state.appData.journal[state.selectedDateStr] && state.appData.journal[state.selectedDateStr].screenshots) {
                let sc = state.appData.journal[state.selectedDateStr].screenshots; let assigned = [...sc.good, ...sc.normal, ...sc.bad, ...sc.error];
                for (let img of assigned) { 
                    let encodedPath = encodeURIComponent(img); let cleanPath = decodeURIComponent(encodedPath); 
                    state.appData.tickers[cleanPath] = null; 
                    runOCR(encodedPath, true); 
                }
            }
        });
    } else { showToast('Спочатку виділіть зону на картинці.'); }
}

export function editTicker(encodedPath, event) {
    if (event) event.stopPropagation();
    const safePath = decodeURIComponent(encodedPath);
    const current = (state.appData.tickers[safePath] && state.appData.tickers[safePath] !== '...') ? state.appData.tickers[safePath] : '';
    showPromptModal('Введіть правильний тікер:', current, (newVal) => {
        if (newVal.trim() !== '') {
            state.appData.tickers[safePath] = newVal.toUpperCase().trim();
            saveToLocal();
            updateBadgeUI(encodedPath);
        }
    });
}

export function forceScan(encodedPath, event) {
    if (event) event.stopPropagation();
    showConfirmModal('Хочете автоматично змінити тікер? (пересканувати виділену область)', () => {
        runOCR(encodedPath, true);
    });
}

export function updateBadgeUI(encodedPath, isLoading = false) {
    let safePath = decodeURIComponent(encodedPath);
    let cleanId = 'ticker-' + safePath.replace(/[^a-zA-Z0-9]/g, '');
    let el = document.getElementById(cleanId);
    if (!el) {
        // Елемент ще не в DOM — повторимо через короткий час (макс 10 спроб)
        const retries = (updateBadgeUI._retries = updateBadgeUI._retries || {});
        retries[encodedPath] = (retries[encodedPath] || 0) + 1;
        if (retries[encodedPath] <= 10) setTimeout(() => updateBadgeUI(encodedPath, isLoading), 100);
        else delete retries[encodedPath];
        return;
    }
    if (updateBadgeUI._retries) delete updateBadgeUI._retries[encodedPath];

    el.innerHTML = '';

    if (isLoading) {
        const spinner = document.createElement('span');
        spinner.textContent = '⏳';
        const rescanBtn = document.createElement('span');
        rescanBtn.textContent = '🔄';
        rescanBtn.title = 'Повторити авто-пошук';
        rescanBtn.style.cursor = 'pointer';
        rescanBtn.addEventListener('click', (e) => forceScan(encodedPath, e));
        el.appendChild(spinner);
        el.appendChild(rescanBtn);
    } else {
        const tickerText = state.appData.tickers[safePath] || '???';
        const editBtn = document.createElement('span');
        editBtn.textContent = tickerText + ' ✏️';
        editBtn.title = 'Змінити вручну';
        editBtn.style.cursor = 'pointer';
        editBtn.addEventListener('click', (e) => editTicker(encodedPath, e));
        const rescanBtn = document.createElement('span');
        rescanBtn.textContent = '🔄';
        rescanBtn.title = 'Повторити авто-пошук';
        rescanBtn.style.cursor = 'pointer';
        rescanBtn.addEventListener('click', (e) => forceScan(encodedPath, e));
        el.appendChild(editBtn);
        el.appendChild(rescanBtn);
    }
}

const TICKER_GARBAGE = new Set([
    'FLEXIBLE','GRID','MAIN','THINKORSWIM','BUILD','VWAP','NASDAQ','NYSE',
    'VOPRE','VDPRE','PRE','SHARE','STYLE','DRAWINGS','STUDIES','PATTERNS',
    'SELL','BUY','DAY','MIN','TOS','FE','FI','FL','AM','PM','EXT',
    'W','M','D','Y','H','S','L','O','C','V','P','R','T','N','E','A','B',
    'AH','EST','USD','PNL','NET','AVG','QTY','POS','ALL','NEW','SET',
    'OPEN','CLOSE','HIGH','LOW','LAST','MARK','BID','ASK','VOL','HALT',
    'CHART','SCAN','TRADE','LEVEL','PRICE','SIZE','TIME','DATE','BETA',
    'CALL','PUT','EXP','ITM','OTM','ATM','THEO','DELTA','GAMMA','THETA',
    'AFTER','HOURS','MARKET','LIMIT','STOP','ORDER','FILLED','CANCEL'
]);

function normalizeTicker(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function validTickerWord(w) {
    return w.length >= 2 && w.length <= 5 && /^[A-Z]+$/.test(w) && !TICKER_GARBAGE.has(w);
}

function findScreenshotDate(path) {
    for (const [dateStr, day] of Object.entries(state.appData?.journal || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
        const screens = day?.screenshots || {};
        const all = [...(screens.good || []), ...(screens.normal || []), ...(screens.bad || []), ...(screens.error || [])];
        if (all.includes(path)) return dateStr;
    }
    return state.selectedDateStr;
}

function tradeTickersForPath(path) {
    const day = state.appData?.journal?.[findScreenshotDate(path)] || {};
    const set = new Set();
    (day.traded_tickers || []).forEach(t => { const n = normalizeTicker(t); if (n) set.add(n); });
    (day.trades || []).forEach(t => { const n = normalizeTicker(t.symbol); if (n) set.add(n); });
    return Array.from(set);
}

function extractTickerFromText(rawText, tradedTickers = [], ocrWords = []) {
    const clean = rawText.toUpperCase().replace(/[^A-Z\s]/g, ' ');
    const words = clean.split(/\s+/).filter(validTickerWord);
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    const highConfidence = (ocrWords || [])
        .map(w => ({ text: normalizeTicker(w.text), confidence: Number(w.confidence) || 0 }))
        .filter(w => validTickerWord(w.text));

    // 1. Збіг з traded_tickers — найвищий пріоритет
    for (const w of traded) {
        if (words.includes(w) || highConfidence.some(item => item.text === w && item.confidence >= 45)) return w;
    }

    // 2. Найчастіше слово
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    for (const w of highConfidence) freq[w.text] = (freq[w.text] || 0) + Math.max(1, w.confidence / 40);
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : '???';
}

// Вирізаємо зону з зображення для OCR
function cropCanvas(imgObj, x, y, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(imgObj, x, y, w, h, 0, 0, w, h);
    return canvas;
}

// Підвищуємо контраст для Tesseract
function applyContrast(canvas) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
        const avg = (d[i] + d[i+1] + d[i+2]) / 3;
        const v = avg > 128 ? 255 : 0;
        d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

function buildAutoOCRZones(iw, ih) {
    const clampZone = (x, y, w, h) => {
        const left = Math.max(0, Math.round(x));
        const top = Math.max(0, Math.round(y));
        return {
            x: left,
            y: top,
            w: Math.max(20, Math.min(iw - left, Math.round(w))),
            h: Math.max(20, Math.min(ih - top, Math.round(h))),
        };
    };

    return [
        clampZone(0, 0, iw * 0.28, ih * 0.09),
        clampZone(0, 0, iw * 0.42, ih * 0.14),
        clampZone(0, 0, iw, ih * 0.16),
        clampZone(iw * 0.18, 0, iw * 0.42, ih * 0.12),
        clampZone(0, ih * 0.05, iw * 0.5, ih * 0.16),
        clampZone(0, 0, iw, ih * 0.28),
    ];
}

function makeOCRCanvas(imgObj, zone, scale = 3) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, zone.w * scale);
    canvas.height = Math.max(1, zone.h * scale);
    canvas.getContext('2d').drawImage(imgObj, zone.x, zone.y, zone.w, zone.h, 0, 0, canvas.width, canvas.height);
    return applyContrast(canvas);
}

export async function runOCR(encodedPath, force = false) {
    if (!window.Tesseract) return;
    const safePath = decodeURIComponent(encodedPath);
    const existing = state.appData.tickers[safePath];
    if (!force && existing && existing !== '???' && existing !== '⏳') { updateBadgeUI(encodedPath, false); return; }

    try {
        updateBadgeUI(encodedPath, true);
        const src = await getStorageUrl(safePath);

        const imgObj = new Image();
        imgObj.crossOrigin = 'Anonymous';
        await new Promise((resolve, reject) => { imgObj.onload = resolve; imgObj.onerror = reject; imgObj.src = src; });

        const iw = imgObj.naturalWidth;
        const ih = imgObj.naturalHeight;

        const zones = buildAutoOCRZones(iw, ih);

        const traded = tradeTickersForPath(safePath);

        let ticker = '???';
        for (const zone of zones) {
            const canvas = makeOCRCanvas(imgObj, zone, 3);

            const { data } = await Tesseract.recognize(canvas, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
                tessedit_pageseg_mode: '6',
            });

            ticker = extractTickerFromText(data.text || '', traded, data.words || []);
            if (ticker !== '???') break; // знайшли — зупиняємось
        }

        state.appData.tickers[safePath] = ticker;
        saveToLocal();
        updateBadgeUI(encodedPath, false);
        return ticker;
    } catch (e) {
        console.error('Помилка OCR:', e);
        state.appData.tickers[safePath] = '???';
        updateBadgeUI(encodedPath, false);
        return '???';
    }
}
