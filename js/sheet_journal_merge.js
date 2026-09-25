import {
    enrichTradeWithSheet,
    findSheetMatchIndex,
    isValidIsoDateString,
} from './sheet_sync_core.js';
import { isPureGoogleSheetTrade } from './trade_filters.js';
import { buildAutoTradeTypesData, DEFAULT_TRADE_TYPES, getDefaultDayEntry, isNotTakenTrade } from './data_utils.js';
import { reconcileDayLocates } from './parser_utils.js';
import { dayHasPriorityOverSheet } from './shs_trades_core.js';

function sumTradeMoney(trades = []) {
    return trades.reduce((sum, trade) => {
        sum.gross += Number(trade?.gross) || 0;
        sum.net += Number(trade?.net) || 0;
        sum.comm += Number(trade?.comm) || 0;
        return sum;
    }, { gross: 0, net: 0, comm: 0 });
}

function almostEqualMoney(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
}

function fondexxLooksDerivedFromTrades(fondexx, trades) {
    if (!fondexx || typeof fondexx !== 'object' || !Array.isArray(trades) || trades.length === 0) return false;
    const totals = sumTradeMoney(trades);
    return almostEqualMoney(fondexx.gross, totals.gross)
        && almostEqualMoney(fondexx.net, totals.net)
        && almostEqualMoney(fondexx.comm, totals.comm);
}

function hasAnyScreenshot(day) {
    const screens = day?.screenshots && typeof day.screenshots === 'object' ? day.screenshots : {};
    return Object.values(screens).some((items) => Array.isArray(items) && items.length > 0);
}

function hasNonEmptyObject(value) {
    return value && typeof value === 'object' && Object.keys(value).length > 0;
}

function annotateStoredSheetMatch(sheetRowsStore, spreadsheetId, dateStr, incomingTrade, matchIndex) {
    if (!sheetRowsStore || !spreadsheetId || matchIndex < 0) return;
    const rows = sheetRowsStore[spreadsheetId]?.[dateStr];
    if (!Array.isArray(rows)) return;
    const incomingSheet = incomingTrade?.sheet && typeof incomingTrade.sheet === 'object' ? incomingTrade.sheet : {};
    const sheetRow = incomingSheet.sheetRow;
    const storedIndex = rows.findIndex((row) => {
        const storedSheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
        if (sheetRow != null && storedSheet.sheetRow === sheetRow) return true;
        return row?.symbol === incomingTrade?.symbol && row?.opened === incomingTrade?.opened;
    });
    if (storedIndex < 0) return;
    const stored = rows[storedIndex] || {};
    rows[storedIndex] = {
        ...stored,
        sheet: {
            ...(stored.sheet && typeof stored.sheet === 'object' ? stored.sheet : {}),
            matchedTradeIndex: matchIndex,
            matchedBy: 'date+ticker+pnl',
        },
    };
}

function storeSheetRows(sheetRowsStore, spreadsheetId, outByDay) {
    let importedSheetRows = 0;
    if (!sheetRowsStore || !spreadsheetId) return importedSheetRows;
    const nextRowsByDay = {};
    for (const dateStr of Object.keys(outByDay || {})) {
        if (!isValidIsoDateString(dateStr)) continue;
        const rows = Array.isArray(outByDay[dateStr]) ? outByDay[dateStr] : [];
        if (!rows.length) continue;
        nextRowsByDay[dateStr] = rows.map((trade) => ({
            symbol: trade.symbol || '',
            opened: trade.opened || '',
            net: Number(trade.net) || 0,
            gross: Number(trade.gross) || 0,
            comm: Number(trade.comm) || 0,
            type: trade.type || '',
            sheet: trade.sheet && typeof trade.sheet === 'object' ? { ...trade.sheet } : {},
        }));
        importedSheetRows += nextRowsByDay[dateStr].length;
    }
    sheetRowsStore[spreadsheetId] = nextRowsByDay;
    return importedSheetRows;
}

function tradeHasMainSheetContext(trade, spreadsheetId = '') {
    const sheet = trade?.sheet;
    if (!sheet || sheet.source !== 'google') return false;
    if (!sheet.matchedBy) return false;
    if (!spreadsheetId) return true;
    return sheet.spreadsheetId !== spreadsheetId;
}

function restoreAuthoritativeDayPnl(day) {
    const fondexx = day?.fondexx && typeof day.fondexx === 'object' ? day.fondexx : {};
    const ppro = day?.ppro && typeof day.ppro === 'object' ? day.ppro : {};
    const hasImport = day?.fondexxSource === 'summary-by-date'
        || day?.pproSource === 'ppro-total-report'
        || Number(fondexx.net) || Number(fondexx.locates) || Number(ppro.net);
    return hasImport
        ? Number(((Number(fondexx.net) || 0) - (Number(fondexx.locates) || 0) + (Number(ppro.net) || 0)).toFixed(2))
        : null;
}

function syncMainSheetMetricsToCalendar(journal, outByDay, spreadsheetId, markTouched, previouslyManagedDates = new Set(), tradeTypesSyncEnabled = false, tradeTypesMonth = '') {
    const syncedDates = [];
    const deletedDates = [];

    Object.keys(journal || {}).forEach((dateStr) => {
        const day = journal[dateStr];
        const wasPreviouslyManaged = previouslyManagedDates.has(dateStr);
        if (!day || (!wasPreviouslyManaged && day.sheetGrossSource !== spreadsheetId && day.sheetPnlSource !== spreadsheetId && day.sheetTradeTypesSource !== spreadsheetId)) return;
        const sheetOnlyDay = day.sheetCalendarOnly === true;
        const lockedByBroker = dayHasPriorityOverSheet(day);

        // Migrate the previous behavior that incorrectly overwrote net day PnL.
        if (day.sheetPnlSource === spreadsheetId || (wasPreviouslyManaged && day.fondexxSource === 'summary-by-date')) {
            if (!lockedByBroker) day.pnl = restoreAuthoritativeDayPnl(day);
            delete day.sheetPnlSource;
        }
        if (day.sheetGrossSource === spreadsheetId || wasPreviouslyManaged) {
            if (!lockedByBroker && (wasPreviouslyManaged || day.sheetGrossValue === undefined || Number(day.gross_pnl) === Number(day.sheetGrossValue))) day.gross_pnl = null;
            delete day.sheetGrossSource;
            delete day.sheetGrossValue;
        }
        const syncTradeTypes = tradeTypesSyncEnabled && (!tradeTypesMonth || dateStr.startsWith(`${tradeTypesMonth}-`));
        if (syncTradeTypes && (day.sheetTradeTypesSource === spreadsheetId || sheetOnlyDay || wasPreviouslyManaged)) {
            const data = day.tradeTypesData && typeof day.tradeTypesData === 'object' ? { ...day.tradeTypesData } : {};
            DEFAULT_TRADE_TYPES.forEach((type) => delete data[type]);
            day.tradeTypesData = data;
            delete day.sheetTradeTypesSource;
        }
        delete day.sheetCalendarOnly;

        if (sheetOnlyDay && isDayEmptyAfterSheetCleanup(day)) {
            delete journal[dateStr];
            deletedDates.push(dateStr);
        } else {
            markTouched(dateStr, day);
        }
    });

    Object.entries(outByDay || {}).forEach(([dateStr, rows]) => {
        if (!isValidIsoDateString(dateStr) || !Array.isArray(rows)) return;
        const executedRows = rows.filter((trade) => !isNotTakenTrade(trade));
        const pnlRows = executedRows.filter((trade) => {
            const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
            return sheet.sheetNet !== undefined && sheet.sheetNet !== null && sheet.sheetNet !== ''
                && Number.isFinite(Number(sheet.sheetNet));
        });
        const existingDay = journal[dateStr];
        const syncTradeTypes = tradeTypesSyncEnabled && (!tradeTypesMonth || dateStr.startsWith(`${tradeTypesMonth}-`));
        const tradeTypesData = syncTradeTypes ? buildAutoTradeTypesData(executedRows) : {};
        if (!pnlRows.length && !Object.keys(tradeTypesData).length) return;

        const existed = journal[dateStr] && typeof journal[dateStr] === 'object';
        const day = existed ? journal[dateStr] : getDefaultDayEntry();
        if (pnlRows.length && !dayHasPriorityOverSheet(day)) {
            const gross = Number(pnlRows.reduce((sum, trade) => sum + Number(trade.sheet.sheetNet), 0).toFixed(2));
            day.gross_pnl = gross;
            day.sheetGrossSource = spreadsheetId;
            day.sheetGrossValue = gross;
            if (day.pnl !== null && day.pnl !== undefined && day.pnl !== '') {
                day.locates = reconcileDayLocates(gross, day.pnl, day.commissions, day.locates);
            }
        }
        if (Object.keys(tradeTypesData).length) {
            day.tradeTypesData = {
                ...(day.tradeTypesData && typeof day.tradeTypesData === 'object' ? day.tradeTypesData : {}),
                ...tradeTypesData,
            };
            day.sheetTradeTypesSource = spreadsheetId;
        }
        if (!existed) day.sheetCalendarOnly = true;
        journal[dateStr] = day;
        markTouched(dateStr, day);
        syncedDates.push(dateStr);
    });
    return { syncedDates, deletedDates };
}

export function isDayEmptyAfterSheetCleanup(day) {
    if (!day || typeof day !== 'object') return true;
    if (Array.isArray(day.trades) && day.trades.length > 0) return false;
    if (String(day.notes || '').trim() || String(day.mentor_comment || '').trim()) return false;
    if (hasAnyScreenshot(day)) return false;
    if (Array.isArray(day.errors) && day.errors.length > 0) return false;
    if (Array.isArray(day.checkedParams) && day.checkedParams.length > 0) return false;
    if (hasNonEmptyObject(day.sliders) || hasNonEmptyObject(day.tradeTypesData) || hasNonEmptyObject(day.review_requests)) return false;
    if (String(day.sessionGoal || '').trim() || String(day.sessionPlan || '').trim() || day.sessionDone) return false;
    const fondexx = day.fondexx && typeof day.fondexx === 'object' ? day.fondexx : {};
    if (Number(fondexx.net) || Number(fondexx.gross) || Number(fondexx.comm) || Number(fondexx.locates)) return false;
    const ppro = day.ppro && typeof day.ppro === 'object' ? day.ppro : {};
    if (Number(ppro.net) || Number(ppro.gross) || Number(ppro.comm) || Number(ppro.locates)) return false;
    return true;
}

function hasStoredNumber(value) {
    if (value === null || value === undefined || value === '') return false;
    return Number.isFinite(Number(value));
}

export function calendarDayHasRecords(day) {
    if (!day || typeof day !== 'object') return false;
    if (hasStoredNumber(day.pnl) || hasStoredNumber(day.gross_pnl) || hasStoredNumber(day.commissions) || hasStoredNumber(day.locates) || hasStoredNumber(day.kf)) return true;
    if (Array.isArray(day.trades) && day.trades.length > 0) return true;
    if (String(day.notes || '').trim() || String(day.mentor_comment || '').trim() || String(day.ai_advice || '').trim()) return true;
    if (hasAnyScreenshot(day)) return true;
    if (Array.isArray(day.errors) && day.errors.length > 0) return true;
    if (Array.isArray(day.checkedParams) && day.checkedParams.length > 0) return true;
    if (Array.isArray(day.traded_tickers) && day.traded_tickers.length > 0) return true;
    if (hasNonEmptyObject(day.sliders) || hasNonEmptyObject(day.tradeTypesData) || hasNonEmptyObject(day.review_requests) || hasNonEmptyObject(day.tickers)) return true;
    if (String(day.sessionGoal || '').trim() || String(day.sessionPlan || '').trim() || day.sessionDone || day.sessionStartRecorded) return true;
    if (day.traderAbsent === true || day.demoTrading === true) return true;
    if (String(day.fondexxSource || '').trim() || String(day.pproSource || '').trim()) return true;
    const fondexx = day.fondexx && typeof day.fondexx === 'object' ? day.fondexx : {};
    if (Number(fondexx.net) || Number(fondexx.gross) || Number(fondexx.comm) || Number(fondexx.locates)) return true;
    const ppro = day.ppro && typeof day.ppro === 'object' ? day.ppro : {};
    if (Number(ppro.net) || Number(ppro.gross) || Number(ppro.comm) || Number(ppro.locates)) return true;
    return false;
}

function rowArchiveProfit(trade) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const hasSheetNet = sheet.sheetNet !== undefined && sheet.sheetNet !== null && sheet.sheetNet !== '';
    const raw = hasSheetNet ? sheet.sheetNet : trade?.net;
    if (raw === undefined || raw === null || raw === '') return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
}

function cumulativeSourceId(spreadsheetId, rows) {
    if (spreadsheetId) return String(spreadsheetId);
    const fromRow = (Array.isArray(rows) ? rows : []).find((row) => row?.sheet?.spreadsheetId);
    return fromRow?.sheet?.spreadsheetId ? String(fromRow.sheet.spreadsheetId) : '';
}

export function fillEmptyCalendarDaysFromCumulative(journal, outByDay, spreadsheetId, markTouched, options = {}) {
    const filledDates = [];
    const allowCreateMissingDays = options.allowCreateMissingDays !== false;
    const tradeTypesSyncEnabled = options.tradeTypesSyncEnabled === true;
    const tradeTypesMonth = /^\d{4}-\d{2}$/.test(String(options.tradeTypesMonth || '')) ? String(options.tradeTypesMonth) : '';
    const touch = typeof markTouched === 'function' ? markTouched : () => {};

    Object.entries(outByDay || {}).forEach(([dateStr, rows]) => {
        if (!isValidIsoDateString(dateStr) || !Array.isArray(rows) || !rows.length) return;
        const existing = journal?.[dateStr];
        const existed = existing && typeof existing === 'object';
        if (!existed && !allowCreateMissingDays) return;
        if (calendarDayHasRecords(existing)) return;

        const executedRows = rows.filter((trade) => !isNotTakenTrade(trade));
        const profits = executedRows.map(rowArchiveProfit).filter((value) => value !== null);
        const syncTradeTypes = tradeTypesSyncEnabled && (!tradeTypesMonth || dateStr.startsWith(`${tradeTypesMonth}-`));
        const tradeTypesData = syncTradeTypes ? buildAutoTradeTypesData(executedRows) : {};
        if (!profits.length && !Object.keys(tradeTypesData).length) return;

        const day = existed ? existing : getDefaultDayEntry();
        const sourceId = cumulativeSourceId(spreadsheetId, rows);
        const source = sourceId ? `cumulative:${sourceId}` : 'cumulative';
        if (profits.length) {
            const gross = Number(profits.reduce((sum, value) => sum + value, 0).toFixed(2));
            day.gross_pnl = gross;
            day.sheetGrossSource = source;
            day.sheetGrossValue = gross;
        }
        if (Object.keys(tradeTypesData).length) {
            day.tradeTypesData = tradeTypesData;
            day.sheetTradeTypesSource = source;
        }
        journal[dateStr] = day;
        touch(dateStr, day);
        filledDates.push(dateStr);
    });
    return filledDates;
}

export function fillEmptyCalendarDaysFromCumulativeStore(journal, store, options = {}) {
    const monthKey = /^\d{4}-\d{2}$/.test(String(options.monthKey || '')) ? String(options.monthKey) : '';
    const outByDay = {};
    Object.entries(store || {}).forEach(([, byDay]) => {
        if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) return;
        Object.entries(byDay).forEach(([dateStr, rows]) => {
            if (!isValidIsoDateString(dateStr) || !Array.isArray(rows) || !rows.length) return;
            if (monthKey && dateStr.slice(0, 7) !== monthKey) return;
            if (!outByDay[dateStr]) outByDay[dateStr] = [];
            outByDay[dateStr].push(...rows);
        });
    });
    return fillEmptyCalendarDaysFromCumulative(journal, outByDay, '', options.markTouched, options);
}

export function cumulativeStoreSignature(store = {}) {
    return Object.keys(store || {}).sort().map((spreadsheetId) => {
        const byDay = store[spreadsheetId] && typeof store[spreadsheetId] === 'object' ? store[spreadsheetId] : {};
        const dates = Object.keys(byDay).filter((dateStr) => Array.isArray(byDay[dateStr]) && byDay[dateStr].length).sort();
        const rows = dates.reduce((count, dateStr) => count + byDay[dateStr].length, 0);
        return `${spreadsheetId}:${dates.length}:${rows}`;
    }).join('|');
}

export function mergeGoogleSheetTradesIntoJournal(journal = {}, outByDay = {}, spreadsheetId = '', options = {}) {
    const syncDayTotals = typeof options.syncDayTotals === 'function' ? options.syncDayTotals : () => {};
    const markTouched = typeof options.markTouched === 'function' ? options.markTouched : () => {};
    const warnInvalidDate = typeof options.warnInvalidDate === 'function' ? options.warnInvalidDate : () => {};
    const mode = options.mode === 'cumulative' ? 'cumulative' : 'main';
    const isCumulative = mode === 'cumulative';
    const tradeTypesSyncEnabled = options.tradeTypesSyncEnabled === true;
    const tradeTypesMonth = /^\d{4}-\d{2}$/.test(String(options.tradeTypesMonth || '')) ? String(options.tradeTypesMonth) : '';
    const deletedDates = [];
    const touchedDates = new Set();
    const sheetRowsStore = options.sheetRowsStore && typeof options.sheetRowsStore === 'object'
        ? options.sheetRowsStore
        : null;
    let matchedSheetRows = 0;
    let skippedSheetRows = 0;
    let importedSheetRows = 0;
    let syncedPnlDates = [];
    let filledCalendarDates = [];

    const previouslyManagedDates = new Set(
        sheetRowsStore && spreadsheetId && sheetRowsStore[spreadsheetId] && typeof sheetRowsStore[spreadsheetId] === 'object'
            ? Object.keys(sheetRowsStore[spreadsheetId])
            : []
    );

    importedSheetRows = storeSheetRows(sheetRowsStore, spreadsheetId, outByDay);

    if (!isCumulative) {
        Object.keys(journal).forEach((dateStr) => {
            const day = journal[dateStr];
            const trades = Array.isArray(day?.trades) ? day.trades : [];
            const removedTrades = trades.filter((trade) => isPureGoogleSheetTrade(trade, spreadsheetId));
            const nextTrades = trades.filter((trade) => !isPureGoogleSheetTrade(trade, spreadsheetId));
            if (nextTrades.length === trades.length) return;

            const clearSheetDerivedFondexx = nextTrades.length === 0 && fondexxLooksDerivedFromTrades(day.fondexx, removedTrades);
            day.trades = nextTrades;
            if (clearSheetDerivedFondexx) {
                day.fondexx = { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] };
                day.pnl = null;
                day.gross_pnl = null;
                day.commissions = null;
                day.locates = null;
            }
            syncDayTotals(dateStr, day);

            if (isDayEmptyAfterSheetCleanup(day)) {
                delete journal[dateStr];
                deletedDates.push(dateStr);
            } else {
                touchedDates.add(dateStr);
                markTouched(dateStr, day);
            }
        });
    }

    for (const dateStr of Object.keys(outByDay || {})) {
        if (!isValidIsoDateString(dateStr)) {
            warnInvalidDate(dateStr);
            continue;
        }
        const incoming = outByDay[dateStr] || [];
        if (!incoming.length) continue;
        const day = journal[dateStr];
        const prev = Array.isArray(day?.trades) ? day.trades : [];
        const kept = isCumulative ? prev.filter((trade) => !isPureGoogleSheetTrade(trade)) : prev.filter((trade) => !isPureGoogleSheetTrade(trade, spreadsheetId));
        if (!kept.length) {
            skippedSheetRows += incoming.length;
            continue;
        }
        const usedIndices = new Set();
        const merged = [...kept];
        let matchedCount = 0;

        incoming.forEach((trade) => {
            const matchIndex = findSheetMatchIndex(merged, trade, usedIndices);
            if (matchIndex >= 0) {
                if (isCumulative && tradeHasMainSheetContext(merged[matchIndex], spreadsheetId)) {
                    usedIndices.add(matchIndex);
                    skippedSheetRows++;
                    return;
                }
                merged[matchIndex] = enrichTradeWithSheet(merged[matchIndex], trade);
                annotateStoredSheetMatch(sheetRowsStore, spreadsheetId, dateStr, trade, matchIndex);
                usedIndices.add(matchIndex);
                matchedCount++;
                matchedSheetRows++;
            } else {
                skippedSheetRows++;
            }
        });

        if (!matchedCount) continue;
        day.trades = merged;
        syncDayTotals(dateStr, day);
        journal[dateStr] = day;
        touchedDates.add(dateStr);
        markTouched(dateStr, day);
    }

    if (!isCumulative) {
        const sheetMetrics = syncMainSheetMetricsToCalendar(journal, outByDay, spreadsheetId, (dateStr, day) => {
            touchedDates.add(dateStr);
            markTouched(dateStr, day);
        }, previouslyManagedDates, tradeTypesSyncEnabled, tradeTypesMonth);
        syncedPnlDates = sheetMetrics.syncedDates;
        sheetMetrics.deletedDates.forEach((dateStr) => {
            touchedDates.delete(dateStr);
            if (!deletedDates.includes(dateStr)) deletedDates.push(dateStr);
        });
    } else {
        filledCalendarDates = fillEmptyCalendarDaysFromCumulative(journal, outByDay, spreadsheetId, (dateStr, day) => {
            touchedDates.add(dateStr);
            markTouched(dateStr, day);
        }, {
            tradeTypesSyncEnabled,
            tradeTypesMonth,
            allowCreateMissingDays: options.allowCreateMissingDays !== false,
        });
    }

    return {
        deletedDates,
        touchedDates: [...touchedDates],
        importedSheetRows,
        matchedSheetRows,
        skippedSheetRows,
        syncedPnlDates,
        filledCalendarDates,
    };
}
