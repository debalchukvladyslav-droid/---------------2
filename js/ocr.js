// === js/ocr.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { getImgUrl, getStorageUrl } from './gallery.js';
import { ensureTesseract } from './vendor_loader.js';

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

function normalizeOCRTicker(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[0@]/g, 'O')
        .replace(/[1!|]/g, 'I')
        .replace(/2/g, 'Z')
        .replace(/3/g, 'E')
        .replace(/4/g, 'A')
        .replace(/5|\$/g, 'S')
        .replace(/6/g, 'G')
        .replace(/7/g, 'T')
        .replace(/8/g, 'B')
        .replace(/[^A-Z]/g, '');
}

function validTickerWord(w, { allowSingle = false, trusted = false } = {}) {
    const minLen = allowSingle ? 1 : 2;
    if (w.length < minLen || w.length > 5 || !/^[A-Z]+$/.test(w)) return false;
    if (trusted) return true;
    return !TICKER_GARBAGE.has(w);
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

function addCandidate(scores, ticker, points, opts = {}) {
    if (!validTickerWord(ticker, opts)) return;
    scores[ticker] = (scores[ticker] || 0) + points;
}

function scoreTickerCandidates(rawText, tradedTickers = [], ocrWords = [], zoneWeight = 1) {
    const clean = String(rawText || '').toUpperCase().replace(/[^A-Z0-9@$!|\s.-]/g, ' ');
    const words = clean.split(/\s+/).map(normalizeOCRTicker).filter(w => validTickerWord(w));
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    const highConfidence = (ocrWords || [])
        .map(w => ({ text: normalizeOCRTicker(w.text), confidence: Number(w.confidence) || 0 }))
        .filter(w => validTickerWord(w.text, { allowSingle: traded.includes(w.text), trusted: traded.includes(w.text) }));

    const scores = {};
    const wordSet = new Set(words);
    const rawTokens = clean.split(/\s+/).filter(Boolean);
    const exchanges = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS']);

    rawTokens.forEach((token, index) => {
        if (!exchanges.has(normalizeTicker(token))) return;
        for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
            const candidate = normalizeOCRTicker(rawTokens[i]);
            if (!validTickerWord(candidate)) continue;
            addCandidate(scores, candidate, 180 * zoneWeight);
            break;
        }
    });

    // Збіг з traded_tickers — найвищий пріоритет, бо це реальний список торгованих символів за день.
    for (const w of traded) {
        const trusted = { allowSingle: true, trusted: true };
        if (wordSet.has(w)) addCandidate(scores, w, 120 * zoneWeight, trusted);
        if (highConfidence.some(item => item.text === w && item.confidence >= 35)) addCandidate(scores, w, 160 * zoneWeight, trusted);
        if (words.some(word => word.includes(w) || w.includes(word))) addCandidate(scores, w, 45 * zoneWeight, trusted);
    }

    for (const w of words) addCandidate(scores, w, 18 * zoneWeight);
    for (const w of highConfidence) addCandidate(scores, w.text, Math.max(12, w.confidence / 2) * zoneWeight);

    Object.keys(scores).forEach(ticker => {
        if (traded.includes(ticker)) scores[ticker] += 80;
        if (ticker.length >= 3 && ticker.length <= 4) scores[ticker] += 14;
        if (ticker.length === 5) scores[ticker] += 4;
    });

    return scores;
}

function mergeScores(target, source) {
    for (const [ticker, score] of Object.entries(source)) {
        target[ticker] = (target[ticker] || 0) + score;
    }
}

function bestTickerFromScores(scores, tradedTickers = []) {
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return traded.length === 1 ? traded[0] : '???';

    const [best, bestScore] = sorted[0];
    const secondScore = sorted[1]?.[1] || 0;
    if (traded.includes(best) || bestScore >= 45 || bestScore >= secondScore * 1.35) return best;
    return traded.length === 1 ? traded[0] : '???';
}

// Вирізаємо зону з зображення для OCR
function cropCanvas(imgObj, x, y, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(imgObj, x, y, w, h, 0, 0, w, h);
    return canvas;
}

// Підвищуємо контраст для Tesseract
function applyContrast(canvas, { threshold = 128, invert = false } = {}) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
        const avg = (d[i] + d[i+1] + d[i+2]) / 3;
        let v = avg > threshold ? 255 : 0;
        if (invert) v = 255 - v;
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

    const zones = [];
    const custom = state.appData?.settings?.ocrRect;
    if (custom && custom.width > 10 && custom.height > 10) {
        zones.push(clampZone(custom.left, custom.top, custom.width, custom.height));
        zones.push(clampZone(custom.left - custom.width * 0.12, custom.top - custom.height * 0.25, custom.width * 1.25, custom.height * 1.45));
    }

    // thinkorswim layout: ticker is usually in a tiny header strip of each chart pane.
    const headerH = Math.max(18, ih * 0.045);
    const topHeaderY = Math.max(0, ih * 0.018);
    const lowerHeaderY = ih * 0.595;
    zones.push(
        clampZone(0, topHeaderY, iw * 0.76, headerH),
        clampZone(iw * 0.76, topHeaderY, iw * 0.24, headerH),
        clampZone(0, lowerHeaderY, iw * 0.22, headerH),
        clampZone(iw * 0.21, lowerHeaderY, iw * 0.62, headerH),
        clampZone(iw * 0.82, lowerHeaderY, iw * 0.18, headerH),
    );

    zones.push(
        clampZone(0, 0, iw * 0.28, ih * 0.09),
        clampZone(0, 0, iw * 0.42, ih * 0.14),
        clampZone(0, 0, iw, ih * 0.16),
        clampZone(iw * 0.18, 0, iw * 0.42, ih * 0.12),
        clampZone(0, ih * 0.05, iw * 0.5, ih * 0.16),
        clampZone(0, 0, iw, ih * 0.28),
    );

    const seen = new Set();
    return zones.filter(zone => {
        const key = `${zone.x}:${zone.y}:${zone.w}:${zone.h}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function makeScaledCanvas(imgObj, zone, scale = 4) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, zone.w * scale);
    canvas.height = Math.max(1, zone.h * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(imgObj, zone.x, zone.y, zone.w, zone.h, 0, 0, canvas.width, canvas.height);
    return canvas;
}

function cloneCanvas(canvas) {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    return copy;
}

function makeOCRVariants(imgObj, zone, scale = 4) {
    const base = makeScaledCanvas(imgObj, zone, scale);
    return [
        base,
        applyContrast(cloneCanvas(base), { threshold: 115 }),
        applyContrast(cloneCanvas(base), { threshold: 145 }),
        applyContrast(cloneCanvas(base), { threshold: 135, invert: true }),
    ];
}

export async function runOCR(encodedPath, force = false) {
    try {
        await ensureTesseract();
    } catch (error) {
        console.warn('[OCR] Tesseract lazy-load failed:', error);
        return;
    }
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

        const totalScores = {};
        let ticker = '???';
        for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex++) {
            const zone = zones[zoneIndex];
            const zoneWeight = Math.max(0.65, 1.45 - zoneIndex * 0.12);
            const variants = makeOCRVariants(imgObj, zone, zone.h <= ih * 0.06 ? 7 : zoneIndex < 2 ? 5 : 4);

            for (const canvas of variants) {
                const { data } = await Tesseract.recognize(canvas, 'eng', {
                    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@$!| ',
                    tessedit_pageseg_mode: zone.h < ih * 0.12 ? '7' : '6',
                    preserve_interword_spaces: '1',
                });

                mergeScores(totalScores, scoreTickerCandidates(data.text || '', traded, data.words || [], zoneWeight));
            }

            ticker = bestTickerFromScores(totalScores, traded);
            if (ticker !== '???' && traded.includes(ticker) && (totalScores[ticker] || 0) >= 220) break;
        }

        if (ticker === '???') ticker = bestTickerFromScores(totalScores, traded);

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
