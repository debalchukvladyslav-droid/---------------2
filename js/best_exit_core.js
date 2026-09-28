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

function sheetProfit(row = {}) {
    const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
    if (sheet.sheetNet != null && sheet.sheetNet !== '' && Number.isFinite(Number(sheet.sheetNet))) return Number(sheet.sheetNet);
    if (row?.net != null && row.net !== '' && Number(row.net) !== 0 && Number.isFinite(Number(row.net))) return Number(row.net);
    return null;
}

function shortExitFromProfit(entryPrice, qty, profit) {
    const shares = Math.abs(Number(qty));
    if (!(entryPrice > 0) || !(shares > 0) || !Number.isFinite(Number(profit))) return null;
    const exitPrice = entryPrice - Number(profit) / shares;
    return exitPrice > 0 ? exitPrice : null;
}

function consolidationCents(value) {
    const raw = String(value ?? '').replace(/\s/g, '').replace(',', '.');
    if (!/[0-9]/.test(raw)) return null;
    const cents = Number(raw.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(cents) ? cents : null;
}

function stopPriceFor(entryPrice, sheet = {}) {
    const cents = consolidationCents(sheet?.consolidateCents);
    if (cents != null && cents > 0 && entryPrice > 0) return Math.round((entryPrice + cents / 100) * 10000) / 10000;
    if (Number(sheet?.stopPrice) > 0) return Number(sheet.stopPrice);
    return null;
}

export function shortConsolidationStopLoss({ entryPrice, consolidateCents: centsValue, stopPrice, qty } = {}) {
    const shares = Math.abs(Number(qty));
    const cents = consolidationCents(centsValue);
    const entry = Number(entryPrice);
    const stop = Number(stopPrice);
    const riskPerShare = cents != null && cents > 0
        ? cents / 100
        : (entry > 0 && stop > entry ? stop - entry : null);
    if (!(shares > 0) || !(riskPerShare > 0)) return null;
    const resolvedCents = cents != null && cents > 0 ? cents : Math.round(riskPerShare * 10000) / 100;
    const resolvedStop = stop > entry ? stop : (entry > 0 ? Math.round((entry + riskPerShare) * 10000) / 10000 : null);
    return {
        cents: resolvedCents,
        shares,
        stopPrice: resolvedStop,
        loss: Number((-(riskPerShare * shares)).toFixed(2)),
    };
}

function samePrice(left, right) {
    return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) < 0.0001;
}

function tradeEntryPrice(trade = {}) {
    const value = Number(trade?.entry || trade?.sheet?.entryPrice);
    return value > 0 ? value : null;
}

function tradeExitPrice(trade = {}) {
    const value = Number(trade?.exit || trade?.closePrice || trade?.sheet?.exitPrice);
    return value > 0 ? value : null;
}

function isShortStoppedOut(trade = {}) {
    const entry = tradeEntryPrice(trade);
    const exit = tradeExitPrice(trade);
    if (entry && exit) {
        if (exit <= entry) return false;
        const stop = stopPriceFor(entry, trade?.sheet);
        if (stop > entry) return exit + 0.01 >= stop;
        const opened = normalizeTradeClock(trade?.opened);
        const closed = normalizeTradeClock(trade?.closed || trade?.exited || trade?.exitTime || trade?.closeTime || '');
        if (opened != null && closed != null) {
            const held = closed >= opened ? closed - opened : closed + 1440 - opened;
            if (held <= 8) return true;
        }
    }
    return isExcludedStopTakeExit(trade) && !isTimeExitTrade(trade);
}

function isQuickStopFill(trade = {}) {
    if (!isShortStoppedOut(trade)) return false;
    const opened = normalizeTradeClock(trade?.opened);
    const closed = normalizeTradeClock(trade?.closed || trade?.exited || trade?.exitTime || trade?.closeTime || '');
    if (opened == null || closed == null) return !isTimeExitTrade(trade);
    const held = closed >= opened ? closed - opened : closed + 1440 - opened;
    return held <= 8;
}

function indexedShorts(trades = [], symbol = '') {
    const wanted = String(symbol || '').toUpperCase();
    return (Array.isArray(trades) ? trades : []).map((trade, tradeIndex) => ({ trade, tradeIndex })).filter(({ trade }) => {
        if (!isShortTrade(trade)) return false;
        return !wanted || String(trade?.symbol || '').toUpperCase() === wanted;
    });
}

function isConfirmedTimeExit(trade = {}) {
    if (!isTimeExitTrade(trade)) return false;
    if (isExcludedStopTakeExit(trade)) return false;
    return true;
}

function chooseTimeExitFills(trades = []) {
    const labeled = trades.filter(({ trade }) => isConfirmedTimeExit(trade));
    const live = labeled.filter(({ trade }) => !isQuickStopFill(trade));
    if (live.length) return live;
    return labeled;
}

function listSheetExitRows(sheetRows = {}, allowedDates = null) {
    const store = sheetRows && typeof sheetRows === 'object' ? sheetRows : {};
    const rows = [];
    Object.values(store).forEach((byDay) => {
        if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) return;
        Object.entries(byDay).forEach(([dateStr, dayRows]) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || (allowedDates instanceof Set && !allowedDates.has(dateStr))) return;
            (Array.isArray(dayRows) ? dayRows : []).forEach((row, index) => {
                const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
                const symbol = String(row?.symbol || '').toUpperCase();
                if (!/^[A-Z]{1,10}$/.test(symbol)) return;
                rows.push({ date: dateStr, symbol, entryPrice: Number(sheet.entryPrice ?? row?.entry), sheet, row, index });
            });
        });
    });
    return rows;
}

function sheetRowMatchRank(sheetRow, trade) {
    if (!sheetRowMatchesTrade(sheetRow, trade)) return 0;
    const entry = tradeEntryPrice(trade);
    if (entry && sheetRow.entryPrice > 0 && samePrice(entry, sheetRow.entryPrice)) return 2;
    return 1;
}

function sheetRowMatchesTrade(sheetRow, trade) {
    const entry = tradeEntryPrice(trade);
    if (entry && sheetRow.entryPrice > 0 && samePrice(entry, sheetRow.entryPrice)) return true;
    const profit = sheetProfit(sheetRow.row);
    const net = tradeResultValue(trade);
    return profit != null && net != null && Math.abs(net - profit) <= Math.max(5, Math.abs(profit) * 0.08);
}

function excelConfirmsTimeExit(trade, excelRows = []) {
    if (!excelRows.length) return isConfirmedTimeExit(trade);
    const timeRows = excelRows.filter((row) => isConfirmedTimeExit({ sheet: row.sheet }));
    const closedRows = excelRows.filter((row) => isExcludedStopTakeExit({ sheet: row.sheet }) && !isConfirmedTimeExit({ sheet: row.sheet }));
    const bestTime = timeRows.reduce((best, row) => Math.max(best, sheetRowMatchRank(row, trade)), 0);
    const bestClosed = closedRows.reduce((best, row) => Math.max(best, sheetRowMatchRank(row, trade)), 0);
    if (bestClosed > bestTime) return false;
    if (bestTime > 0) return true;
    if (!timeRows.length) return false;
    return false;
}

function listSheetTimeExits(sheetRows = {}, allowedDates = null) {
    const store = sheetRows && typeof sheetRows === 'object' ? sheetRows : {};
    const rows = [];
    const seen = new Set();
    Object.values(store).forEach((byDay) => {
        if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) return;
        Object.entries(byDay).forEach(([dateStr, dayRows]) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || (allowedDates instanceof Set && !allowedDates.has(dateStr))) return;
            (Array.isArray(dayRows) ? dayRows : []).forEach((row, index) => {
                const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
                const trade = { ...row, sheet };
                if (!isConfirmedTimeExit(trade)) return;
                const symbol = String(row?.symbol || '').toUpperCase();
                const entryPrice = Number(sheet.entryPrice ?? row?.entry);
                if (!/^[A-Z]{1,10}$/.test(symbol) || !(entryPrice > 0)) return;
                const key = `${dateStr}|${symbol}|${entryPrice}|${sheet.sheetRow ?? index}|${sheetProfit(row) ?? ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                rows.push({ date: dateStr, symbol, entryPrice, sheet, row, index });
            });
        });
    });
    return rows;
}

function timedRowFromTrade(dateStr, tradeIndex, trade, { marketOpenStopsOnly }) {
    const exitReason = tradeExitReason(trade);
    const isMarketOpenStop = isMarketOpenStopTrade(trade, dateStr);
    if (!isShortTrade(trade)) return null;
    if (marketOpenStopsOnly ? !isMarketOpenStop : !isTimeExitTrade(trade)) return null;
    const openedMinute = normalizeTradeClock(trade?.opened);
    const exitMinute = normalizeTradeClock(
        trade?.closed || trade?.exited || trade?.exitTime || trade?.closeTime || trade?.sheet?.exitTime || ''
    );
    const entryMinute = Math.max(570, openedMinute ?? 570);
    const entryTimeKnown = openedMinute != null;
    const stopEntryMinute = entryTimeKnown ? Math.min(719, Math.max(240, openedMinute)) : null;
    if (entryMinute >= 720) return null;
    const entryPrice = Number(trade?.entry || trade?.sheet?.entryPrice);
    const actualExitPrice = Number(trade?.exit || trade?.closePrice || trade?.sheet?.exitPrice);
    const qty = Math.abs(Number(trade?.qty || trade?.sheet?.qtyShares));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^[A-Z]{1,10}$/.test(String(trade?.symbol || '').toUpperCase())) return null;
    if (!(entryPrice > 0) || !(actualExitPrice > 0)) return null;
    return {
        id: `${dateStr}:${tradeIndex}:${String(trade.symbol).toUpperCase()}`,
        tradeIndex,
        date: dateStr,
        symbol: String(trade.symbol).toUpperCase(),
        entryMinute,
        stopEntryMinute,
        entryTimeKnown,
        exitMinute,
        entryPrice,
        actualExitPrice,
        exitReason,
        isMarketOpenStop,
        qty: qty > 0 ? qty : null,
        consolidateCents: consolidationCents(trade?.sheet?.consolidateCents),
        stopPrice: stopPriceFor(entryPrice, trade?.sheet),
        tradeIdentity: { symbol: trade.symbol, opened: trade.opened || trade.entryTime || trade.time || '', entry: entryPrice, exit: actualExitPrice, qty: qty > 0 ? qty : null },
    };
}

export function collectTimedShortTrades(journal = {}, allowedDates = null, { marketOpenStopsOnly = false, sheetRows = null } = {}) {
    const rows = [];
    const journalByDay = new Map();
    const excelRows = sheetRows ? listSheetExitRows(sheetRows, allowedDates) : [];
    for (const [dateStr, day] of Object.entries(journal || {})) {
        if (allowedDates instanceof Set && !allowedDates.has(dateStr)) continue;
        const trades = day?.trades || [];
        journalByDay.set(dateStr, trades);
        if (marketOpenStopsOnly) {
            trades.forEach((trade, tradeIndex) => {
                const row = timedRowFromTrade(dateStr, tradeIndex, trade, { marketOpenStopsOnly });
                if (row) rows.push(row);
            });
            continue;
        }
        const bySymbol = new Map();
        indexedShorts(trades).forEach((item) => {
            const symbol = String(item.trade?.symbol || '').toUpperCase();
            const list = bySymbol.get(symbol) || [];
            list.push(item);
            bySymbol.set(symbol, list);
        });
        bySymbol.forEach((list) => {
            const symbol = String(list[0]?.trade?.symbol || '').toUpperCase();
            const excel = excelRows.filter((row) => row.date === dateStr && row.symbol === symbol);
            chooseTimeExitFills(list).forEach((fill) => {
                if (sheetRows && !excelConfirmsTimeExit(fill.trade, excel)) return;
                const row = timedRowFromTrade(dateStr, fill.tradeIndex, fill.trade, { marketOpenStopsOnly: false });
                if (row) rows.push(row);
            });
        });
    }
    if (marketOpenStopsOnly || !sheetRows) return rows;

    const sheetTimes = listSheetTimeExits(sheetRows, allowedDates);
    const daysWithSheetTime = new Set(sheetTimes.map((row) => `${row.date}|${row.symbol}`));
    const kept = rows.filter((row) => !daysWithSheetTime.has(`${row.date}|${row.symbol}`));
    const replaced = rows.filter((row) => daysWithSheetTime.has(`${row.date}|${row.symbol}`));
    const usedTrades = new Set();
    const addedKeys = new Set();
    sheetTimes.forEach((sheetTime) => {
        const trades = journalByDay.get(sheetTime.date) || [];
        const profit = sheetProfit(sheetTime.row);
        const excel = excelRows.filter((row) => row.date === sheetTime.date && row.symbol === sheetTime.symbol);
        const available = indexedShorts(trades, sheetTime.symbol).filter(({ tradeIndex }) => !usedTrades.has(`${sheetTime.date}:${tradeIndex}`));
        const borrow = available
            .filter(({ trade }) => excelConfirmsTimeExit(trade, excel) && sheetRowMatchRank(sheetTime, trade) > 0 && !isQuickStopFill(trade))
            .sort((left, right) => sheetRowMatchRank(sheetTime, right.trade) - sheetRowMatchRank(sheetTime, left.trade))[0] || null;
        if (borrow) usedTrades.add(`${sheetTime.date}:${borrow.tradeIndex}`);
        const entryPrice = tradeEntryPrice(borrow?.trade) || sheetTime.entryPrice;
        const qty = Math.abs(Number(borrow?.trade?.qty || sheetTime.sheet.qtyShares || 0));
        const actualExitPrice = tradeExitPrice(borrow?.trade)
            || shortExitFromProfit(entryPrice, qty, borrow ? tradeResultValue(borrow.trade) : profit);
        const opened = borrow?.trade?.opened || borrow?.trade?.entryTime || '';
        const synthetic = {
            symbol: sheetTime.symbol,
            type: borrow?.trade?.type || sheetTime.row?.type || 'Short',
            opened,
            entry: entryPrice,
            exit: actualExitPrice,
            qty,
            sheet: {
                ...sheetTime.sheet,
                consolidateCents: sheetTime.sheet.consolidateCents ?? borrow?.trade?.sheet?.consolidateCents,
                exit: 'по часу',
            },
        };
        const row = timedRowFromTrade(sheetTime.date, borrow?.tradeIndex ?? sheetTime.index, synthetic, { marketOpenStopsOnly: false });
        if (!row) return;
        kept.push(row);
        addedKeys.add(`${row.date}|${row.symbol}`);
    });
    replaced.forEach((row) => {
        if (!addedKeys.has(`${row.date}|${row.symbol}`)) kept.push(row);
    });
    return kept;
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
