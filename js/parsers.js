// === js/parsers.js ===
import { state } from './state.js';
import { saveJournalData, markJournalDayDirty } from './storage.js';
import { getDefaultDayEntry } from './data_utils.js';

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

function ecnFeeColumnIndex(headers) {
    const keys = ['Ecn Fee', 'ECN Fee', 'ECN', 'Ecn'];
    for (const k of keys) {
        if (headers[k] !== undefined) return headers[k];
    }
    return undefined;
}

/** Після імпорту лише списку угод — узгоджуємо fondexx і day.pnl з тими ж правилами, що й після Fondexx summary. */
function syncFondexxFromTradesForDay(dateStr) {
    if (!state.appData.journal[dateStr]) return;
    const entry = state.appData.journal[dateStr];
    const trades = Array.isArray(entry.trades) ? entry.trades : [];
    const prevFx = entry.fondexx && typeof entry.fondexx === 'object' ? entry.fondexx : {};
    const locates = Number(prevFx.locates) || 0;

    if (trades.length === 0) {
        entry.fondexx = { gross: 0, net: 0, comm: 0, locates, tickers: [] };
    } else {
        let gross = 0;
        let net = 0;
        let comm = 0;
        const tickers = new Set();
        for (const t of trades) {
            gross += parseFloat(t.gross) || 0;
            net += parseFloat(t.net) || 0;
            comm += parseFloat(t.comm) || 0;
            if (t.symbol) tickers.add(String(t.symbol).trim());
        }
        entry.fondexx = {
            gross: parseFloat(gross.toFixed(2)),
            net: parseFloat(net.toFixed(2)),
            comm: parseFloat(comm.toFixed(2)),
            locates,
            tickers: Array.from(tickers),
        };
    }
    recalculateDailyTotals(dateStr);
}

function recalculateDailyTotals(d) {
    if (!state.appData.journal[d]) return;
    let entry = state.appData.journal[d];
    let f = entry.fondexx || getDefaultDayEntry().fondexx;
    let p = entry.ppro || getDefaultDayEntry().ppro;
    
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

export function importFondexxReport(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!canMutateJournalImports(event)) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
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
                            net: net
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

            let daysUpdated = 0;
            for(let d in dailyData) {
                if (!state.appData.journal[d]) state.appData.journal[d] = getDefaultDayEntry();
                state.appData.journal[d].fondexx = { gross: dailyData[d].gross, net: dailyData[d].net, comm: dailyData[d].comm, locates: dailyData[d].locates, tickers: Array.from(dailyData[d].tickers) };
                if (dailyData[d].trades.length > 0) state.appData.journal[d].trades = dailyData[d].trades;
                recalculateDailyTotals(d);
                markJournalDayDirty(d);
                daysUpdated++;
            }
            saveJournalData().then(() => {
                showToast(`Звіт Fondexx імпортовано! Оновлено днів: ${daysUpdated}`); 
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

export function importFondexxTrades(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!canMutateJournalImports(event)) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
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
                    net: parseFloat(row[headers['Net']]) || 0
                });
            }

            let daysUpdated = 0;
            for (let d in dailyTrades) {
                if (!state.appData.journal[d]) state.appData.journal[d] = getDefaultDayEntry();
                state.appData.journal[d].trades = dailyTrades[d];
                syncFondexxFromTradesForDay(d);
                markJournalDayDirty(d);
                daysUpdated++;
            }
            saveJournalData().then(() => {
                showToast(`Trades імпортовано! Днів: ${daysUpdated}`);
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
    reader.onload = function(e) {
        try {
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
                    
                    if (dateVal && dateVal.includes('/')) {
                        let parts = dateVal.split('/');
                        if (parts.length === 3) {
                            let month = parts[0].padStart(2, '0');
                            let day = parts[1].padStart(2, '0');
                            let year = parts[2].length === 2 ? "20" + parts[2] : parts[2];
                            d = `${year}-${month}-${day}`;
                        }
                    }
                    
                    if (d) {
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
