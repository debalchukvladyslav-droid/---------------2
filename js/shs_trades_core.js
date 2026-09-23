import { reconcileDayLocates } from './parser_utils.js';

const DEAD_ORDER = new Set(['cancelled', 'canceled', 'rejected', 'declined', 'expired']);
const ANNOTATION_KEYS = ['sheet', 'screenshots', 'screenshotPath', 'exitReason', 'notes', 'comment', 'kf', 'stopReview', 'review'];

export function nicksMatch(left, right) {
    const a = String(left || '').trim().toUpperCase();
    const b = String(right || '').trim().toUpperCase();
    return Boolean(a) && a === b;
}

export function normalizeShsTicker(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/\.(NQ|NY|AM|AX|OQ|PK)$/i, '');
}

export function dayHasPriorityOverSheet(day) {
    return day?.pproSource === 'ppro-total-report' || day?.fondexxSource === 'shs-bot';
}

function roundMoney(value) {
    return Number((Number(value) || 0).toFixed(2));
}

function pad(value) {
    return String(value).padStart(2, '0');
}

export function newYorkStamp(iso) {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(dt).map((part) => [part.type, part.value]));
    if (!parts.year || !parts.month || !parts.day) return null;
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
        epoch: dt.getTime(),
    };
}

function heldBetween(opened, closed) {
    const toSec = (clock) => {
        const [h, m, s] = String(clock || '').split(':').map(Number);
        if (![h, m, s].every(Number.isFinite)) return 0;
        return h * 3600 + m * 60 + s;
    };
    let sec = toSec(closed) - toSec(opened);
    if (sec < 0) sec += 86400;
    return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

function orderNickMatches(order, nick) {
    return nicksMatch(order?.trader, nick) || nicksMatch(order?.login_name, nick) || nicksMatch(order?.real_user, nick);
}

function locateNickMatches(row, nick) {
    return nicksMatch(row?.trader, nick) || nicksMatch(row?.real_user, nick);
}

function classifyFill(order) {
    const effect = String(order?.position_effect || '').toLowerCase();
    const side = String(order?.side || '').toLowerCase();
    const closing = /close|cover|flatten/.test(effect);
    const opening = /open/.test(effect) && !closing;
    const shortSide = /short|sell/.test(side);
    const longSide = /long|^buy$|cover/.test(side) && !shortSide;
    if (opening) return { opening: true, dir: shortSide ? 'short' : 'long' };
    if (closing) return { opening: false, dir: shortSide ? 'short' : 'long' };
    if (shortSide) return { opening: null, dir: 'short' };
    if (longSide || /buy|cover/.test(side)) return { opening: null, dir: 'long' };
    return { opening: null, dir: 'short' };
}

function toFill(order) {
    const status = String(order?.status || '').toLowerCase();
    if (DEAD_ORDER.has(status) || order?.is_demo === true) return null;
    const qty = Number(order?.filled_size);
    const price = Number(order?.avg_filled_price);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) return null;
    const stamp = newYorkStamp(order.first_fill_at || order.last_fill_at || order.submitted_at || order.created_at);
    if (!stamp) return null;
    const kind = classifyFill(order);
    return {
        qty,
        price,
        date: stamp.date,
        time: stamp.time,
        epoch: stamp.epoch,
        opening: kind.opening,
        dir: kind.dir,
        symbol: normalizeShsTicker(order.ticker),
    };
}

function isAdd(fill, positionDir) {
    if (fill.opening === true) return true;
    if (fill.opening === false) return false;
    if (!positionDir) return true;
    return fill.dir === positionDir;
}

function walkTicker(fills, symbol) {
    const trades = [];
    let pos = 0;
    let dir = '';
    let entryNotional = 0;
    let entryQty = 0;
    let exitNotional = 0;
    let exitQty = 0;
    let opened = '';
    let closed = '';

    const reset = () => {
        pos = 0;
        dir = '';
        entryNotional = 0;
        entryQty = 0;
        exitNotional = 0;
        exitQty = 0;
        opened = '';
        closed = '';
    };

    const flush = () => {
        if (entryQty > 0 && exitQty > 0 && opened && closed) {
            const qty = Number(Math.min(entryQty, exitQty).toFixed(4));
            const entry = entryNotional / entryQty;
            const exit = exitNotional / exitQty;
            const gross = dir === 'short' ? (entry - exit) * qty : (exit - entry) * qty;
            trades.push({
                symbol,
                type: dir === 'short' ? 'Short' : 'Long',
                opened,
                closed,
                held: heldBetween(opened, closed),
                entry: Number(entry.toFixed(4)),
                exit: Number(exit.toFixed(4)),
                qty,
                gross: roundMoney(gross),
                comm: 0,
                net: roundMoney(gross),
                source: 'shs-bot',
            });
        }
        reset();
    };

    fills.forEach((fill) => {
        const adding = isAdd(fill, dir);
        if (adding) {
            if (pos <= 0) {
                reset();
                dir = fill.dir;
                opened = fill.time;
            }
            pos += fill.qty;
            entryNotional += fill.price * fill.qty;
            entryQty += fill.qty;
            return;
        }
        if (pos <= 0) return;
        const closeQty = Math.min(pos, fill.qty);
        exitNotional += fill.price * closeQty;
        exitQty += closeQty;
        pos -= closeQty;
        closed = fill.time;
        if (pos <= 0.0001) flush();
    });

    return trades;
}

export function buildShsDayMap(orders = [], locates = [], nick = '') {
    if (!String(nick || '').trim()) return {};
    const grouped = new Map();
    orders.filter((order) => orderNickMatches(order, nick)).forEach((order) => {
        const fill = toFill(order);
        if (!fill?.symbol) return;
        const key = `${fill.date}|${fill.symbol}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(fill);
    });

    const tradesByDay = {};
    grouped.forEach((fills, key) => {
        fills.sort((a, b) => a.epoch - b.epoch);
        const [date, symbol] = key.split('|');
        const trades = walkTicker(fills, symbol);
        if (!trades.length) return;
        if (!tradesByDay[date]) tradesByDay[date] = [];
        tradesByDay[date].push(...trades);
    });

    const locatesByDay = {};
    const locateTickers = {};
    locates.filter((row) => locateNickMatches(row, nick)).forEach((row) => {
        if (String(row?.status || '').toLowerCase() !== 'accepted') return;
        const price = Number(row?.price);
        const date = String(row?.date || '').slice(0, 10);
        if (!Number.isFinite(price) || price < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        locatesByDay[date] = (locatesByDay[date] || 0) + price;
        const ticker = normalizeShsTicker(row?.ticker);
        if (!ticker) return;
        if (!locateTickers[date]) locateTickers[date] = [];
        if (!locateTickers[date].includes(ticker)) locateTickers[date].push(ticker);
    });

    const days = {};
    new Set([...Object.keys(tradesByDay), ...Object.keys(locatesByDay)]).forEach((date) => {
        const trades = tradesByDay[date] || [];
        const tickers = [...new Set([...trades.map((trade) => trade.symbol), ...(locateTickers[date] || [])])];
        days[date] = {
            trades,
            gross: roundMoney(trades.reduce((sum, trade) => sum + trade.gross, 0)),
            locates: roundMoney(locatesByDay[date] || 0),
            tickers,
        };
    });
    return days;
}

function mergeTradeAnnotations(previous = [], next = []) {
    const byKey = new Map();
    previous.forEach((trade) => {
        byKey.set(`${String(trade?.symbol || '').toUpperCase()}|${trade?.opened || ''}`, trade);
    });
    return next.map((trade) => {
        const prev = byKey.get(`${trade.symbol}|${trade.opened}`);
        if (!prev) return trade;
        const kept = {};
        ANNOTATION_KEYS.forEach((key) => {
            if (prev[key] != null && prev[key] !== '') kept[key] = prev[key];
        });
        return { ...trade, ...kept };
    });
}

function writeDayTotals(day) {
    const fondexx = day.fondexx || { gross: 0, net: 0, comm: 0, locates: 0 };
    const ppro = day.ppro || { gross: 0, net: 0, comm: 0, locates: 0 };
    day.gross_pnl = roundMoney(Number(fondexx.gross) + Number(ppro.gross));
    day.commissions = roundMoney(Number(fondexx.comm) + Number(ppro.comm));
    day.pnl = roundMoney(Number(fondexx.net) - Number(fondexx.locates) + Number(ppro.net));
    day.locates = reconcileDayLocates(day.gross_pnl, day.pnl, day.commissions, Number(fondexx.locates) + Number(ppro.locates));
    const tickers = new Set([...(fondexx.tickers || []), ...(ppro.tickers || [])]);
    day.traded_tickers = [...tickers];
}

export function applyShsDays(journal, dayMap, createDay) {
    const updated = [];
    const skippedPpro = [];
    Object.entries(dayMap || {}).forEach(([date, payload]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !payload) return;
        const existing = journal[date];
        if (existing?.pproSource === 'ppro-total-report') {
            skippedPpro.push(date);
            return;
        }
        const day = existing && typeof existing === 'object' ? existing : createDay();
        if (!existing) journal[date] = day;
        if (!day.ppro || typeof day.ppro !== 'object') {
            day.ppro = { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] };
        }
        if (payload.trades?.length) {
            day.trades = mergeTradeAnnotations(Array.isArray(day.trades) ? day.trades : [], payload.trades);
        }
        day.fondexx = {
            gross: payload.gross || 0,
            net: payload.gross || 0,
            comm: 0,
            locates: payload.locates || 0,
            tickers: payload.tickers || [],
        };
        day.fondexxSource = 'shs-bot';
        delete day.sheetGrossSource;
        delete day.sheetGrossValue;
        delete day.sheetPnlSource;
        writeDayTotals(day);
        updated.push(date);
    });
    return { updated, skippedPpro };
}
