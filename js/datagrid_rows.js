import { isPureGoogleSheetTrade } from './trade_filters.js';

function isDayKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function timeFromOpened(opened) {
    if (!opened || typeof opened !== 'string') return '';
    const t = opened.trim();
    const space = t.indexOf(' ');
    return space > 0 ? t.slice(space + 1).trim().split('.')[0] : t;
}

function sheetSourceHasRows(byDay) {
    return !!byDay && typeof byDay === 'object'
        && Object.values(byDay).some((rows) => Array.isArray(rows) && rows.length > 0);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function sheetVisibleSinceDate(referenceDate, visibleMonths = 2) {
    if (!(referenceDate instanceof Date) || Number.isNaN(referenceDate.getTime())) return '';
    const months = Math.max(1, Number(visibleMonths) || 2);
    const firstVisibleMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - months + 1, 1);
    return `${firstVisibleMonth.getFullYear()}-${pad2(firstVisibleMonth.getMonth() + 1)}-01`;
}

export function pickSheetRowsSource(sheetRows = {}, preferredSpreadsheetId = '') {
    const store = sheetRows && typeof sheetRows === 'object' ? sheetRows : {};
    if (preferredSpreadsheetId && sheetSourceHasRows(store[preferredSpreadsheetId])) {
        return { spreadsheetId: preferredSpreadsheetId, byDay: store[preferredSpreadsheetId] };
    }
    const keys = Object.keys(store).filter((key) => sheetSourceHasRows(store[key]));
    const spreadsheetId = keys[keys.length - 1] || '';
    return spreadsheetId ? { spreadsheetId, byDay: store[spreadsheetId] } : null;
}

function flattenSheetRows(byDay = {}, referenceDate = null) {
    const visibleSince = sheetVisibleSinceDate(referenceDate, 2);
    const flat = [];
    Object.keys(byDay)
        .filter(isDayKey)
        .filter((dateStr) => !visibleSince || dateStr >= visibleSince)
        .sort()
        .forEach((dateStr) => {
            const rows = Array.isArray(byDay[dateStr]) ? byDay[dateStr] : [];
            rows.forEach((row, idx) => {
                const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
                flat.push({
                    dateStr,
                    source: 'sheet',
                    trade: {
                        symbol: row?.symbol || '',
                        opened: row?.opened || '',
                        net: Number(row?.net) || 0,
                        gross: Number(row?.gross) || 0,
                        comm: Number(row?.comm) || 0,
                        type: row?.type || sheet.tradeType || '',
                        entry: sheet.entryPrice ?? row?.entry ?? 0,
                        exit: row?.exit ?? 0,
                        stop: sheet.stopPrice ?? row?.stop,
                        qty: sheet.qtyShares ?? row?.qty ?? 0,
                        sheet,
                    },
                    tradeIndex: Number.isInteger(Number(sheet.matchedTradeIndex)) ? Number(sheet.matchedTradeIndex) : -1,
                    sheetRowIndex: sheet.sheetRow ?? idx,
                });
            });
        });
    flat.sort((a, b) => {
        const dc = a.dateStr.localeCompare(b.dateStr);
        if (dc !== 0) return dc;
        return String(timeFromOpened(a.trade.opened)).localeCompare(String(timeFromOpened(b.trade.opened)));
    });
    return flat;
}

function flattenRealTrades(journal = {}) {
    const flat = [];
    Object.keys(journal || {}).forEach((dateStr) => {
        if (!isDayKey(dateStr)) return;
        const trades = Array.isArray(journal[dateStr]?.trades) ? journal[dateStr].trades : [];
        trades.forEach((trade, tradeIndex) => {
            if (isPureGoogleSheetTrade(trade)) return;
            flat.push({ dateStr, source: 'trades', trade, tradeIndex });
        });
    });
    flat.sort((a, b) => {
        const dc = a.dateStr.localeCompare(b.dateStr);
        if (dc !== 0) return dc;
        return String(timeFromOpened(a.trade?.opened)).localeCompare(String(timeFromOpened(b.trade?.opened)));
    });
    return flat;
}

export function collectDatagridRows(appData = {}, preferredSpreadsheetId = '', referenceDate = null) {
    const sheetSource = pickSheetRowsSource(appData.sheetRows, preferredSpreadsheetId);
    if (sheetSource) {
        return {
            source: 'sheet',
            spreadsheetId: sheetSource.spreadsheetId,
            rows: flattenSheetRows(sheetSource.byDay, referenceDate),
        };
    }
    return {
        source: 'trades',
        spreadsheetId: '',
        rows: flattenRealTrades(appData.journal || {}),
    };
}
