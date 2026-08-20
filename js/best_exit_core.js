const EXCLUDED_EXIT_RE = /stop(?:ped)?(?:\s*out|\s*loss)?|(?:^|\s)s\/?l(?:\s|$)|(?:^|\s)sl(?:\s|$)|стоп(?:ом|аут)?|стоп[-\s]?лосс|take(?:\s*profit)?|(?:^|\s)t\/?p(?:\s|$)|(?:^|\s)tp(?:\s|$)|target|profit\s*target|тейк(?:\s*профіт|\s*профит)?|таргет|ціль|цель/iu;

export function tradeExitReason(trade = {}) {
    return String(trade?.sheet?.exit || trade?.exitReason || trade?.closeReason || trade?.exitType || trade?.closeType || trade?.reason || '').trim();
}

export function isExcludedStopTakeExit(trade = {}) {
    return EXCLUDED_EXIT_RE.test(tradeExitReason(trade).toLocaleLowerCase('uk-UA').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' '));
}

export function normalizeTradeClock(value = '') {
    const match = String(value).match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
}

export function marketMinuteNY(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

export function bestExitWindowNY(value) {
    const marketMinute = marketMinuteNY(value);
    if (marketMinute == null || marketMinute < 570 || marketMinute >= 720) return '';
    const hour = Math.floor(marketMinute / 60);
    const minute = marketMinute % 60;
    const startMinute = Math.floor(minute / 10) * 10;
    const endMinute = startMinute + 9;
    return `${String(hour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}–${String(hour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`;
}

export function isTimeExitTrade(trade = {}) {
    return /(?:^|\s)(?:по\s*часу|за\s*часом|time)(?:\s|$)/iu.test(tradeExitReason(trade));
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
            if (!isShortTrade(trade) || isExcludedStopTakeExit(trade)) continue;
            const openedMinute = normalizeTradeClock(trade?.opened);
            const entryMinute = Math.max(570, openedMinute ?? 570);
            if (entryMinute >= 720) continue;
            const entryPrice = Number(trade?.entry || trade?.sheet?.entryPrice);
            const actualExitPrice = Number(trade?.exit || trade?.closePrice || trade?.sheet?.exitPrice);
            const qty = Math.abs(Number(trade?.qty || trade?.sheet?.qtyShares));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^[A-Z]{1,10}$/.test(String(trade?.symbol || '').toUpperCase())) continue;
            if (!(entryPrice > 0) || !(actualExitPrice > 0)) continue;
            rows.push({
                id: `${dateStr}:${tradeIndex}:${String(trade.symbol).toUpperCase()}`,
                tradeIndex,
                date: dateStr,
                symbol: String(trade.symbol).toUpperCase(),
                entryMinute,
                entryPrice,
                actualExitPrice,
                exitReason: tradeExitReason(trade),
                qty: qty > 0 ? qty : null,
                tradeIdentity: { symbol: trade.symbol, opened: trade.opened || trade.entryTime || trade.time || '', entry: entryPrice, exit: actualExitPrice, qty: qty > 0 ? qty : null },
            });
        }
    }
    return rows;
}

export function attachBestExitResult(trade, market = {}) {
    const low = Number(market.low);
    const lowMinuteNY = marketMinuteNY(market.lowTime);
    if (!trade || !(low > 0) || lowMinuteNY == null || lowMinuteNY < 570 || lowMinuteNY >= 720) return null;
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
        capturedPerShare: actualPerShare,
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
    const bestMove = numeric('perShare').filter((value) => value > 0);
    const capturedMove = valid.filter((row) => Number(row.perShare) > 0 && Number.isFinite(Number(row.capturedPerShare))).map((row) => Math.max(0, Math.min(Number(row.perShare), Number(row.capturedPerShare))));
    return {
        count: valid.length,
        bestPnl: bestPnl.length ? sum(bestPnl) : null,
        extraPnl: extraPnl.length ? sum(extraPnl) : null,
        avgCapturePct: bestMove.length ? sum(capturedMove) / sum(bestMove) * 100 : (capture.length ? sum(capture) / capture.length : null),
        rows: [...valid].sort((a, b) => (Number(b.extraPnl) || 0) - (Number(a.extraPnl) || 0)),
    };
}
