// === js/parsers.js ===
import { state } from './state.js';
import { saveJournalData, saveToLocal, markJournalDayDirty } from './storage.js';
import { getDefaultDayEntry } from './data_utils.js';
import { ensureXlsx } from './vendor_loader.js';
import { ecnFeeColumnIndex } from './parser_utils.js';

function showToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);color:var(--text-main,#f8fafc);padding:10px 22px;border-radius:10px;font-size:0.95rem;z-index:99999;pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

/** Як importData: не змінюємо журнал у режимі перегляду іншого трейдера. */
function canMutateJournalImports(event) {
    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) {
        showToast('Імпорт заборонено: переглядається чужий профіль.');
        if (event?.target) event.target.value = '';
        return false;
    }
    return true;
}

/**
 * Консоль: які угоди знайшов парсер (перед збереженням) + підсумок після запису.
 * @param {string} label — джерело (для префікса в консолі)
 * @param {Record<string, unknown[]>} tradesByDate — YYYY-MM-DD → масив об'єктів угоди
 * @returns {number} загальна кількість угод
 */
export function logTradesImportConsole(label, tradesByDate) {
    const dates = Object.keys(tradesByDate)
        .filter((d) => Array.isArray(tradesByDate[d]) && tradesByDate[d].length > 0)
        .sort();
    const total = dates.reduce((n, d) => n + tradesByDate[d].length, 0);
    if (total === 0) {
        console.info(
            `[Імпорт ${label}] Окремих рядків угод не знайдено (перевірте дати YYYY-MM-DD, рядок «Opened» і наявність Opened/Closed).`,
        );
        return 0;
    }
    console.group(`[Імпорт ${label}] Знайдено ${total} угод у ${dates.length} днях`);
    for (const dateStr of dates) {
        const trades = tradesByDate[dateStr];
        console.log(`${dateStr} — ${trades.length} шт.`);
        trades.forEach((t, idx) => {
            const sym = t.symbol != null ? String(t.symbol) : '—';
            const typ = t.type ? String(t.type) : '';
            const suffix = typ ? ` [${typ}]` : '';
            console.log(
                `  ${idx + 1}. ${sym}${suffix}  net=${t.net ?? '—'}  gross=${t.gross ?? '—'}  qty=${t.qty ?? '—'}  opened=${t.opened ?? ''}  closed=${t.closed ?? ''}`,
            );
        });
    }
    console.groupEnd();
    return total;
}

function isGoogleSheetTrade(t) {
    return !!(t && typeof t.sheet === 'object' && t.sheet.source === 'google');
}

function isPureGoogleSheetTrade(t) {
    return isGoogleSheetTrade(t) && !t.sheet?.matchedBy;
}

function emptySourceTotals(locates = 0, tickers = []) {
    return { gross: 0, net: 0, comm: 0, locates, tickers };
}

function normalizeSourceTotals(value, fallback = getDefaultDayEntry().fondexx) {
    const src = value && typeof value === 'object' ? value : fallback;
    return {
        gross: Number(src.gross) || 0,
        net: Number(src.net) || 0,
        comm: Number(src.comm) || 0,
        locates: Number(src.locates) || 0,
        tickers: Array.isArray(src.tickers) ? src.tickers : [],
    };
}

function hasSourceMoney(source) {
    const src = normalizeSourceTotals(source);
    return !!(src.gross || src.net || src.comm || src.locates);
}

function isFondexxSummarySource(entry) {
    return entry?.fondexxSource === 'summary-by-date';
}

function roundMoney(value) {
    return parseFloat((Number(value) || 0).toFixed(2));
}

function parseMoney(value) {
    const cleaned = String(value ?? '').replace(/\s/g, '').replace(/[$,]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

function findHeaderIndex(headers, names) {
    const wanted = names.map((name) => String(name).trim().toLowerCase());
    return headers.findIndex((header) => wanted.includes(String(header || '').trim().toLowerCase()));
}

function findTotalDeltaIndex(headers) {
    return headers.findIndex((header) => {
        const normalized = String(header || '').trim().toLowerCase();
        return normalized.startsWith('total') && (
            normalized.includes('δ')
            || normalized.includes('Δ'.toLowerCase())
            || normalized.includes('delta')
            || normalized === 'total d'
        );
    });
}

function getMonthKey(dateStr) {
    return String(dateStr || '').slice(0, 7);
}

function isWeekendIsoDate(dateStr) {
    const [year, month, day] = String(dateStr || '').split('-').map(Number);
    if (!year || !month || !day) return false;
    const jsDay = new Date(year, month - 1, day).getDay();
    return jsDay === 0 || jsDay === 6;
}

function ensureFondexxMonthlyAdjustments() {
    if (!state.appData.settings || typeof state.appData.settings !== 'object') state.appData.settings = {};
    if (!state.appData.settings.fondexxMonthlyAdjustments || typeof state.appData.settings.fondexxMonthlyAdjustments !== 'object') {
        state.appData.settings.fondexxMonthlyAdjustments = {};
    }
    return state.appData.settings.fondexxMonthlyAdjustments;
}

function addMonthlyAdjustment(bucket, monthKey, adjustment) {
    if (!monthKey) return;
    const current = bucket[monthKey] || { pnl: 0, commissions: 0, locates: 0 };
    bucket[monthKey] = {
        pnl: roundMoney((Number(current.pnl) || 0) + (Number(adjustment.pnl) || 0)),
        commissions: roundMoney((Number(current.commissions) || 0) + (Number(adjustment.commissions) || 0)),
        locates: roundMoney((Number(current.locates) || 0) + (Number(adjustment.locates) || 0)),
    };
}

function showImportedMonth(firstDateStr) {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(firstDateStr || ''));
    if (!m) return;

    if (window.switchMainTab) window.switchMainTab('calendar');

    const yearEl = document.getElementById('cal-view-year');
    const monthEl = document.getElementById('cal-view-month');
    if (yearEl) yearEl.value = m[1];
    if (monthEl) monthEl.value = String(Number(m[2]) - 1);
    state.selectedDateStr = firstDateStr;

    Promise.resolve(window.renderView?.()).then(() => {
        if (window.selectDate) return window.selectDate(firstDateStr);
        return null;
    });
}

function tradeTickers(trades) {
    const tickers = new Set();
    for (const t of trades) {
        if (t?.symbol) tickers.add(String(t.symbol).trim());
    }
    return Array.from(tickers).filter(Boolean);
}

function sumTrades(trades) {
    let gross = 0;
    let net = 0;
    let comm = 0;
    for (const t of trades) {
        gross += Number(t.gross) || 0;
        net += Number(t.net) || 0;
        comm += Number(t.comm) || 0;
    }
    return {
        gross: parseFloat(gross.toFixed(2)),
        net: parseFloat(net.toFixed(2)),
        comm: parseFloat(comm.toFixed(2)),
    };
}

function almostEqualMoney(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
}

function looksLikeSheetDerivedFondexx(source, trades) {
    const googleTrades = trades.filter(isPureGoogleSheetTrade);
    if (!googleTrades.length || googleTrades.length !== trades.length) return false;
    const src = normalizeSourceTotals(source);
    const totals = sumTrades(googleTrades);
    return almostEqualMoney(src.gross, totals.gross)
        && almostEqualMoney(src.net, totals.net)
        && almostEqualMoney(src.comm, totals.comm);
}

/**
 * Після імпорту угод — узгоджуємо fondexx і day.pnl.
 * Прибуток/комісії з агрегату fondexx: пріоритет тільки за реальним імпортом
 * Fondexx/PPRO. Рядки Google Sheet зберігаємо як угоди/метадані, але не робимо
 * з них денний P/L для календаря та статистики.
 * Тікери для списку дня збираємо з усіх угод.
 */
export function syncFondexxFromTradesForDay(dateStr) {
    if (!state.appData.journal[dateStr]) return;
    const entry = state.appData.journal[dateStr];
    const trades = Array.isArray(entry.trades) ? entry.trades : [];
    const prevFx = normalizeSourceTotals(entry.fondexx);
    const locates = Number(prevFx.locates) || 0;
    const tickers = tradeTickers(trades);
    let hasAuthoritativePnl = hasSourceMoney(entry.ppro);

    if (isFondexxSummarySource(entry)) {
        entry.fondexx = {
            ...prevFx,
            tickers: Array.from(new Set([...(prevFx.tickers || []), ...tickers])),
        };
        recalculateDailyTotals(dateStr);
        return;
    }

    if (trades.length === 0) {
        hasAuthoritativePnl = hasAuthoritativePnl || hasSourceMoney(prevFx);
        entry.fondexx = hasSourceMoney(prevFx)
            ? { ...prevFx, tickers: prevFx.tickers }
            : emptySourceTotals(locates);
    } else {
        const importTrades = trades.filter((t) => !isPureGoogleSheetTrade(t));
        if (importTrades.length > 0) {
            const totals = sumTrades(importTrades);
            entry.fondexx = {
                ...totals,
                locates,
                tickers,
            };
            hasAuthoritativePnl = true;
        } else if (!hasSourceMoney(prevFx) || looksLikeSheetDerivedFondexx(prevFx, trades)) {
            entry.fondexx = emptySourceTotals(locates, tickers);
        } else {
            entry.fondexx = {
                ...prevFx,
                tickers: Array.from(new Set([...prevFx.tickers, ...tickers])),
            };
            hasAuthoritativePnl = true;
        }
    }
    recalculateDailyTotals(dateStr);
    if (!hasAuthoritativePnl) {
        entry.pnl = null;
        entry.gross_pnl = null;
        entry.commissions = null;
        entry.locates = null;
    }
}

function recalculateDailyTotals(d) {
    if (!state.appData.journal[d]) return;
    let entry = state.appData.journal[d];
    let f = normalizeSourceTotals(entry.fondexx, getDefaultDayEntry().fondexx);
    let p = normalizeSourceTotals(entry.ppro, getDefaultDayEntry().ppro);
    
    entry.gross_pnl = parseFloat((f.gross + p.gross).toFixed(2));
    entry.commissions = parseFloat((f.comm + p.comm).toFixed(2));
    entry.locates = parseFloat((f.locates + p.locates).toFixed(2));
    
    let fondexxNet = f.net - f.locates;
    let pproNet = p.net; 
    
    entry.pnl = parseFloat((fondexxNet + pproNet).toFixed(2));
    
    let existingTickers = new Set();
    if (f.tickers) f.tickers.forEach(t => existingTickers.add(t));
    if (p.tickers) p.tickers.forEach(t => existingTickers.add(t));
    entry.traded_tickers = Array.from(existingTickers);
}

function normalizeTradeSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function tradeTimeMinutes(opened) {
    const m = /\b(\d{1,2}):(\d{2})(?::\d{2})?/.exec(String(opened || ''));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

function pnlTolerance(value) {
    const n = Math.abs(Number(value) || 0);
    return Math.max(5, n * 0.08);
}

function findSheetContextMatchIndex(existingTrades, fondexxTrade, usedIndices) {
    const symbol = normalizeTradeSymbol(fondexxTrade?.symbol);
    if (!symbol) return -1;

    const incomingNet = Number(fondexxTrade?.net);
    const incomingMin = tradeTimeMinutes(fondexxTrade?.opened);
    const candidates = [];

    existingTrades.forEach((trade, index) => {
        if (usedIndices.has(index)) return;
        if (!isGoogleSheetTrade(trade)) return;
        if (normalizeTradeSymbol(trade?.symbol) !== symbol) return;

        const sheetNet = Number(trade?.sheet?.sheetNet);
        const existingNet = Number.isFinite(sheetNet) ? sheetNet : Number(trade?.net);
        const hasPnl = Number.isFinite(existingNet) && Number.isFinite(incomingNet);
        const pnlDiff = hasPnl ? Math.abs(existingNet - incomingNet) : Number.POSITIVE_INFINITY;
        const okByPnl = hasPnl && pnlDiff <= pnlTolerance(incomingNet);

        const existingMin = tradeTimeMinutes(trade?.opened);
        const timeDiff = existingMin != null && incomingMin != null ? Math.abs(existingMin - incomingMin) : null;
        if (timeDiff != null && timeDiff > 120) return;

        const pureBonus = isPureGoogleSheetTrade(trade) ? 30 : 10;
        const pnlScore = okByPnl ? 1000 - pnlDiff : (hasPnl ? Math.max(0, 80 - Math.min(pnlDiff, 80)) : 25);
        const timeScore = timeDiff != null ? Math.max(0, 120 - timeDiff) : 0;
        candidates.push({ index, score: pnlScore + timeScore + pureBonus });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.index ?? -1;
}

function enrichFondexxTradeWithSheet(fondexxTrade, sheetTrade) {
    const sheet = {
        ...(sheetTrade.sheet && typeof sheetTrade.sheet === 'object' ? sheetTrade.sheet : {}),
        matchedBy: 'fondexx-trades+sheet',
        fondexxType: fondexxTrade.type || undefined,
    };

    return {
        ...fondexxTrade,
        type: sheet.tradeType || sheetTrade.type || fondexxTrade.type,
        entry: Number(fondexxTrade.entry) ? fondexxTrade.entry : sheetTrade.entry,
        exit: Number(fondexxTrade.exit) ? fondexxTrade.exit : sheetTrade.exit,
        qty: Number(fondexxTrade.qty) ? fondexxTrade.qty : sheetTrade.qty,
        stop: fondexxTrade.stop ?? sheetTrade.stop,
        sheet,
    };
}

function attachSheetContextToFondexxTrades(dateStr, fondexxTrades) {
    const existing = Array.isArray(state.appData.journal?.[dateStr]?.trades)
        ? state.appData.journal[dateStr].trades
        : [];
    if (!existing.some(isGoogleSheetTrade)) return fondexxTrades;

    const usedIndices = new Set();
    return fondexxTrades.map((trade) => {
        const matchIndex = findSheetContextMatchIndex(existing, trade, usedIndices);
        if (matchIndex < 0) return trade;
        usedIndices.add(matchIndex);
        return enrichFondexxTradeWithSheet(trade, existing[matchIndex]);
    });
}

function toIsoFromParts(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidIsoDateString(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function todayIsoDate() {
    const now = new Date();
    return toIsoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isFutureIsoDate(iso) {
    return isValidIsoDateString(iso) && iso > todayIsoDate();
}

function parseSlashDatePreferDayMonth(value) {
    const s = String(value || '').trim().split(/\s+/)[0];
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (!m) return null;

    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const dmy = toIsoFromParts(year, b, a);
    const mdy = toIsoFromParts(year, a, b);
    const dmyValid = isValidIsoDateString(dmy) ? dmy : null;
    const mdyValid = isValidIsoDateString(mdy) ? mdy : null;

    if (dmyValid && !isFutureIsoDate(dmyValid)) return dmyValid;
    if (mdyValid && !isFutureIsoDate(mdyValid)) return mdyValid;
    return dmyValid || mdyValid;
}

export function importFondexxReport(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!canMutateJournalImports(event)) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            await ensureXlsx();
            let data = new Uint8Array(e.target.result);
            let workbook = XLSX.read(data, {type: 'array'});
            let sheetName = workbook.SheetNames[0];
            let worksheet = workbook.Sheets[sheetName];
            let text = XLSX.utils.sheet_to_csv(worksheet);
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            let dailyData = {}; let currentDate = null;
            let headers = {};
            let isTradesFormat = false;

            for(let i = 0; i < lines.length; i++) {
                let row = lines[i].split(',');
                if (row.length < 2) continue;

                // Дата рядка
                if (row[0].match(/^\d{4}-\d{2}-\d{2}$/)) {
                    currentDate = row[0];
                    if (!dailyData[currentDate]) dailyData[currentDate] = { gross: 0, net: 0, comm: 0, locates: 0, tickers: new Set(), trades: [] };
                    isTradesFormat = false;
                    continue;
                }

                // Заголовок формату trades (Opened, Closed...)
                if (row[0] === 'Opened') {
                    isTradesFormat = true;
                    headers = {};
                    row.forEach((h, idx) => { headers[h.trim()] = idx; });
                    continue;
                }

                // Заголовок формату summary (Symbol, Gross...)
                if (row[0] === 'Symbol') {
                    isTradesFormat = false;
                    headers = {};
                    row.forEach((h, idx) => { headers[h.trim()] = idx; });
                    continue;
                }

                if (!currentDate) continue;

                if (isTradesFormat) {
                    // Формат з окремими угодами
                    const sym = row[headers['Symbol']];
                    if (!sym || sym === 'Equities' || sym === 'Total') continue;

                    const gross = parseFloat(row[headers['Gross']]) || 0;
                    const comm = parseFloat(row[headers['Comm']]) || 0;
                    const ecnIdx = ecnFeeColumnIndex(headers);
                    const ecn = ecnIdx !== undefined ? parseFloat(row[ecnIdx]) || 0 : 0;
                    const net = parseFloat(row[headers['Net']]) || 0;

                    dailyData[currentDate].gross += gross;
                    dailyData[currentDate].net += net;
                    dailyData[currentDate].comm += (comm + ecn);
                    dailyData[currentDate].tickers.add(sym);

                    const opened = row[headers['Opened']] || '';
                    const closed = row[headers['Closed']] || '';
                    if (opened && closed) {
                        dailyData[currentDate].trades.push({
                            symbol: sym,
                            type: row[headers['Type']] || '',
                            opened: opened,
                            closed: closed,
                            held: row[headers['Held']] || '',
                            entry: parseFloat(row[headers['Entry']]) || 0,
                            exit: parseFloat(row[headers['Exit']]) || 0,
                            qty: parseInt(row[headers['Qty']]) || 0,
                            gross: gross,
                            comm: parseFloat((comm + ecn).toFixed(2)),
                            net: net,
                            // Real persisted screenshot binding is disabled for now.
                            // screenshotPath: null,
                        });
                    }
                } else {
                    // Старий summary формат
                    const sIdx = headers['Symbol'] ?? 0;
                    const gIdx = headers['Gross'] ?? 4;
                    const cIdx = headers['Comm'] ?? 5;
                    const eIdx = headers['Ecn Fee'] ?? 6;
                    const nIdx = headers['Net'] ?? 12;
                    const dIdx = headers['Total \u0394'] ?? 14;
                    const sym = row[sIdx]; if (!sym) continue;
                    if (sym.includes('Locates')) {
                        dailyData[currentDate].locates += Math.abs(parseFloat(row[dIdx]) || 0);
                        continue;
                    }
                    if (sym === 'Equities' || sym === 'Fees' || sym === 'Total' || sym.includes('Fee:')) continue;
                    dailyData[currentDate].gross += parseFloat(row[gIdx]) || 0;
                    dailyData[currentDate].net += parseFloat(row[nIdx]) || 0;
                    dailyData[currentDate].comm += (parseFloat(row[cIdx]) || 0) + (parseFloat(row[eIdx]) || 0);
                    dailyData[currentDate].tickers.add(sym);
                }
            }

            const fondexxTradesByDay = {};
            for (const d in dailyData) {
                if (dailyData[d].trades && dailyData[d].trades.length > 0) fondexxTradesByDay[d] = dailyData[d].trades;
            }
            const fondexxTradeCount = logTradesImportConsole('Fondexx звіт', fondexxTradesByDay);

            let daysUpdated = 0;
            let summaryProtectedDays = 0;
            for(let d in dailyData) {
                if (!state.appData.journal[d]) state.appData.journal[d] = getDefaultDayEntry();
                if (isFondexxSummarySource(state.appData.journal[d])) {
                    if (dailyData[d].trades.length > 0) state.appData.journal[d].trades = dailyData[d].trades;
                    recalculateDailyTotals(d);
                    markJournalDayDirty(d);
                    summaryProtectedDays++;
                    daysUpdated++;
                    continue;
                }
                state.appData.journal[d].fondexx = { gross: dailyData[d].gross, net: dailyData[d].net, comm: dailyData[d].comm, locates: dailyData[d].locates, tickers: Array.from(dailyData[d].tickers) };
                state.appData.journal[d].fondexxSource = 'fondexx-report';
                if (dailyData[d].trades.length > 0) state.appData.journal[d].trades = dailyData[d].trades;
                recalculateDailyTotals(d);
                markJournalDayDirty(d);
                daysUpdated++;
            }
            saveJournalData().then(() => {
                if (fondexxTradeCount > 0) {
                    console.log(
                        `[Імпорт Fondexx звіт] Імпортовано у журнал: ${fondexxTradeCount} угод, оновлено календарних днів: ${daysUpdated}.`,
                    );
                } else {
                    console.log(
                        `[Імпорт Fondexx звіт] Записано агрегати по днях (summary або без рядків угод), днів: ${daysUpdated}.`,
                    );
                }
                const protectedNote = summaryProtectedDays ? ` Summary by date має пріоритет: ${summaryProtectedDays} днів не перетерто.` : '';
                showToast(`Звіт Fondexx імпортовано! Оновлено днів: ${daysUpdated}.${protectedNote}`); 
                if(window.updateAutoFlags) window.updateAutoFlags(); 
                if(window.renderView) window.renderView();
                let viewStats = document.getElementById('view-stats');
                if (viewStats && viewStats.classList.contains('active') && window.refreshStatsView) { window.refreshStatsView(); }
                if(window.selectDate) window.selectDate(state.selectedDateStr);
            }).catch(err => {
                showToast('Import save error: ' + (err?.message || err));
            });
        } catch(err) { showToast('Помилка обробки Fondexx: ' + err.message); }
    };
    reader.readAsArrayBuffer(file); event.target.value = ''; 
}

export function importFondexxSummaryByDate(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!canMutateJournalImports(event)) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            await ensureXlsx();
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '' });
            const headerRow = rows.findIndex((row) => row.some((cell) => String(cell).trim().toLowerCase() === 'date'));
            if (headerRow < 0) throw new Error('Не знайдено колонку Date');

            const headers = rows[headerRow].map((h) => String(h || '').trim());
            const dateIdx = findHeaderIndex(headers, ['Date']);
            const typeIdx = findHeaderIndex(headers, ['Type']);
            const grossIdx = findHeaderIndex(headers, ['Gross']);
            const netIdx = findHeaderIndex(headers, ['Net']);
            const totalIdx = findTotalDeltaIndex(headers);
            const adjNetIdx = findHeaderIndex(headers, ['Adj Net']);
            const commIdx = findHeaderIndex(headers, ['Comm']);
            const ecnIdx = findHeaderIndex(headers, ['Ecn Fee', 'ECN Fee']);
            const secIdx = findHeaderIndex(headers, ['SEC']);
            const tafIdx = findHeaderIndex(headers, ['TAF']);
            const nsccIdx = findHeaderIndex(headers, ['NSCC']);
            const clrIdx = findHeaderIndex(headers, ['CLR']);
            const miscIdx = findHeaderIndex(headers, ['Misc']);
            const orfIdx = findHeaderIndex(headers, ['ORF']);
            const ptfpfIdx = findHeaderIndex(headers, ['PTFPF']);
            const softwareIdx = findHeaderIndex(headers, ['Software']);

            if (dateIdx < 0 || grossIdx < 0 || netIdx < 0 || totalIdx < 0) {
                throw new Error('Потрібні колонки Date, Gross, Net і Total Δ');
            }

            const feeIndices = [commIdx, ecnIdx, secIdx, tafIdx, nsccIdx, clrIdx, miscIdx, orfIdx, ptfpfIdx].filter((idx) => idx >= 0);
            let daysUpdated = 0;
            let monthlyAdjustmentDays = 0;
            const importedDates = [];
            const monthlyAdjustments = {};
            const monthBrokerTotals = {};

            for (const row of rows.slice(headerRow + 1)) {
                const rawDate = String(row[dateIdx] || '').trim();
                if (rawDate.toLowerCase() === 'equities') {
                    const totalDelta = roundMoney(parseMoney(row[totalIdx]));
                    const firstMonth = importedDates[0]?.slice(0, 7);
                    if (firstMonth) monthBrokerTotals[firstMonth] = totalDelta;
                    continue;
                }

                const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
                    ? rawDate.slice(0, 10)
                    : parseSlashDatePreferDayMonth(rawDate);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
                const type = typeIdx >= 0 ? String(row[typeIdx] || '').trim().toLowerCase() : '';

                const monthKey = getMonthKey(dateStr);
                const gross = roundMoney(parseMoney(row[grossIdx]));
                const net = roundMoney(parseMoney(row[netIdx]));
                const totalDelta = roundMoney(parseMoney(row[totalIdx]));
                const adjNet = adjNetIdx >= 0 ? roundMoney(parseMoney(row[adjNetIdx])) : totalDelta;
                const feeSum = roundMoney(feeIndices.reduce((sum, idx) => sum + parseMoney(row[idx]), 0));
                const software = softwareIdx >= 0 ? roundMoney(parseMoney(row[softwareIdx])) : 0;
                const comm = roundMoney((feeSum || roundMoney(gross - net)) + Math.abs(software));
                const locates = roundMoney(net - totalDelta);

                if (isWeekendIsoDate(dateStr) || (type && type !== 'eq' && type !== 'equities')) {
                    addMonthlyAdjustment(monthlyAdjustments, monthKey, {
                        pnl: totalDelta || adjNet,
                        commissions: comm,
                        locates,
                    });
                    monthlyAdjustmentDays++;
                    continue;
                }

                if (!state.appData.journal[dateStr]) state.appData.journal[dateStr] = getDefaultDayEntry();
                const entry = state.appData.journal[dateStr];
                const tickers = Array.from(new Set([
                    ...(Array.isArray(entry.fondexx?.tickers) ? entry.fondexx.tickers : []),
                    ...tradeTickers(Array.isArray(entry.trades) ? entry.trades : []),
                ])).filter(Boolean);

                entry.fondexx = { gross, net, comm, locates, tickers };
                entry.fondexxSource = 'summary-by-date';
                recalculateDailyTotals(dateStr);
                markJournalDayDirty(dateStr);
                importedDates.push(dateStr);
                daysUpdated++;
            }

            for (const [monthKey, brokerTotal] of Object.entries(monthBrokerTotals)) {
                const journalMonthTotal = importedDates
                    .filter((dateStr) => dateStr.startsWith(`${monthKey}-`))
                    .reduce((sum, dateStr) => sum + (Number(state.appData.journal[dateStr]?.pnl) || 0), 0);
                const existingAdjustment = Number(monthlyAdjustments[monthKey]?.pnl) || 0;
                const missing = roundMoney(brokerTotal - journalMonthTotal - existingAdjustment);
                if (Math.abs(missing) >= 0.01) {
                    addMonthlyAdjustment(monthlyAdjustments, monthKey, { pnl: missing, commissions: 0, locates: 0 });
                }
            }

            const adjustmentBucket = ensureFondexxMonthlyAdjustments();
            for (const monthKey of new Set([...importedDates.map(getMonthKey), ...Object.keys(monthlyAdjustments)])) {
                adjustmentBucket[monthKey] = monthlyAdjustments[monthKey] || { pnl: 0, commissions: 0, locates: 0 };
            }

            if (!daysUpdated) throw new Error('У Summary by date не знайдено денних рядків');
            saveToLocal().then(() => {
                console.log(`[Імпорт Fondexx Summary by date] Оновлено точні денні P&L/fees/locates: ${daysUpdated} днів`, importedDates);
                const adjustmentNote = monthlyAdjustmentDays ? ` Місячні adjustment-и: ${monthlyAdjustmentDays} ряд.` : '';
                showToast(`Summary by date імпортовано! Точні денні дані: ${daysUpdated} днів.${adjustmentNote}`);
                if (window.updateAutoFlags) window.updateAutoFlags();
                showImportedMonth(importedDates[0]);
                const viewStats = document.getElementById('view-stats');
                if (viewStats && viewStats.classList.contains('active') && window.refreshStatsView) {
                    window.refreshStatsView();
                }
            }).catch(err => {
                showToast('Import save error: ' + (err?.message || err));
            });
        } catch(err) { showToast('Помилка імпорту Summary by date: ' + err.message); }
    };
    reader.readAsArrayBuffer(file); event.target.value = '';
}

export function importFondexxTrades(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!canMutateJournalImports(event)) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            await ensureXlsx();
            let data = new Uint8Array(e.target.result);
            let workbook = XLSX.read(data, {type: 'array'});
            let sheetName = workbook.SheetNames[0];
            let worksheet = workbook.Sheets[sheetName];
            let text = XLSX.utils.sheet_to_csv(worksheet);
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            let dailyTrades = {};
            let headers = {};
            let currentDate = null;

            for (let i = 0; i < lines.length; i++) {
                let row = lines[i].split(',');
                if (row[0].match(/^\d{4}-\d{2}-\d{2}$/)) {
                    currentDate = row[0];
                    if (!dailyTrades[currentDate]) dailyTrades[currentDate] = [];
                    continue;
                }
                if (row[0] === 'Opened') {
                    headers = {};
                    row.forEach((h, idx) => { headers[h.trim()] = idx; });
                    continue;
                }
                if (!currentDate || !headers['Symbol']) continue;
                const sym = row[headers['Symbol']];
                if (!sym || sym === 'Equities' || sym === 'Total') continue;
                const opened = row[headers['Opened']] || '';
                const closed = row[headers['Closed']] || '';
                if (!opened || !closed) continue;
                const comm = parseFloat(row[headers['Comm']]) || 0;
                const ecnIdx = ecnFeeColumnIndex(headers);
                const ecn = ecnIdx !== undefined ? parseFloat(row[ecnIdx]) || 0 : 0;
                dailyTrades[currentDate].push({
                    symbol: sym,
                    type: row[headers['Type']] || '',
                    opened, closed,
                    held: row[headers['Held']] || '',
                    entry: parseFloat(row[headers['Entry']]) || 0,
                    exit: parseFloat(row[headers['Exit']]) || 0,
                    qty: parseInt(row[headers['Qty']]) || 0,
                    gross: parseFloat(row[headers['Gross']]) || 0,
                    comm: parseFloat((comm + ecn).toFixed(2)),
                    net: parseFloat(row[headers['Net']]) || 0,
                    // Real persisted screenshot binding is disabled for now.
                    // screenshotPath: null,
                });
            }

            const tradesOnlyByDay = {};
            for (const d in dailyTrades) {
                if (dailyTrades[d].length > 0) tradesOnlyByDay[d] = dailyTrades[d];
            }
            const fondexxListCount = logTradesImportConsole('Fondexx Trades (лише угоди)', tradesOnlyByDay);

            let daysUpdated = 0;
            let daysWithoutSummary = 0;
            for (let d in dailyTrades) {
                if (!state.appData.journal[d]) state.appData.journal[d] = getDefaultDayEntry();
                if (!isFondexxSummarySource(state.appData.journal[d])) daysWithoutSummary++;
                state.appData.journal[d].trades = attachSheetContextToFondexxTrades(d, dailyTrades[d]);
                syncFondexxFromTradesForDay(d);
                markJournalDayDirty(d);
                daysUpdated++;
            }
            saveJournalData().then(() => {
                if (fondexxListCount > 0) {
                    console.log(
                        `[Імпорт Fondexx Trades] Імпортовано у журнал: ${fondexxListCount} угод, оновлено днів: ${daysUpdated}.`,
                    );
                }
                const warning = daysWithoutSummary
                    ? ` Для ${daysWithoutSummary} днів P&L пораховано з trades; для точності імпортуйте Summary by date.`
                    : ' Денний P&L з Summary by date збережено.';
                showToast(`Trades імпортовано! Днів: ${daysUpdated}.${warning}`);
                if (window.updateAutoFlags) window.updateAutoFlags();
                if (window.renderView) window.renderView();
                const viewStats = document.getElementById('view-stats');
                if (viewStats && viewStats.classList.contains('active') && window.refreshStatsView) {
                    window.refreshStatsView();
                }
                if (window.selectDate) window.selectDate(state.selectedDateStr);
            }).catch(err => {
                showToast('Import save error: ' + (err?.message || err));
            });
        } catch(err) { showToast('Помилка імпорту Trades: ' + err.message); }
    };
    reader.readAsArrayBuffer(file); event.target.value = '';
}

export function importPPROReport(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!canMutateJournalImports(event)) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            await ensureXlsx();
            let data = new Uint8Array(e.target.result);
            let workbook = XLSX.read(data, {type: 'array'});
            let sheetName = workbook.SheetNames[0];
            let worksheet = workbook.Sheets[sheetName];
            
            let json = XLSX.utils.sheet_to_json(worksheet, {raw: false, defval: ""});
            let dailyData = {};
            
            json.forEach(row => {
                let keys = Object.keys(row);
                let dateKey = keys.find(k => k.trim().toLowerCase() === 'date');
                let totalKey = keys.find(k => k.trim().toLowerCase() === 'trading total');
                
                if (dateKey && totalKey) {
                    let dateVal = String(row[dateKey]).trim();
                    let totalVal = String(row[totalKey]).trim();
                    let d = null;
                    
                    if (dateVal && dateVal.includes('/')) d = parseSlashDatePreferDayMonth(dateVal);
                    
                    if (d && !isFutureIsoDate(d)) {
                        let cleanTotal = totalVal.replace(/,/g, '').replace(/"/g, '');
                        let profit = parseFloat(cleanTotal) || 0;
                        if (!dailyData[d]) dailyData[d] = { profit: 0 };
                        dailyData[d].profit += profit; 
                    }
                }
            });
            
            let daysUpdated = 0;
            for(let d in dailyData) {
                if (!state.appData.journal[d]) state.appData.journal[d] = getDefaultDayEntry();
                state.appData.journal[d].ppro = { gross: dailyData[d].profit, net: dailyData[d].profit, comm: 0, locates: 0, tickers: [] };
                recalculateDailyTotals(d);
                markJournalDayDirty(d);
                daysUpdated++;
            }
            saveJournalData().then(() => {
                showToast(`Звіт PPRO успішно імпортовано! Оновлено днів: ${daysUpdated}`); 
                if(window.updateAutoFlags) window.updateAutoFlags(); 
                if(window.renderView) window.renderView();
                let viewStats = document.getElementById('view-stats');
                if (viewStats && viewStats.classList.contains('active') && window.refreshStatsView) { window.refreshStatsView(); }
                if(window.selectDate) window.selectDate(state.selectedDateStr);
            }).catch(err => {
                showToast('Import save error: ' + (err?.message || err));
            });
        } catch(err) { showToast('Помилка обробки PPRO: ' + err.message); }
    };
    reader.readAsArrayBuffer(file); event.target.value = '';
}
