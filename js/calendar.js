// === js/calendar.js ===
import { state } from './state.js';
import { saveToLocal, loadMonth, loadDayDetails } from './storage.js';
import { showPrompt } from './utils.js';

let _selectDateRequestId = 0;

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

function excerptTooltip(text, maxLen) {
    const t = String(text ?? '').trim().replace(/\s+/g, ' ');
    if (!t) return '';
    return t.length <= maxLen ? t : t.slice(0, maxLen) + '…';
}

export function getDaylossForMonth(year, monthIndex) {
    let key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const monthly = state.appData?.settings?.monthlyDayloss ?? {};
    const def = state.appData?.settings?.defaultDayloss ?? -100;
    return monthly[key] !== undefined ? monthly[key] : def;
}

export async function updateAutoFlags() {
    // Не завантажуємо всі місяці — рахуємо рекорди тільки з вже завантажених даних

    let maxPnL = 0;
    let records = new Set();
    let absoluteRecord = null;
    
    let sortedDates = Object.keys(state.appData.journal)
        .filter(d => d.match(/^\d{4}-\d{2}-\d{2}$/) && state.appData.journal[d].pnl !== null && state.appData.journal[d].pnl !== undefined && state.appData.journal[d].pnl !== "")
        .sort((a, b) => new Date(a) - new Date(b));
        
    for (let d of sortedDates) {
        let pnl = parseFloat(state.appData.journal[d].pnl);
        if (!isNaN(pnl) && pnl > 0) {
            if (pnl > maxPnL) {
                maxPnL = pnl;
                records.add(d);
                absoluteRecord = d; 
            }
        }
    }
    state.autoFlagsCache = { records, absoluteRecord };
}

export function getWinstreak() {
    let sortedDates = Object.keys(state.appData.journal)
        .filter(d => d.match(/^\d{4}-\d{2}-\d{2}$/) && state.appData.journal[d].pnl !== null && state.appData.journal[d].pnl !== "")
        .sort((a, b) => new Date(a) - new Date(b));

    let streak = 0;
    for (let d of sortedDates) {
        let pnl = parseFloat(state.appData.journal[d].pnl);
        let [y, m, day] = d.split('-');
        let dl = getDaylossForMonth(y, parseInt(m) - 1);
        let halfDl = dl / 2;

        if (pnl <= halfDl) streak = 0; 
        else if (pnl > 0) streak++; 
    }
    return streak;
}

/** Серія зелених днів лише в межах обраного місяця (торгові дні по порядку). */
export function getWinstreakForMonth(year, monthIndex) {
    const prefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}-`;
    let sortedDates = Object.keys(state.appData.journal)
        .filter(d =>
            d.startsWith(prefix) &&
            d.match(/^\d{4}-\d{2}-\d{2}$/) &&
            state.appData.journal[d].pnl !== null &&
            state.appData.journal[d].pnl !== ''
        )
        .sort((a, b) => new Date(a) - new Date(b));

    let streak = 0;
    for (let d of sortedDates) {
        let pnl = parseFloat(state.appData.journal[d].pnl);
        let [y, m] = d.split('-');
        let dl = getDaylossForMonth(y, parseInt(m, 10) - 1);
        let halfDl = dl / 2;
        if (pnl <= halfDl) streak = 0;
        else if (pnl > 0) streak++;
    }
    return streak;
}

function _dashSetBadge(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'stat-card-pro-badge ' + type;
}

/** Картки «Про» та останні угоди на дашборді — тільки для обраного в календарі місяця. */
export function updateDashboardWidgets(year, month) {
    const mk = `${year}-${String(month + 1).padStart(2, '0')}`;
    const prefix = `${mk}-`;
    const journal = state.appData?.journal || {};

    let totalPnl = 0, wins = 0, losses = 0, totalTrades = 0;
    let totalGross = 0, totalLoss = 0;

    for (const [dateKey, day] of Object.entries(journal)) {
        if (!day || !dateKey.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
        const pnl = parseFloat(day.pnl);
        if (!Number.isFinite(pnl) || pnl === 0) continue;
        totalPnl += pnl;
        totalTrades++;
        if (pnl > 0) {
            wins++;
            totalGross += pnl;
        } else {
            losses++;
            totalLoss += Math.abs(pnl);
        }
    }

    const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const pf = totalLoss > 0 ? totalGross / totalLoss : (totalGross > 0 ? 99 : 0);

    const pnlEl = document.getElementById('pro-total-pnl');
    const wrEl = document.getElementById('pro-winrate');
    const trEl = document.getElementById('pro-total-trades');
    const pfEl = document.getElementById('pro-pf');
    if (pnlEl) pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2);
    if (wrEl) wrEl.textContent = winrate.toFixed(1) + '%';
    if (trEl) trEl.textContent = String(totalTrades);
    if (pfEl) pfEl.textContent = pf.toFixed(2);
    if (pnlEl) pnlEl.style.color = totalPnl >= 0 ? 'var(--profit)' : 'var(--loss)';

    _dashSetBadge('badge-pnl', totalPnl >= 0 ? '+' + wins + ' прибуткових' : losses + ' збиткових', totalPnl >= 0 ? 'positive' : 'negative');
    _dashSetBadge('badge-winrate', wins + 'W / ' + losses + 'L', winrate >= 50 ? 'positive' : 'negative');
    _dashSetBadge('badge-trades', 'за ' + mk, 'neutral');
    _dashSetBadge('badge-pf', pf >= 1.5 ? '\u25B2 добре' : pf >= 1 ? '\u25B6 норма' : '\u25BC слабо', pf >= 1.5 ? 'positive' : pf >= 1 ? 'neutral' : 'negative');

    const list = document.getElementById('recent-trades-list');
    if (list) {
        const days = Object.entries(journal)
            .filter(([d, dd]) => dd && d.startsWith(prefix) && (parseFloat(dd.pnl) || 0) !== 0)
            .sort(([a], [b]) => b.localeCompare(a))
            .slice(0, 8);

        if (days.length === 0) {
            list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem;">Немає угод у цьому місяці</div>';
        } else {
            list.innerHTML = days.map(([date, day]) => {
                const pnl = parseFloat(day.pnl) || 0;
                const gross = parseFloat(day.gross_pnl ?? day.gross) || 0;
                const isPos = pnl >= 0;
                const pct = gross !== 0 ? ((pnl / Math.abs(gross)) * 100).toFixed(1) : '0.0';
                const dateObj = new Date(date + 'T00:00:00');
                const dateStr = dateObj.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
                const arrow = isPos
                    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>'
                    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
                const ticker = (day.ticker || day.type || '').toUpperCase() || 'TRADE';
                return `<div class="recent-trade-item" onclick="selectDate('${date}')">
                <div class="recent-trade-left">
                    <div class="recent-trade-dir-icon ${isPos ? 'long' : 'short'}">${arrow}</div>
                    <div>
                        <div class="recent-trade-symbol">${ticker || dateStr}</div>
                        <div class="recent-trade-meta">${ticker ? dateStr : ''} ${isPos ? 'Прибуток' : 'Збиток'}</div>
                    </div>
                </div>
                <div class="recent-trade-right">
                    <div class="recent-trade-pnl ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : ''}$${pnl.toFixed(2)}</div>
                    <div class="recent-trade-pct ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : ''}${pct}%</div>
                </div>
            </div>`;
            }).join('');
        }
    }
}

export function shiftDate(offset) {
    let parts = state.selectedDateStr.split('-');
    let d = new Date(parts[0], parts[1] - 1, parts[2]); 
    do {
        d.setDate(d.getDate() + offset);
    } while (d.getDay() === 0 || d.getDay() === 6); 
    
    let newYear = d.getFullYear();
    let newMonth = String(d.getMonth() + 1).padStart(2, '0');
    let newDay = String(d.getDate()).padStart(2, '0');
    let newDateStr = `${newYear}-${newMonth}-${newDay}`;
    
    document.getElementById('month-select').value = d.getMonth();
    document.getElementById('year-select').value = d.getFullYear();
    
    selectDate(newDateStr);
    renderView(); 
}

export function updateDisplayDate(dateStr) {
    let parts = dateStr.split('-');
    let dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    document.getElementById('display-date').innerText = dateObj.toLocaleDateString('uk-UA', options);
}

export function selectDateFromInput(dateStr) {
    let parts = dateStr.split('-');
    document.getElementById('month-select').value = parseInt(parts[1]) - 1; 
    document.getElementById('year-select').value = parseInt(parts[0]);
    selectDate(dateStr); 
    renderView();
}

function setDayDetailsLoading(isLoading) {
    state.dayDetailsLoading = isLoading;
    ['trade-pnl', 'trade-gross', 'trade-comm', 'trade-locates', 'trade-kf', 'trade-notes', 'session-goal', 'session-plan', 'session-readiness']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = isLoading;
        });
}

function fillSelectedDateUI(dateStr) {
    document.getElementById('trade-date').value = dateStr; 
    updateDisplayDate(dateStr);

    document.querySelectorAll('.day-cell').forEach(c => c.classList.remove('active-day'));
    const cell = document.getElementById(`cell-${dateStr}`); 
    if (cell) cell.classList.add('active-day');

    const dayData = state.appData.journal[dateStr] || {};
    document.getElementById('trade-pnl').value = dayData.pnl !== undefined && dayData.pnl !== null ? parseFloat(dayData.pnl).toFixed(2) : '';
    document.getElementById('trade-gross').value = dayData.gross_pnl !== undefined && dayData.gross_pnl !== null ? parseFloat(dayData.gross_pnl).toFixed(2) : '';
    document.getElementById('trade-comm').value = dayData.commissions !== undefined && dayData.commissions !== null ? parseFloat(dayData.commissions).toFixed(2) : '';
    document.getElementById('trade-locates').value = dayData.locates !== undefined && dayData.locates !== null ? parseFloat(dayData.locates).toFixed(2) : '';
    document.getElementById('trade-kf').value = dayData.kf !== undefined && dayData.kf !== null ? parseFloat(dayData.kf).toFixed(2) : '';
    document.getElementById('trade-notes').value = dayData.notes || '';
    document.getElementById('mentor-notes').value = dayData.mentor_comment || '';
    
    state.appData.errorTypes?.forEach((err, index) => { 
        const checkbox = document.getElementById(`err-${index}`); 
        if (checkbox) checkbox.checked = (dayData.errors || []).includes(err); 
    });
    
    // Викликаємо функції UI, якщо вони доступні
    if (window.renderChecklistDisplay) window.renderChecklistDisplay();
    if (window.renderSidebarSliders) window.renderSidebarSliders();
    if (window.renderAIAdviceUI) window.renderAIAdviceUI();
    if (window.renderAssignedScreens) window.renderAssignedScreens();
    
    let viewScreens = document.getElementById('view-screens');
    if (viewScreens && viewScreens.classList.contains('active') && window.loadImages) {
        window.loadImages();
    }

    if (window.loadPrivateNote) window.loadPrivateNote();

    // Якщо вкладка "Угоди" активна — оновлюємо пілюлі для нової дати
    const viewTrades = document.getElementById('view-trades');
    if (viewTrades && viewTrades.classList.contains('active')) {
        if (window.populateSymbolSelect) window.populateSymbolSelect(dateStr);
    }

    // Завантажуємо дані сесії
    const sessionGoal = document.getElementById('session-goal');
    const sessionPlan = document.getElementById('session-plan');
    const sessionReadiness = document.getElementById('session-readiness');
    const sessionReadinessVal = document.getElementById('session-readiness-val');
    const sessionAiResult = document.getElementById('session-ai-result');
    if (sessionGoal) sessionGoal.value = dayData.sessionGoal || '';
    if (sessionPlan) sessionPlan.value = dayData.sessionPlan || '';
    if (sessionReadiness) { sessionReadiness.value = dayData.sessionReadiness || 5; }
    if (sessionReadinessVal) sessionReadinessVal.textContent = (dayData.sessionReadiness || 5) + '/10';
    if (sessionAiResult) {
        if (dayData.sessionAiResult) {
            sessionAiResult.style.display = 'block';
            sessionAiResult.style.background = 'rgba(139,92,246,0.08)';
            sessionAiResult.style.border = '1px solid var(--accent)';
            sessionAiResult.textContent = '';
            dayData.sessionAiResult.split('\n').forEach((line, i, arr) => {
                sessionAiResult.appendChild(document.createTextNode(line));
                if (i < arr.length - 1) sessionAiResult.appendChild(document.createElement('br'));
            });
        } else {
            sessionAiResult.style.display = 'none';
            sessionAiResult.innerHTML = '';
        }
    }
    if (window.renderSessionPlaybook) window.renderSessionPlaybook();

    // Рендер типів трейдів (щоб saveEntry() міг зчитати .tt-input-pnl/.tt-input-kf)
    const ttContainer = document.getElementById('trade-types-container');
    if (ttContainer && state.appData?.tradeTypes) {
        const savedTT = dayData.tradeTypesData || {};
        let ttHtml = '';
        state.appData.tradeTypes.forEach(tt => {
            const pnl = savedTT[tt]?.pnl !== undefined ? savedTT[tt].pnl : '';
            const kf = savedTT[tt]?.kf !== undefined ? savedTT[tt].kf : '';
            const safeTT = sanitizeHTML(tt);
            const safePnl = sanitizeHTML(String(pnl));
            const safeKf = sanitizeHTML(String(kf));
            ttHtml += `
                <div style="display: flex; gap: 5px; align-items: center;">
                    <label style="flex: 1; margin:0;">${safeTT}</label>
                    <input type="number" step="0.01" class="tt-input-pnl" data-name="${safeTT}" placeholder="PnL $" value="${safePnl}" style="width: 70px; padding: 6px;">
                    <input type="number" step="0.01" class="tt-input-kf" data-name="${safeTT}" placeholder="КФ" value="${safeKf}" style="width: 60px; padding: 6px;">
                </div>`;
        });
        ttContainer.innerHTML = ttHtml;
    }
}

export async function selectDate(dateStr) {
    const requestId = ++_selectDateRequestId;
    state.selectedDateStr = dateStr;
    fillSelectedDateUI(dateStr);

    const dayData = state.appData.journal[dateStr];
    if (dayData?.__detailsLoaded) return;

    setDayDetailsLoading(true);
    try {
        await loadDayDetails(dateStr);
        if (requestId !== _selectDateRequestId || state.selectedDateStr !== dateStr) return;
        fillSelectedDateUI(dateStr);
    } finally {
        if (requestId === _selectDateRequestId && state.selectedDateStr === dateStr) {
            setDayDetailsLoading(false);
        }
    }
}

export function saveEntry() {
    if (!state.selectedDateStr) return; // Ніяких алертів, просто тихий вихід, якщо день не обрано
    if (state.dayDetailsLoading) return;
    
    // Збираємо типи трейдів
    let ttData = Object.create(null);
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    document.querySelectorAll('.tt-input-pnl').forEach(el => {
        let name = el.getAttribute('data-name');
        if (!name || FORBIDDEN_KEYS.has(name) || Object.prototype.hasOwnProperty.call(Object.prototype, name)) return;
        let pnlVal = el.value;
        let kfInput = document.querySelector(`.tt-input-kf[data-name="${CSS.escape(name)}"]`);
        let kfVal = kfInput ? kfInput.value : '';
        ttData[name] = { pnl: pnlVal, kf: kfVal };
    });

    let errors = [];
    document.querySelectorAll('.error-checkbox:checked').forEach(el => errors.push(el.value));
    
    let checklist = [];
    document.querySelectorAll('.checklist-checkbox:checked').forEach(el => checklist.push(el.value));
    
    // Жорсткий захист від порожніх ключів у повзунках
    const sliders = Object.create(null);
    document.querySelectorAll('.slider-input').forEach(el => {
        if (el.id) {
            const key = el.id.replace('slider-', '');
            if (key && !Object.prototype.hasOwnProperty.call(Object.prototype, key)) sliders[key] = el.value;
        }
    });

    let pnlVal = document.getElementById('trade-pnl').value;
    let kfValMain = document.getElementById('trade-kf').value;
    const grossValRaw = document.getElementById('trade-gross').value;
    const commValRaw = document.getElementById('trade-comm').value;
    const locValRaw = document.getElementById('trade-locates').value;

    // Формуємо об'єкт дня (захист від NaN)
    let dayData = {
        pnl: (pnlVal && !isNaN(pnlVal)) ? parseFloat(pnlVal) : null,
        gross_pnl: (grossValRaw && !isNaN(grossValRaw)) ? parseFloat(grossValRaw) : null,
        commissions: (commValRaw && !isNaN(commValRaw)) ? parseFloat(commValRaw) : null,
        locates: (locValRaw && !isNaN(locValRaw)) ? parseFloat(locValRaw) : null,
        kf: (kfValMain && !isNaN(kfValMain)) ? parseFloat(kfValMain) : null,
        notes: document.getElementById('trade-notes').value || "",
        errors: errors,
        checkedParams: checklist,
        sliders: sliders,
        tradeTypesData: ttData
    };

    let oldData = state.appData.journal[state.selectedDateStr] || {};
    dayData.screenshots = oldData.screenshots || { good: [], normal: [], bad: [], error: [] };
    if (oldData.mentor_comment) dayData.mentor_comment = oldData.mentor_comment;
    if (oldData.tickers) dayData.tickers = oldData.tickers;
    // Не перетираємо дані, які користувач не редагує в цьому екрані,
    // але вони потрібні для UI (tickers/ai_advice) та обчислень.
    if (oldData.traded_tickers !== undefined) dayData.traded_tickers = oldData.traded_tickers;
    if (oldData.fondexx !== undefined) dayData.fondexx = oldData.fondexx;
    if (oldData.ppro !== undefined) dayData.ppro = oldData.ppro;
    if (oldData.ai_advice !== undefined) dayData.ai_advice = oldData.ai_advice;
    if (oldData.sessionGoal !== undefined) dayData.sessionGoal = oldData.sessionGoal;
    if (oldData.sessionPlan !== undefined) dayData.sessionPlan = oldData.sessionPlan;
    if (oldData.sessionReadiness !== undefined) dayData.sessionReadiness = oldData.sessionReadiness;
    if (oldData.sessionSetups !== undefined) dayData.sessionSetups = oldData.sessionSetups;
    if (oldData.sessionAiResult !== undefined) dayData.sessionAiResult = oldData.sessionAiResult;
    if (oldData.trades !== undefined) dayData.trades = oldData.trades;
    if (oldData.sessionDone !== undefined) dayData.sessionDone = oldData.sessionDone;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.selectedDateStr) || Object.prototype.hasOwnProperty.call(Object.prototype, state.selectedDateStr)) return;
    dayData.__detailsLoaded = true;
    state.appData.journal[state.selectedDateStr] = dayData;
    
    // Тихе збереження
    import('./storage.js').then(module => {
        module.saveToLocal().then(() => {
            if (window.updateAutoFlags) {
                window.updateAutoFlags().then(() => { if (window.renderView) window.renderView(); });
            } else if (window.renderView) {
                window.renderView();
            }
            if (window.refreshStatsView) window.refreshStatsView();
            if (window.innerWidth <= 1024 && window.toggleMobileSidebar) window.toggleMobileSidebar(false);
        }).catch(err => console.error("Помилка фонового збереження:", err));
    });
}

// Допоміжні функції для календаря
export function getMonday(d) { 
    d = new Date(d); 
    var day = d.getDay(), diff = d.getDate() - day + (day == 0 ? -6 : 1); 
    return new Date(d.setDate(diff)).toISOString().split('T')[0]; 
}

function getMondayKeyFromDateKey(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return getMonday(new Date(y, m - 1, d));
}

function sumWeekTradingStats(mondayIso) {
    const [y, m, d] = mondayIso.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    let sumPnl = 0, sumComm = 0, sumLoc = 0, nPnl = 0;
    for (let i = 0; i < 5; i++) {
        const dt = new Date(start);
        dt.setDate(start.getDate() + i);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        const j = state.appData.journal[key];
        if (!j) continue;
        if (j.pnl !== null && j.pnl !== '' && !isNaN(parseFloat(j.pnl))) {
            sumPnl += parseFloat(j.pnl);
            sumComm += parseFloat(j.commissions) || 0;
            sumLoc += parseFloat(j.locates) || 0;
            nPnl++;
        }
    }
    return { sumPnl, sumComm, sumLoc, nPnl };
}

function formatLongDateUk(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function appendWeekSummaryForDate(dateKey) {
    const mon = getMondayKeyFromDateKey(dateKey);
    const wNote = (state.appData.weeklyComments[mon] || '').trim();
    const { sumPnl, nPnl } = sumWeekTradingStats(mon);
    let b = `\n\n— Тиждень з ${mon}`;
    b += wNote ? `\n${excerptTooltip(wNote, 200)}` : `\nБез підсумку тижня (клік по мітці «W»).`;
    b += `\nΣ PnL: ${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}$ · ${nPnl} дн. з PnL`;
    return b;
}

function buildWeekHoverText(wkKey) {
    const wNote = (state.appData.weeklyComments[wkKey] || '').trim();
    const { sumPnl, nPnl } = sumWeekTradingStats(wkKey);
    let s = `Тиждень ${wkKey}\n`;
    s += wNote ? `${excerptTooltip(wNote, 320)}\n` : `Клік — додати короткий підсумок тижня.\n`;
    s += `Σ PnL: ${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}$ (${nPnl} дн.)`;
    return s.trim();
}

function buildDayDetailBody(dateKey, data, currentMonthDayloss) {
    const lines = [];
    if (data.pnl !== null && data.pnl !== undefined && data.pnl !== '') {
        const rp = parseFloat(data.pnl);
        lines.push(`PnL: ${rp >= 0 ? '+' : ''}${rp.toFixed(2)}$`);
    }
    if (data.pnl !== null && data.pnl !== '' && !isNaN(parseFloat(data.pnl)) && parseFloat(data.pnl) <= currentMonthDayloss) {
        lines.push('Увага: день на рівні денного ліміту.');
    }

    const note = data.notes && String(data.notes).trim();
    if (note) lines.push(`Думка: ${excerptTooltip(note, 240)}`);

    const hasErrors = data.errors && data.errors.length > 0;
    if (hasErrors) {
        const list = data.errors.length <= 4
            ? data.errors.join(', ')
            : `${data.errors.slice(0, 3).join(', ')} +${data.errors.length - 3}`;
        lines.push(`Помилки: ${list}`);
    }

    if (hasErrors && note) {
        lines.push(`Що змінити: зв'яжіть помилку з правилом з плейбуку й однією конкретною дією на наступну сесію.`);
    } else if (hasErrors) {
        lines.push(`Що змінити: коротко опишіть думку дня — так легше не повторити ті самі помилки.`);
    } else if (note) {
        lines.push(`Що покращити: додайте умову входу/виходу або тригер, де стиль просідає.`);
    } else if (!hasErrors && (!data.pnl || data.pnl === '')) {
        lines.push('Заповніть думку або PnL у формі дня — тултіп стане кориснішим.');
    }

    return lines.join('\n').trim();
}

function positionCalendarTooltip(e, el) {
    if (!el || !e) return;
    const pad = 14;
    const estW = 360;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const maxX = window.innerWidth - Math.min(estW, window.innerWidth - 16) - 8;
    const maxY = window.innerHeight - 80;
    x = Math.max(8, Math.min(x, maxX));
    y = Math.max(8, Math.min(y, maxY));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
}

export function createWeekLabel(wkKey) {
    let w = document.createElement('div'); 
    let hasComment = state.appData.weeklyComments[wkKey] && state.appData.weeklyComments[wkKey].trim() !== '';
    let tooltip = document.getElementById('tooltip');
    
    w.className = 'week-label' + (hasComment ? ' has-comment' : '');
    w.innerHTML = '<span class="week-label-glyph" aria-hidden="true">W</span>';
    w.onmouseenter = (e) => {
        if (!tooltip) return;
        tooltip.innerText = buildWeekHoverText(wkKey);
        tooltip.style.display = 'block';
        positionCalendarTooltip(e, tooltip);
    };
    w.onmousemove = (e) => { if (tooltip) positionCalendarTooltip(e, tooltip); };
    w.onmouseleave = () => { if (tooltip) tooltip.style.display = 'none'; };
    w.onclick = () => { showPrompt(`Підсумок за тиждень (${wkKey}):`, state.appData.weeklyComments[wkKey] || "").then(c => { if (c !== null && /^\d{4}-\d{2}-\d{2}$/.test(wkKey) && !Object.prototype.hasOwnProperty.call(Object.prototype, wkKey)) { state.appData.weeklyComments[wkKey] = c; saveToLocal(); renderView(); } }); };
    return w;
}

export async function renderView() {
    let yearInput = document.getElementById('year-select');
    let monthInput = document.getElementById('month-select');
    
    // БРОНЕБІЙНИЙ ЗАХИСТ: Якщо інпутів немає або вони порожні - беремо поточний рік і місяць
    let year = yearInput && yearInput.value ? parseInt(yearInput.value) : state.todayObj.getFullYear(); 
    let month = monthInput && monthInput.value ? parseInt(monthInput.value) : state.todayObj.getMonth();
    
    if (isNaN(year)) year = state.todayObj.getFullYear();
    if (isNaN(month)) month = state.todayObj.getMonth();

    // Підвантажуємо місяць якщо ще не завантажений
    const mk = `${year}-${String(month + 1).padStart(2, '0')}`;
    if (state.CURRENT_VIEWED_USER) await loadMonth(state.CURRENT_VIEWED_USER, mk);

    const grid = document.getElementById('calendar-grid');
    if (!grid) return; // Якщо таблиці взагалі немає в HTML - виходимо
    
    const tooltip = document.getElementById('tooltip');
    
    grid.innerHTML = `<div class="day-header"></div><div class="day-header">Пн</div><div class="day-header">Вв</div><div class="day-header">Ср</div><div class="day-header">Чт</div><div class="day-header">Пт</div>`;
    grid.classList.add('stretch-rows');
    
    const firstDayIndex = new Date(year, month, 1).getDay(); 
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let startPadding = (firstDayIndex === 0 || firstDayIndex === 6) ? 0 : firstDayIndex - 1;
    
    if (startPadding > 0) { 
        grid.appendChild(createWeekLabel(getMonday(new Date(year, month, 1)))); 
        for (let i=0; i<startPadding; i++) { 
            let e = document.createElement('div'); e.className='day-cell empty'; grid.appendChild(e); 
        } 
    }

    let totalPnl = 0, totalComm = 0, totalLocates = 0;
    let currentMonthDayloss = getDaylossForMonth(year, month);
    
    let settingsInput = document.getElementById('setting-dayloss-limit');
    if (settingsInput) settingsInput.value = currentMonthDayloss;
    
    let settingsLabel = document.getElementById('settings-current-month-label');
    if (settingsLabel) {
        let monthsNames = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
        settingsLabel.innerText = `${monthsNames[month]} ${year}`;
    }

    let currentStreak = getWinstreakForMonth(year, month);
    let streakEl = document.getElementById('winstreak-counter');
    if (streakEl) {
        if (currentStreak > 0) {
            streakEl.style.display = 'flex';
            document.getElementById('winstreak-val').innerText = currentStreak;
            streakEl.classList.toggle('hot-glow', currentStreak >= 5);
        } else {
            streakEl.style.display = 'none';
            streakEl.classList.remove('hot-glow');
        }
    }
    
    for (let i = 1; i <= daysInMonth; i++) {
        let d = new Date(year, month, i); if (d.getDay() === 0 || d.getDay() === 6) continue;
        if (d.getDay() === 1) grid.appendChild(createWeekLabel(getMonday(d)));
        
        let dateKey = `${year}-${(month+1).toString().padStart(2, '0')}-${i.toString().padStart(2, '0')}`;
        let cell = document.createElement('div'); cell.className = 'day-cell'; cell.id = `cell-${dateKey}`;
        let pnlDisplay = ''; let data = state.appData.journal[dateKey];

        const dayNum = document.createElement('div');
        dayNum.className = 'day-number';
        dayNum.style.cssText = 'display:flex; align-items:center; justify-content:space-between;';
        dayNum.textContent = i;
        const dayPnl = document.createElement('div');

        if (data) {
            if (data.pnl !== null && data.pnl !== undefined && data.pnl !== "") { 
                let roundedPnl = parseFloat(data.pnl.toFixed(2));
                pnlDisplay = roundedPnl >= 0 ? `+${roundedPnl}$` : `${roundedPnl}$`; 
                
                cell.classList.add(roundedPnl >= 0 ? 'green' : 'red'); 
                totalPnl += roundedPnl; 
                totalComm += parseFloat(data.commissions) || 0;
                totalLocates += parseFloat(data.locates) || 0; 
                
                if (state.autoFlagsCache.absoluteRecord === dateKey) { cell.classList.add('record-day'); } 
                else if (state.autoFlagsCache.records.has(dateKey)) { cell.classList.add('record-day-old'); }
                
                if (roundedPnl <= currentMonthDayloss) { cell.classList.add('dayloss-day'); }
            }
            
            let hasErrors = data.errors && data.errors.length > 0; 
            if (hasErrors) {
                const errBadge = document.createElement('span');
                errBadge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="#f59e0b" style="width:13px;height:13px;vertical-align:middle;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>`;
                errBadge.style.cssText = 'display:inline-flex; align-items:center;';
                dayNum.appendChild(errBadge);
            }
            
            if (data.mentor_comment && data.mentor_comment.trim() !== '') {
                cell.style.boxShadow = "inset 0 0 0 2px #eab308";
            }
        }

        let dayHoverText = '';
        if (data) {
            const body = buildDayDetailBody(dateKey, data, currentMonthDayloss);
            dayHoverText = formatLongDateUk(dateKey) + (body ? `\n\n${body}` : '\n\nЗапис є — додайте PnL чи думки в формі дня.') + appendWeekSummaryForDate(dateKey);
        } else {
            dayHoverText = formatLongDateUk(dateKey) + '\n\nНемає збереженого дня.' + appendWeekSummaryForDate(dateKey);
        }
        if (tooltip) {
            cell.onmouseenter = (e) => {
                tooltip.innerText = dayHoverText.trim();
                tooltip.style.display = 'block';
                positionCalendarTooltip(e, tooltip);
            };
            cell.onmousemove = (e) => positionCalendarTooltip(e, tooltip);
            cell.onmouseleave = () => { tooltip.style.display = 'none'; };
        }
        dayPnl.className = 'day-pnl' + ((data && data.pnl !== null && data.pnl !== '') ? (data.pnl >= 0 ? ' text-green' : ' text-red') : '');
        dayPnl.textContent = pnlDisplay;
        cell.appendChild(dayNum);
        cell.appendChild(dayPnl);
        cell.onclick = () => { void selectDate(dateKey); };
        if (dateKey === state.selectedDateStr) cell.classList.add('active-day');
        grid.appendChild(cell);
    }
    
    let totalEl = document.getElementById('total-pnl');
    if(totalEl) {
        totalPnl = parseFloat(totalPnl.toFixed(2));
        totalEl.innerText = `${totalPnl}$`;
        totalEl.className = totalPnl >= 0 ? 'text-green' : 'text-red';
    }
    let commEl = document.getElementById('total-comm'); if(commEl) commEl.innerText = `${parseFloat(totalComm).toFixed(2)}$`;
    let locEl = document.getElementById('total-locates'); if(locEl) locEl.innerText = `${parseFloat(totalLocates).toFixed(2)}$`;

    updateDashboardWidgets(year, month);
}

export function initSelectors() {
    let ySel = document.getElementById('year-select');
    let mSel = document.getElementById('month-select');
    
    if (ySel) {
        ySel.innerHTML = '';
        for (let y = 2024; y <= 2030; y++) {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y;
            ySel.appendChild(opt);
        }
        ySel.value = state.todayObj.getFullYear();
    }

    if (mSel) {
        mSel.innerHTML = '';
        const months = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
        months.forEach((m, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = m;
            mSel.appendChild(opt);
        });
        mSel.value = state.todayObj.getMonth();
    }
}
