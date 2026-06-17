import {
    enrichTradeWithSheet,
    findSheetMatchIndex,
    isValidIsoDateString,
} from './sheet_sync_core.js';
import { isPureGoogleSheetTrade } from './trade_filters.js';

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

export function mergeGoogleSheetTradesIntoJournal(journal = {}, outByDay = {}, spreadsheetId = '', options = {}) {
    const syncDayTotals = typeof options.syncDayTotals === 'function' ? options.syncDayTotals : () => {};
    const markTouched = typeof options.markTouched === 'function' ? options.markTouched : () => {};
    const warnInvalidDate = typeof options.warnInvalidDate === 'function' ? options.warnInvalidDate : () => {};
    const deletedDates = [];
    const touchedDates = new Set();
    const sheetRowsStore = options.sheetRowsStore && typeof options.sheetRowsStore === 'object'
        ? options.sheetRowsStore
        : null;
    let matchedSheetRows = 0;
    let skippedSheetRows = 0;
    let importedSheetRows = 0;

    if (sheetRowsStore && spreadsheetId) {
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
    }

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

    for (const dateStr of Object.keys(outByDay || {})) {
        if (!isValidIsoDateString(dateStr)) {
            warnInvalidDate(dateStr);
            continue;
        }
        const incoming = outByDay[dateStr] || [];
        if (!incoming.length) continue;
        const day = journal[dateStr];
        const prev = Array.isArray(day?.trades) ? day.trades : [];
        const kept = prev.filter((trade) => !isPureGoogleSheetTrade(trade, spreadsheetId));
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

    return {
        deletedDates,
        touchedDates: [...touchedDates],
        importedSheetRows,
        matchedSheetRows,
        skippedSheetRows,
    };
}
