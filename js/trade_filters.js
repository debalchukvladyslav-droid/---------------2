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
    const pnl = parseFloat(day.pnl);
    return Number.isFinite(pnl) ? pnl : null;
}
