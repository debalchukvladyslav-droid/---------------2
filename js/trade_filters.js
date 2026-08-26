import { parseDecimalInput } from './utils.js';

export function isGoogleSheetTrade(trade) {
    return !!(trade?.sheet && typeof trade.sheet === 'object' && trade.sheet.source === 'google');
}

export function isPureGoogleSheetTrade(trade, spreadsheetId = '') {
    if (!isGoogleSheetTrade(trade) || trade.sheet?.matchedBy) return false;
    return !spreadsheetId || trade.sheet?.spreadsheetId === spreadsheetId;
}

export function visibleTradeRows(trades = []) {
    return (Array.isArray(trades) ? trades : [])
        .map((trade, index) => ({ trade, index }))
        .filter(({ trade }) => !isPureGoogleSheetTrade(trade));
}

export function visibleTradeRowsForDate(journal = {}, dateStr = '') {
    const trades = Array.isArray(journal?.[dateStr]?.trades) ? journal[dateStr].trades : [];
    return visibleTradeRows(trades);
}

const identityText = (value) => String(value ?? '').trim().toUpperCase();
const identityNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function findTradeIndexByIdentity(trades = [], identity = {}) {
    const symbol = identityText(identity.symbol);
    if (!symbol) return -1;
    const opened = identityText(identity.opened);
    const entry = identityNumber(identity.entry);
    const exit = identityNumber(identity.exit);
    const qty = identityNumber(identity.qty);
    const candidates = (Array.isArray(trades) ? trades : []).map((trade, index) => {
        if (identityText(trade?.symbol || trade?.ticker) !== symbol || isPureGoogleSheetTrade(trade)) return null;
        let score = 1;
        if (opened && identityText(trade?.opened || trade?.entryTime || trade?.time) === opened) score += 100;
        if (entry != null && identityNumber(trade?.entry || trade?.sheet?.entryPrice) === entry) score += 20;
        if (exit != null && identityNumber(trade?.exit || trade?.closePrice || trade?.sheet?.exitPrice) === exit) score += 20;
        if (qty != null && Math.abs(identityNumber(trade?.qty || trade?.shares || trade?.sheet?.qtyShares) || 0) === Math.abs(qty)) score += 10;
        return { index, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index);
    return candidates[0]?.index ?? -1;
}

function sourceHasMoney(source) {
    return !!(
        Number(source?.gross)
        || Number(source?.net)
        || Number(source?.comm)
        || Number(source?.locates)
    );
}

function tradeMoneyTotals(trades = []) {
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

export function isSheetOnlyPnl(day = {}) {
    const trades = Array.isArray(day.trades) ? day.trades : [];
    if (!trades.length || !trades.every((trade) => isPureGoogleSheetTrade(trade))) return false;
    if (sourceHasMoney(day.ppro)) return false;
    const totals = tradeMoneyTotals(trades);
    return almostEqualMoney(day.fondexx?.gross, totals.gross)
        && almostEqualMoney(day.fondexx?.net, totals.net)
        && almostEqualMoney(day.fondexx?.comm, totals.comm);
}

export function getEffectiveDayPnl(day = {}) {
    if (isSheetOnlyPnl(day)) return null;
    const net = parseDecimalInput(day.pnl);
    if (net !== null) return net;
    return parseDecimalInput(day.gross_pnl);
}

export function hasImportedNetPnl(day = {}) {
    const fondexxSource = String(day?.fondexxSource || '').trim();
    const pproSource = String(day?.pproSource || '').trim();
    return fondexxSource === 'summary-by-date'
        || fondexxSource === 'fondexx-report'
        || fondexxSource === 'trades-report'
        || pproSource === 'ppro-total-report';
}

export function getCalendarDayResult(day = {}) {
    if (isSheetOnlyPnl(day)) return { value: null, kind: 'none' };

    const net = parseDecimalInput(day.pnl);
    if (net !== null) return { value: net, kind: 'net' };

    const gross = parseDecimalInput(day.gross_pnl);
    if (gross !== null) return { value: gross, kind: 'gross' };

    return { value: null, kind: 'none' };
}
