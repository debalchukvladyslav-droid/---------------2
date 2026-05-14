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
        if (state.pendingOCRRect.width < 24 || state.pendingOCRRect.height < 12) {
            showToast('OCR-зона занадто мала. Виділіть ширшу область з тікером.');
            return;
        }
        state.appData.settings.ocrRect = state.pendingOCRRect;
        saveToLocal().then(async () => {
            showToast('Зону успішно збережено!');
            const paths = new Set(state.currentUnassignedImages.slice(0, state.unassignedVisibleCount));
            if (state.appData.journal[state.selectedDateStr] && state.appData.journal[state.selectedDateStr].screenshots) {
                let sc = state.appData.journal[state.selectedDateStr].screenshots; let assigned = [...sc.good, ...sc.normal, ...sc.bad, ...sc.error];
                assigned.forEach(img => paths.add(img));
            }
            for (let img of paths) {
                let encodedPath = encodeURIComponent(img); let cleanPath = decodeURIComponent(encodedPath);
                state.appData.tickers[cleanPath] = null;
                await runOCR(encodedPath, true);
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
    'SELL','BUY','DAY','MIN','TOS','FE','FI','FL','AM','PM','IM','EXT',
    'W','M','D','Y','H','S','L','O','C','V','P','R','T','N','E','A','B',
    'ID','IY','IH','IW',
    'AH','EST','USD','PNL','NET','AVG','QTY','POS','ALL','NEW','SET',
    'OPEN','CLOSE','HIGH','LOW','LAST','MARK','BID','ASK','VOL','HALT',
    'CHART','SCAN','TRADE','LEVEL','PRICE','SIZE','TIME','DATE','BETA',
    'CALL','PUT','EXP','ITM','OTM','ATM','THEO','DELTA','GAMMA','THETA',
    'AFTER','HOURS','MARKET','LIMIT','STOP','ORDER','FILLED','CANCEL',
    'IOA','LOA','LIO','IO','OA','OBEOE'
]);
const MIN_OCR_ZONE_WIDTH = 24;
const MIN_OCR_ZONE_HEIGHT = 12;
const MIN_OCR_CANVAS_WIDTH = 32;
const MIN_OCR_CANVAS_HEIGHT = 24;
const MIN_FREE_OCR_SCORE = 80;
const OCR_MAX_RAW_TEXT_LOG = 90;
const OCR_TOP_CANDIDATES_LIMIT = 3;

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

function uniqueTickers(values = []) {
    return Array.from(new Set(values.map(normalizeTicker).filter(Boolean)));
}

function editDistance(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (left === right) return 0;
    if (!left) return right.length;
    if (!right) return left.length;
    const prev = Array.from({ length: right.length + 1 }, (_, i) => i);
    const curr = Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= right.length; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
        }
        for (let j = 0; j <= right.length; j++) prev[j] = curr[j];
    }
    return prev[right.length];
}

function isNearTickerMatch(word, ticker) {
    if (!word || !ticker) return false;
    if (word === ticker) return true;
    if (word.length < 2 || ticker.length < 2) return false;
    if (word.includes(ticker) || ticker.includes(word)) return Math.min(word.length, ticker.length) >= 2;
    const distance = editDistance(word, ticker);
    if (ticker.length <= 3) return distance <= 1 && word.length === ticker.length;
    return distance <= 1 || (ticker.length >= 5 && distance <= 2);
}

function ocrConfusionVariants(word) {
    const value = normalizeOCRTicker(word);
    if (value.length < 2 || value.length > 5) return [];
    const out = new Set();
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        const replacements = {
            M: ['N'],
            N: ['M'],
            B: ['E'],
            E: ['B'],
        }[ch] || [];
        replacements.forEach((replacement) => {
            out.add(value.slice(0, i) + replacement + value.slice(i + 1));
        });
    }
    return Array.from(out).filter(v => v !== value && validTickerWord(v));
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

function ymdFromDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function screenshotCreatedDate(path) {
    const meta = state.appData?.screenMeta?.[path];
    const fromMeta = meta?.createdAt ? ymdFromDate(meta.createdAt) : '';
    if (fromMeta) return { date: fromMeta, source: 'screenMeta.createdAt', raw: meta.createdAt };

    const fileName = String(path || '').split(/[\\/]/).pop() || '';
    const timestampMatch = fileName.match(/(?:^|_)(1[5-9]\d{11}|2\d{12})(?=\.|_|-)/);
    if (timestampMatch) {
        const fromTimestamp = ymdFromDate(Number(timestampMatch[1]));
        if (fromTimestamp) return { date: fromTimestamp, source: 'filename timestamp', raw: timestampMatch[1] };
    }

    const assignedDate = findScreenshotDate(path);
    return { date: assignedDate, source: 'assigned journal date fallback', raw: assignedDate };
}

function addDays(dateStr, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return '';
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tickersForDay(dateStr) {
    const day = state.appData?.journal?.[dateStr] || {};
    const set = new Set();
    (day.traded_tickers || []).forEach(t => { const n = normalizeTicker(t); if (n) set.add(n); });
    (day.trades || []).forEach(t => { const n = normalizeTicker(t.symbol); if (n) set.add(n); });
    return Array.from(set);
}

function tradeTickerContextForPath(path, maxDays = 3) {
    const created = screenshotCreatedDate(path);
    const screenshotDate = created.date;
    const reliableDate = created.source !== 'assigned journal date fallback';
    const byDate = [];
    const all = new Set();
    if (!reliableDate) {
        return {
            screenshotDate,
            dateSource: created.source,
            dateRaw: created.raw,
            reliableDate,
            disabledReason: 'No real screenshot creation date is stored for this image, so Trades matching is disabled to avoid matching old screenshots with new trades.',
            tickers: [],
            byDate,
        };
    }
    for (let offset = -maxDays; offset <= maxDays; offset++) {
        const dateStr = addDays(screenshotDate, offset);
        if (!dateStr) continue;
        const tickers = tickersForDay(dateStr);
        if (!tickers.length) continue;
        byDate.push({ date: dateStr, offset, tickers });
        tickers.forEach(ticker => all.add(ticker));
    }
    return {
        screenshotDate,
        dateSource: created.source,
        dateRaw: created.raw,
        reliableDate,
        disabledReason: '',
        tickers: Array.from(all),
        byDate,
    };
}

function tradeTickersForPath(path) {
    return tradeTickerContextForPath(path).tickers;
}

function taggedTickersForPath(path) {
    return uniqueTickers(state.appData?.screenTags?.[path] || []);
}

function tickerFromScreenshotPath(path, tradedTickers = []) {
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    if (!traded.length) return '';
    const fileName = String(path || '').split(/[\\/]/).pop() || '';
    const tokens = fileName
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .map(normalizeOCRTicker)
        .filter(Boolean);
    const exact = traded.filter(ticker => tokens.includes(ticker));
    return exact.length === 1 ? exact[0] : '';
}

function confidentTickerFromContext(path, tradedTickers = []) {
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    if (traded.length === 1) return traded[0];
    return tickerFromScreenshotPath(path, traded);
}

function addCandidate(scores, ticker, points, opts = {}) {
    if (!validTickerWord(ticker, opts)) return;
    scores[ticker] = (scores[ticker] || 0) + points;
}

function exchangeHeaderTickers(rawText) {
    const text = String(rawText || '').toUpperCase();
    const out = new Set();
    const primaryHeaderPattern = /^\s*([A-Z0-9@$!|]{2,6})\s+(?:\d+\s+)?(?:D|DAY|M|MIN|H|HR|W|WK)\b[^\n\r]{0,80}\[\s*(?:NASDAQ|NYSE|AMEX|ARCA|OTC)\s*\]/gm;
    let match = null;
    while ((match = primaryHeaderPattern.exec(text))) {
        const ticker = normalizeOCRTicker(match[1]);
        if (validTickerWord(ticker)) out.add(ticker);
    }
    const exchangePattern = /\b([A-Z0-9@$!|]{2,6})\s+(?:[0-9]+\s*)?(?:D|DAY|M|MIN)?\s*(?:\d+\s*)?(?:M|MIN)?\s*\[\s*(?:NASDAQ|NYSE|AMEX|ARCA|OTC)\s*\]/g;
    while ((match = exchangePattern.exec(text))) {
        const ticker = normalizeOCRTicker(match[1]);
        if (validTickerWord(ticker)) out.add(ticker);
    }
    const compactPattern = /\b([A-Z0-9@$!|]{2,6})\b(?=[^\n]{0,20}\[\s*(?:NASDAQ|NYSE|AMEX|ARCA|OTC)\s*\])/g;
    while ((match = compactPattern.exec(text))) {
        const ticker = normalizeOCRTicker(match[1]);
        if (validTickerWord(ticker)) out.add(ticker);
    }
    return Array.from(out);
}

function primaryHeaderTickers(rawText) {
    const text = String(rawText || '').toUpperCase();
    const out = new Set();
    const patterns = [
        /^\s*([A-Z0-9@$!|]{2,6})\s+(?:\d+\s+)?(?:D|DAY|M|MIN|H|HR|W|WK)\b/gm,
        /^\s*([A-Z0-9@$!|]{2,6})\s+\d+\s+(?:D|DAY|M|MIN)\s+\d+\s*(?:M|MIN)?\b/gm,
    ];
    for (const pattern of patterns) {
        let match = null;
        while ((match = pattern.exec(text))) {
            const ticker = normalizeOCRTicker(match[1]);
            if (validTickerWord(ticker)) out.add(ticker);
        }
    }
    return Array.from(out);
}

function leadingTickerWords(rawText) {
    return String(rawText || '')
        .toUpperCase()
        .split(/[\n\r]+/)
        .slice(0, 2)
        .flatMap(line => line.trim().split(/\s+/).slice(0, 2))
        .map(normalizeOCRTicker)
        .filter(w => validTickerWord(w));
}

function scoreTickerCandidates(rawText, tradedTickers = [], ocrWords = [], zoneWeight = 1) {
    const clean = String(rawText || '').toUpperCase().replace(/[^A-Z0-9@$!|\s.-]/g, ' ');
    const words = clean.split(/\s+/).map(normalizeOCRTicker).filter(w => validTickerWord(w));
    const wordVariants = Array.from(new Set(words.flatMap(ocrConfusionVariants)));
    const exchangeTickers = exchangeHeaderTickers(rawText);
    const primaryTickers = primaryHeaderTickers(rawText);
    const leadingTickers = leadingTickerWords(rawText);
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    const highConfidence = (ocrWords || [])
        .map(w => ({ text: normalizeOCRTicker(w.text), confidence: Number(w.confidence) || 0 }))
        .filter(w => validTickerWord(w.text, { allowSingle: traded.includes(w.text), trusted: traded.includes(w.text) }));

    const scores = {};

    for (const w of words) addCandidate(scores, w, 18 * zoneWeight);
    for (const w of wordVariants) addCandidate(scores, w, 10 * zoneWeight);
    for (const w of primaryTickers) addCandidate(scores, w, 360 * zoneWeight);
    for (const w of exchangeTickers) addCandidate(scores, w, 260 * zoneWeight);
    for (const w of leadingTickers) addCandidate(scores, w, 55 * zoneWeight);
    for (const w of highConfidence) addCandidate(scores, w.text, Math.max(12, w.confidence / 2) * zoneWeight);

    Object.keys(scores).forEach(ticker => {
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
    const sorted = Object.entries(scores)
        .filter(([ticker]) => validTickerWord(ticker, { trusted: traded.includes(ticker) }))
        .sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return '???';

    if (traded.length) {
        const topOcr = sorted.slice(0, OCR_TOP_CANDIDATES_LIMIT);
        const matchedTop = topOcr.find(([ticker]) => traded.includes(ticker));
        if (matchedTop) return matchedTop[0];
    }

    const [best, bestScore] = sorted[0];
    const secondScore = sorted[1]?.[1] || 0;
    if (bestScore >= MIN_FREE_OCR_SCORE || (secondScore > 0 && bestScore >= 45 && bestScore >= secondScore * 1.6)) return best;
    return '???';
}

function topTickerRows(scores, tradedTickers = [], limit = 8) {
    const traded = new Set(tradedTickers.map(normalizeTicker).filter(Boolean));
    return Object.entries(scores)
        .filter(([ticker]) => validTickerWord(ticker, { trusted: traded.has(ticker) }))
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([ticker, score], index) => ({
            rank: index + 1,
            ticker,
            score: Math.round(score),
            inTrades: traded.has(ticker) ? 'yes' : 'no',
        }));
}

function logTickerCandidates(label, scores, tradedTickers = [], limit = 8) {
    const rows = topTickerRows(scores, tradedTickers, limit);
    if (!rows.length) {
        console.log(`[OCR] ${label}: candidates not found`);
        return;
    }
    console.log(`[OCR] ${label}: possible ticker candidates`);
    console.table(rows);
}

function tickerConfidence(scores, ticker, tradedTickers = []) {
    if (!ticker || ticker === '???') return { ok: false, score: 0, secondScore: 0, matchedTrades: false };
    const traded = tradedTickers.map(normalizeTicker).filter(Boolean);
    const sorted = Object.entries(scores)
        .filter(([candidate]) => validTickerWord(candidate, { trusted: traded.includes(candidate) }))
        .sort((a, b) => b[1] - a[1]);
    const score = Math.round(scores[ticker] || 0);
    const secondScore = Math.round(sorted.find(([candidate]) => candidate !== ticker)?.[1] || 0);
    const matchedTrades = traded.includes(ticker);
    const topOcr = sorted.slice(0, OCR_TOP_CANDIDATES_LIMIT).map(([candidate]) => candidate);
    const ok = traded.length
        ? topOcr.includes(ticker) && matchedTrades
        : score >= MIN_FREE_OCR_SCORE && (secondScore === 0 || score >= secondScore * 1.6);
    return { ok, score, secondScore, matchedTrades };
}

function quickPhaseDecision(scores, tradedTickers = [], phase = 1) {
    const top = topTickerRows(scores, tradedTickers, OCR_TOP_CANDIDATES_LIMIT);
    if (!top.length) {
        return { stop: false, ticker: '???', reason: 'no ticker candidates yet', top };
    }

    const tradeMatch = top.find(row => row.inTrades === 'yes');
    if (tradeMatch) {
        return {
            stop: true,
            ticker: tradeMatch.ticker,
            reason: `OCR top-${OCR_TOP_CANDIDATES_LIMIT} matched Trades`,
            top,
        };
    }

    const best = top[0];
    const secondScore = top[1]?.score || 0;
    const scoreGate = phase === 1 ? 120 : 70;
    const leadGate = phase === 1 ? 1.35 : 1.18;
    const hasStrongLead = secondScore === 0 || best.score >= secondScore * leadGate;
    if (best.score >= scoreGate && hasStrongLead) {
        return {
            stop: true,
            ticker: best.ticker,
            reason: `strong OCR candidate after phase ${phase}`,
            top,
        };
    }

    if (phase >= 2 && best.score >= 45) {
        return {
            stop: true,
            ticker: best.ticker,
            reason: 'usable early OCR candidate; skipped slow full-screen sweep',
            top,
        };
    }

    return { stop: false, ticker: best.ticker, reason: 'candidate still weak; continue scanning', top };
}

function ocrVariantPlan(zone) {
    const isGridZone = String(zone.label || '').startsWith('grid-');
    if (zone.phase === 1) return { scale: 5, variants: ['base', 'dark', 'light'] };
    if (zone.phase === 2) return { scale: 4, variants: ['base', 'dark'] };
    if (isGridZone) return { scale: 3, variants: ['base'] };
    return { scale: 3, variants: ['base', 'dark'] };
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
    const clampZone = (x, y, w, h, label = 'auto', phase = 2, baseWeight = 1) => {
        if (iw < MIN_OCR_ZONE_WIDTH || ih < MIN_OCR_ZONE_HEIGHT) return null;
        const left = Math.min(Math.max(0, iw - MIN_OCR_ZONE_WIDTH), Math.max(0, Math.round(x)));
        const top = Math.min(Math.max(0, ih - MIN_OCR_ZONE_HEIGHT), Math.max(0, Math.round(y)));
        const availableW = Math.max(0, iw - left);
        const availableH = Math.max(0, ih - top);
        const width = Math.min(availableW, Math.max(MIN_OCR_ZONE_WIDTH, Math.round(w)));
        const height = Math.min(availableH, Math.max(MIN_OCR_ZONE_HEIGHT, Math.round(h)));
        if (width < MIN_OCR_ZONE_WIDTH || height < MIN_OCR_ZONE_HEIGHT) return null;
        return {
            x: left,
            y: top,
            w: width,
            h: height,
            label,
            phase,
            baseWeight,
        };
    };

    const zones = [];
    const custom = state.appData?.settings?.ocrRect;
    if (custom && custom.width >= MIN_OCR_ZONE_WIDTH && custom.height >= MIN_OCR_ZONE_HEIGHT) {
        zones.push(clampZone(custom.left, custom.top, custom.width, custom.height, 'saved', 1, 1.55));
        zones.push(clampZone(custom.left - custom.width * 0.12, custom.top - custom.height * 0.25, custom.width * 1.25, custom.height * 1.45, 'saved-expanded', 1, 1.35));
    }

    const cornerW = iw * 0.34;
    const cornerH = ih * 0.16;
    const stripH = ih * 0.16;
    const sideW = iw * 0.28;

    zones.push(
        // Platform headers and chart-title areas.
        clampZone(0, 0, iw * 0.28, ih * 0.09, 'top-left-tight', 1, 1.55),
        clampZone(0, 0, iw * 0.42, ih * 0.14, 'top-left-wide', 1, 1.45),
        clampZone(0, 0, iw, ih * 0.16, 'top-strip', 1, 1.2),
        clampZone(iw * 0.18, 0, iw * 0.42, ih * 0.12, 'top-center', 1, 1.25),
        clampZone(0, ih * 0.05, iw * 0.5, ih * 0.16, 'upper-left', 1, 1.25),
        clampZone(0, 0, iw, ih * 0.28, 'upper-band', 2, 1.05),

        // Corners and bottom strips catch moved/floating chart headers.
        clampZone(iw - cornerW, 0, cornerW, cornerH, 'top-right', 2, 1.0),
        clampZone(0, ih - cornerH, cornerW, cornerH, 'bottom-left', 2, 0.95),
        clampZone(iw - cornerW, ih - cornerH, cornerW, cornerH, 'bottom-right', 2, 0.95),
        clampZone(0, ih - stripH, iw, stripH, 'bottom-strip', 2, 0.9),

        // Side panels where watchlist/order widgets often show the active symbol.
        clampZone(0, 0, sideW, ih, 'left-panel', 2, 0.85),
        clampZone(iw - sideW, 0, sideW, ih, 'right-panel', 2, 0.85),
        clampZone(iw * 0.34, 0, iw * 0.32, ih * 0.18, 'center-top', 2, 0.95),
        clampZone(iw * 0.25, ih * 0.18, iw * 0.5, ih * 0.18, 'chart-upper-center', 2, 0.8),
        clampZone(iw * 0.25, ih * 0.42, iw * 0.5, ih * 0.18, 'chart-center', 3, 0.65),
        clampZone(iw * 0.25, ih * 0.68, iw * 0.5, ih * 0.18, 'chart-lower-center', 3, 0.65),
    );

    // Coarse full-screen sweep. These are lower priority, but remove the need
    // for a manually selected OCR zone when the ticker is in an unusual place.
    const gridCols = 3;
    const gridRows = 3;
    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            zones.push(clampZone(
                iw * col / gridCols,
                ih * row / gridRows,
                iw / gridCols,
                ih / gridRows,
                `grid-${row}-${col}`,
                3,
                0.55,
            ));
        }
    }

    const seen = new Set();
    return zones.filter(zone => {
        if (!zone) return false;
        const key = `${Math.round(zone.x / 8)}:${Math.round(zone.y / 8)}:${Math.round(zone.w / 8)}:${Math.round(zone.h / 8)}`;
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

function makeOCRVariants(imgObj, zone, scale = 4, names = null) {
    const base = makeScaledCanvas(imgObj, zone, scale);
    if (base.width < MIN_OCR_CANVAS_WIDTH || base.height < MIN_OCR_CANVAS_HEIGHT) return [];
    const makeVariant = (name) => {
        if (name === 'base') return base;
        if (name === 'dark') return applyContrast(cloneCanvas(base), { threshold: 115 });
        if (name === 'light') return applyContrast(cloneCanvas(base), { threshold: 145 });
        if (name === 'invert') return applyContrast(cloneCanvas(base), { threshold: 135, invert: true });
        return null;
    };
    if (Array.isArray(names) && names.length) {
        return names.map(makeVariant).filter(Boolean);
    }
    return [
        makeVariant('base'),
        makeVariant('dark'),
        makeVariant('light'),
        makeVariant('invert'),
    ];
}

export async function runOCR(encodedPath, force = false) {
    const safePath = decodeURIComponent(encodedPath);
    const screenshotDate = findScreenshotDate(safePath);
    console.groupCollapsed(`[OCR ticker] ${safePath}`);
    console.log('[OCR] start', { path: safePath, date: screenshotDate, force });
    const finishOCRLog = (result) => {
        console.groupEnd();
        return result;
    };
    const existing = state.appData.tickers[safePath];
    console.log('[OCR] saved ticker before scan:', existing || '(empty)');
    if (!force && existing && existing !== '???' && normalizeTicker(existing) && !TICKER_GARBAGE.has(normalizeTicker(existing))) {
        console.log('[OCR] skipped: valid saved ticker is already present:', existing);
        updateBadgeUI(encodedPath, false);
        return finishOCRLog();
    }
    const tradeContext = tradeTickerContextForPath(safePath, 3);
    const traded = tradeContext.tickers;
    console.log('[OCR] screenshot date:', {
        date: tradeContext.screenshotDate,
        source: tradeContext.dateSource,
        raw: tradeContext.dateRaw,
        reliable: tradeContext.reliableDate,
    });
    if (tradeContext.reliableDate) {
        console.log('[OCR] tickers from Trades window (-3..+3 days):', traded.length ? traded : '(none)');
        console.table(tradeContext.byDate.map(row => ({
            date: row.date,
            offset: row.offset,
            tickers: row.tickers.join(', '),
        })));
    } else {
        console.warn('[OCR] Trades matching disabled:', tradeContext.disabledReason);
    }
    const tagged = taggedTickersForPath(safePath);
    console.log('[OCR] manual screen tags:', tagged.length ? tagged : '(none)');
    const trustedTags = tagged.filter(ticker => !traded.length || traded.includes(ticker));
    if (trustedTags.length === 1) {
        console.log('[OCR] resolved from manual tag:', trustedTags[0]);
        state.appData.tickers[safePath] = trustedTags[0];
        saveToLocal();
        updateBadgeUI(encodedPath, false);
        return finishOCRLog(trustedTags[0]);
    }
    const contextTicker = confidentTickerFromContext(safePath, traded);
    if (contextTicker && (force || !existing || existing === '???' || TICKER_GARBAGE.has(normalizeTicker(existing)))) {
        console.log('[OCR] context match without image OCR:', {
            ticker: contextTicker,
            reason: traded.length === 1 ? 'only one ticker in Trades for this day' : 'ticker found in screenshot filename',
        });
        state.appData.tickers[safePath] = contextTicker;
        saveToLocal();
        updateBadgeUI(encodedPath, false);
        return finishOCRLog(contextTicker);
    }
    try {
        console.log('[OCR] loading Tesseract...');
        await ensureTesseract();
        console.log('[OCR] Tesseract ready');
    } catch (error) {
        console.warn('[OCR] Tesseract lazy-load failed:', error);
        return finishOCRLog();
    }
    if (!force && existing && existing !== '???' && normalizeTicker(existing) && !TICKER_GARBAGE.has(normalizeTicker(existing))) {
        console.log('[OCR] skipped after Tesseract load: valid saved ticker is already present:', existing);
        updateBadgeUI(encodedPath, false);
        return finishOCRLog();
    }

    try {
        updateBadgeUI(encodedPath, true);
        const src = await getStorageUrl(safePath);
        console.log('[OCR] image URL resolved:', src ? 'ok' : 'empty');

        const imgObj = new Image();
        imgObj.crossOrigin = 'Anonymous';
        await new Promise((resolve, reject) => { imgObj.onload = resolve; imgObj.onerror = reject; imgObj.src = src; });

        const iw = imgObj.naturalWidth;
        const ih = imgObj.naturalHeight;

        const zones = buildAutoOCRZones(iw, ih);
        console.log('[OCR] image loaded:', { width: iw, height: ih });
        console.log('[OCR] zones to scan:', zones.map((z, i) => ({
            index: i + 1,
            label: z.label,
            x: z.x,
            y: z.y,
            w: z.w,
            h: z.h,
            phase: z.phase,
            weight: z.baseWeight,
        })));

        const totalScores = {};
        let ticker = '???';
        let scannedZones = 0;
        const phaseNames = {
            1: 'fast header/title scan',
            2: 'expanded panels/corners scan',
            3: 'full-screen fallback sweep',
        };

        for (const phase of [1, 2, 3]) {
            const phaseZones = zones.filter(zone => zone.phase === phase);
            if (!phaseZones.length) continue;
            console.groupCollapsed(`[OCR] phase ${phase}: ${phaseNames[phase]} (${phaseZones.length} zones)`);

            for (const zone of phaseZones) {
                scannedZones++;
                const plan = ocrVariantPlan(zone);
                const zoneWeight = Number((zone.baseWeight || 1).toFixed(2));
                const variants = makeOCRVariants(imgObj, zone, plan.scale, plan.variants);
                if (!variants.length) continue;

                const zoneScores = {};
                const textSnippets = [];
                for (const canvas of variants) {
                    const { data } = await Tesseract.recognize(canvas, 'eng', {
                        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@$!| ',
                        tessedit_pageseg_mode: zone.h < ih * 0.12 ? '7' : '6',
                        preserve_interword_spaces: '1',
                    });

                    const rawText = String(data.text || '').replace(/\s+/g, ' ').trim();
                    if (rawText) textSnippets.push(rawText.slice(0, OCR_MAX_RAW_TEXT_LOG));
                    mergeScores(zoneScores, scoreTickerCandidates(data.text || '', traded, data.words || [], zoneWeight));
                }

                mergeScores(totalScores, zoneScores);
                if (Object.keys(zoneScores).length) {
                    console.log(`[OCR] zone "${zone.label}"`, {
                        phase,
                        weight: zoneWeight,
                        variants: variants.length,
                        text: textSnippets.slice(0, 2),
                    });
                    logTickerCandidates(`zone "${zone.label}"`, zoneScores, traded, 5);
                } else {
                    console.log(`[OCR] zone "${zone.label}": no usable ticker-like words`);
                }

                ticker = bestTickerFromScores(totalScores, traded);
                const confidence = tickerConfidence(totalScores, ticker, traded);
                if (confidence.ok) {
                    console.log('[OCR] early stop: confident ticker found', { ticker, ...confidence });
                    break;
                }
            }

            console.log(`[OCR] phase ${phase} summary after ${scannedZones} scanned zones`);
            logTickerCandidates(`phase ${phase} cumulative`, totalScores, traded, 8);
            console.groupEnd();

            const quickDecision = quickPhaseDecision(totalScores, traded, phase);
            console.log('[OCR] phase stop check:', {
                phase,
                stop: quickDecision.stop,
                selected: quickDecision.ticker,
                reason: quickDecision.reason,
                top3: quickDecision.top,
            });
            if (quickDecision.stop) {
                ticker = quickDecision.ticker;
                break;
            }

            const confidence = tickerConfidence(totalScores, ticker, traded);
            if (confidence.ok) break;
        }

        if (ticker === '???') ticker = bestTickerFromScores(totalScores, traded);

        logTickerCandidates('final', totalScores, traded, 10);
        const finalTop3 = topTickerRows(totalScores, traded, OCR_TOP_CANDIDATES_LIMIT);
        const matchedTop3 = finalTop3.find(row => row.inTrades === 'yes') || null;
        console.log('[OCR] final top-3 OCR candidates checked against Trades:', {
            top3: finalTop3,
            firstTop3TradeMatch: matchedTop3?.ticker || '(none)',
        });
        if (ticker === '???') {
            console.log('[OCR] final result: ???', {
                reason: traded.length
                    ? 'no OCR top-3 candidate matched Trades and OCR was not confident enough alone'
                    : 'no confident OCR candidate found; import Trades first for stronger validation',
            });
        } else {
            console.log('[OCR] final result:', {
                ticker,
                score: Math.round(totalScores[ticker] || 0),
                matchedTrades: traded.includes(ticker),
                selectionRule: traded.includes(ticker)
                    ? 'selected because it was inside OCR top-3 and exists in Trades'
                    : 'selected by OCR score; no OCR top-3 candidate matched Trades',
            });
        }

        state.appData.tickers[safePath] = ticker;
        saveToLocal();
        updateBadgeUI(encodedPath, false);
        return finishOCRLog(ticker);
    } catch (e) {
        console.error('Помилка OCR:', e);
        state.appData.tickers[safePath] = '???';
        updateBadgeUI(encodedPath, false);
        return finishOCRLog('???');
    }
}
