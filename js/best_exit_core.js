const TIME_EXIT_RE = /(?:^|\s)(?:по\s*часу|за\s*часом|time)(?:\s|$)/iu;

export function normalizeTradeClock(value = '') {
    const match = String(value).match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
}

export function isTimeExitTrade(trade = {}) {
    return TIME_EXIT_RE.test(String(trade?.sheet?.exit || trade?.exitReason || trade?.closeReason || '').trim());
}

export function isShortTrade(trade = {}) {
    const values = [
        trade?.sheet?.fondexxType,
        trade?.direction,
        trade?.side,
        trade?.type,
    ].map((value) => String(value || '').toLocaleLowerCase('uk-UA'));
    return values.some((value) => /short|шорт/.test(value));
}

export function collectTimedShortTrades(journal = {}, allowedDates = null) {
    const rows = [];
    for (const [dateStr, day] of Object.entries(journal || {})) {
        if (allowedDates instanceof Set && !allowedDates.has(dateStr)) continue;
        for (const [tradeIndex, trade] of (day?.trades || []).entries()) {
            if (!isShortTrade(trade) || !isTimeExitTrade(trade)) continue;
            const openedMinute = normalizeTradeClock(trade?.opened);
            const entryMinute = Math.max(570, openedMinute ?? 570);
            if (entryMinute >= 720) continue;
            const entryPrice = Number(trade?.entry || trade?.sheet?.entryPrice);
            const qty = Math.abs(Number(trade?.qty || trade?.sheet?.qtyShares));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^[A-Z]{1,10}$/.test(String(trade?.symbol || '').toUpperCase())) continue;
            if (!(entryPrice > 0)) continue;
            rows.push({
                id: `${dateStr}:${tradeIndex}:${String(trade.symbol).toUpperCase()}`,
                date: dateStr,
                symbol: String(trade.symbol).toUpperCase(),
                entryMinute,
                entryPrice,
                actualExitPrice: Number(trade?.exit) || null,
                qty: qty > 0 ? qty : null,
            });
        }
    }
    return rows;
}

export function attachBestExitResult(trade, market = {}) {
    const low = Number(market.low);
    if (!trade || !(low > 0)) return null;
    const perShare = trade.entryPrice - low;
    const actualPerShare = Number(trade.actualExitPrice) > 0
        ? trade.entryPrice - Number(trade.actualExitPrice)
        : null;
    return {
        ...trade,
        low,
        lowTime: market.lowTime || '',
        perShare,
        bestPnl: trade.qty ? perShare * trade.qty : null,
        actualPnl: trade.qty && actualPerShare != null ? actualPerShare * trade.qty : null,
        extraPnl: trade.qty && actualPerShare != null ? (perShare - actualPerShare) * trade.qty : null,
        capturePct: actualPerShare != null && perShare > 0
            ? Math.max(0, Math.min(100, actualPerShare / perShare * 100))
            : null,
    };
}

export function summarizeBestExits(rows = []) {
    const valid = rows.filter(Boolean);
    const numeric = (key) => valid.map((row) => Number(row[key])).filter(Number.isFinite);
    const sum = (values) => values.reduce((total, value) => total + value, 0);
    const bestPnl = numeric('bestPnl');
    const extraPnl = numeric('extraPnl');
    const capture = numeric('capturePct');
    return {
        count: valid.length,
        bestPnl: bestPnl.length ? sum(bestPnl) : null,
        extraPnl: extraPnl.length ? sum(extraPnl) : null,
        avgCapturePct: capture.length ? sum(capture) / capture.length : null,
        rows: [...valid].sort((a, b) => (Number(b.extraPnl) || 0) - (Number(a.extraPnl) || 0)),
    };
}
