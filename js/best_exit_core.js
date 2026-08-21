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

function tradeDatePart(value = '') {
    return String(value).match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || '';
}

export function tradeResultValue(trade = {}) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const candidates = [trade?.net, trade?.pnl, trade?.profit, trade?.gross, sheet.sheetNet, sheet.pnl, sheet.profit];
    for (const value of candidates) {
        if (value === '' || value === null || value === undefined) continue;
        const parsed = Number(String(value).replace(',', '.'));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

export function isMarketOpenStopTrade(trade = {}, dateStr = '') {
    if (!(tradeResultValue(trade) < 0)) return false;
    const opened = trade?.opened || trade?.entryTime || trade?.openTime || '';
    const closed = trade?.closed || trade?.exited || trade?.exitTime || trade?.closeTime || '';
    const openedMinute = normalizeTradeClock(opened);
    const closedMinute = normalizeTradeClock(closed);
    if (openedMinute == null || closedMinute == null) return false;

    const openedDate = tradeDatePart(opened);
    const closedDate = tradeDatePart(closed);
    const openedBeforeMarket = openedDate && dateStr
        ? openedDate < dateStr || (openedDate === dateStr && openedMinute < 570)
        : openedMinute < 570;
    const closedAfterMarket = closedDate && dateStr
        ? closedDate > dateStr || (closedDate === dateStr && closedMinute >= 570)
        : closedMinute >= 570;
    return openedBeforeMarket && closedAfterMarket;
}

export function collectTimedShortTrades(journal = {}, allowedDates = null, { marketOpenStopsOnly = false } = {}) {
    const rows = [];
    for (const [dateStr, day] of Object.entries(journal || {})) {
        if (allowedDates instanceof Set && !allowedDates.has(dateStr)) continue;
        for (const [tradeIndex, trade] of (day?.trades || []).entries()) {
            const exitReason = tradeExitReason(trade);
            const isMarketOpenStop = isMarketOpenStopTrade(trade, dateStr);
            if (!isShortTrade(trade)) continue;
            if (marketOpenStopsOnly ? !isMarketOpenStop : (!exitReason || isExcludedStopTakeExit(trade))) continue;
            const openedMinute = normalizeTradeClock(trade?.opened);
            const exitMinute = normalizeTradeClock(
                trade?.closed || trade?.exited || trade?.exitTime || trade?.closeTime || trade?.sheet?.exitTime || ''
            );
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
                exitMinute,
                entryPrice,
                actualExitPrice,
                exitReason,
                isMarketOpenStop,
                qty: qty > 0 ? qty : null,
                tradeIdentity: { symbol: trade.symbol, opened: trade.opened || trade.entryTime || trade.time || '', entry: entryPrice, exit: actualExitPrice, qty: qty > 0 ? qty : null },
            });
        }
    }
    return rows;
}

export function buildExitTimeCaptureSeries(rows = []) {
    const buckets = new Map();
    rows.forEach((row) => {
        const minute = Number(row?.exitMinute);
        const capturePct = Number(row?.capturePct);
        if (row?.exitMinute == null || row?.capturePct == null || !Number.isFinite(minute) || minute < 570 || minute >= 720 || !Number.isFinite(capturePct)) return;
        const bucketMinute = Math.floor(minute / 10) * 10;
        const bucket = buckets.get(bucketMinute) || { minute: bucketMinute, total: 0, count: 0 };
        bucket.total += Math.max(0, Math.min(100, capturePct));
        bucket.count += 1;
        buckets.set(bucketMinute, bucket);
    });
    return [...buckets.values()]
        .sort((a, b) => a.minute - b.minute)
        .map((bucket) => ({
            minute: bucket.minute,
            label: `${String(Math.floor(bucket.minute / 60)).padStart(2, '0')}:${String(bucket.minute % 60).padStart(2, '0')}`,
            capturePct: bucket.total / bucket.count,
            count: bucket.count,
        }));
}

export function buildLowTimeFrequencySeries(rows = [], { minMinute = 570 } = {}) {
    const buckets = new Map();
    let total = 0;
    rows.forEach((row) => {
        const minute = marketMinuteNY(row?.lowTime);
        if (minute == null || minute < Math.max(570, Number(minMinute) || 570) || minute >= 720) return;
        const bucketMinute = Math.floor(minute / 10) * 10;
        buckets.set(bucketMinute, (buckets.get(bucketMinute) || 0) + 1);
        total += 1;
    });
    if (!total) return [];
    return [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([minute, count]) => ({
            minute,
            label: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
            percent: count / total * 100,
            count,
            total,
        }));
}

export function attachBestExitResult(trade, market = {}) {
    if (!trade || !market || typeof market !== 'object') return null;
    const low = Number(market.low);
    const lowMinuteNY = marketMinuteNY(market.lowTime);
    if (!(low > 0) || lowMinuteNY == null || lowMinuteNY < 570 || lowMinuteNY >= 720) return null;
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

export function calculateShortExitComparison({ entryPrice, actualExitPrice, selectedPrice, qty } = {}) {
    const entry = Number(entryPrice);
    const actualExit = Number(actualExitPrice);
    const selectedExit = Number(selectedPrice);
    const shares = Math.abs(Number(qty));
    if (!(entry > 0) || !(actualExit > 0) || !(selectedExit > 0) || !(shares > 0)) return null;
    const actualGross = Number(((entry - actualExit) * shares).toFixed(2));
    const selectedGross = Number(((entry - selectedExit) * shares).toFixed(2));
    return { actualGross, selectedGross, difference: Number((selectedGross - actualGross).toFixed(2)) };
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
