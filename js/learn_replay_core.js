export const REWARD_MULTIPLE = 3.7;
const SESSION_OPEN_MINUTE = 9 * 60 + 30;

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeBar(bar) {
    const time = finite(bar?.time);
    const open = finite(bar?.open);
    const high = finite(bar?.high);
    const low = finite(bar?.low);
    const close = finite(bar?.close);
    if (time == null || open == null || high == null || low == null || close == null) return null;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) return null;
    return { time, open, high, low, close };
}

function compactOriginal(trade) {
    const entry = finite(trade?.entry ?? trade?.sheet?.entryPrice);
    if (!(entry > 0)) return null;
    const type = trade?.type === 'Short' ? 'short' : trade?.type === 'Long' ? 'long' : '';
    return {
        type,
        entry,
        exit: finite(trade?.exit ?? trade?.closePrice ?? trade?.sheet?.exitPrice),
        opened: String(trade?.opened || trade?.entryTime || '').trim(),
        closed: String(trade?.closed || trade?.exitTime || '').trim(),
        net: finite(trade?.net),
    };
}

export function collectReplaySessions(journal = {}, owner = 'журнал') {
    const sessions = [];
    Object.entries(journal || {}).forEach(([date, day]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        const bySymbol = new Map();
        (Array.isArray(day?.trades) ? day.trades : []).forEach((trade) => {
            const symbol = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
            if (!/^[A-Z]{1,10}$/.test(symbol)) return;
            const original = compactOriginal(trade);
            if (!original) return;
            if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
            bySymbol.get(symbol).push(original);
        });
        bySymbol.forEach((originals, symbol) => {
            sessions.push({ symbol, date, owner: String(owner || 'журнал'), originals });
        });
    });
    return sessions;
}

export function pickReplaySession(sessions = [], random = Math.random) {
    if (!sessions.length) return null;
    const index = Math.min(sessions.length - 1, Math.max(0, Math.floor(Number(random()) * sessions.length)));
    return sessions[index] || null;
}

export function createReplay(candles, { warmup = 20, fromOpen = false } = {}) {
    const unique = [];
    const seen = new Set();
    (Array.isArray(candles) ? candles : []).forEach((candidate) => {
        const bar = normalizeBar(candidate);
        if (!bar || seen.has(bar.time)) return;
        seen.add(bar.time);
        unique.push(bar);
    });
    unique.sort((a, b) => a.time - b.time);
    if (fromOpen) {
        const openCursor = cursorAtSessionOpen(unique);
        if (openCursor == null) unique.length = 0;
        else unique.splice(0, openCursor - 1);
    }
    const cursor = fromOpen
        ? Math.min(unique.length, 1)
        : Math.min(unique.length, Math.max(1, Math.floor(warmup) || 1));
    return {
        bars: unique,
        cursor,
        speed: 1,
        status: unique.length > cursor ? 'paused' : 'done',
        phase: 'flat',
        pending: null,
        active: null,
        trades: [],
    };
}

export function visibleBars(replay) {
    return (replay?.bars || []).slice(0, replay?.cursor || 0);
}

export function nyMinutes(unixSeconds) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(Number(unixSeconds) * 1000));
    let hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (hour === 24) hour = 0;
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

export function cursorAtSessionOpen(bars = []) {
    const index = bars.findIndex((bar) => {
        const minute = nyMinutes(bar.time);
        return minute != null && minute >= SESSION_OPEN_MINUTE;
    });
    return index < 0 ? null : index + 1;
}

export function setReplaySpeed(replay, speed) {
    if (!replay) return replay;
    const next = speed === 2 || speed === 5 ? speed : 1;
    return { ...replay, speed: next };
}

export function setReplayStatus(replay, status) {
    if (!replay || replay.status === 'done') return replay;
    if (status !== 'playing' && status !== 'paused') return replay;
    return { ...replay, status };
}

export function entriesAllowed(replay) {
    if (!replay || replay.status === 'done' || replay.active) return false;
    if (replay.phase === 'entry' || replay.phase === 'stop' || replay.phase === 'position') return false;
    if (replay.cursor >= (replay.bars?.length || 0)) return false;
    const tries = replay.trades?.length || 0;
    if (tries === 0) return true;
    return tries === 1 && replay.trades[0].result === 'stop';
}

export function beginEntry(replay) {
    if (!entriesAllowed(replay)) return replay;
    return { ...replay, phase: 'entry', pending: null };
}

export function setEntryPrice(replay, price) {
    const entry = finite(price);
    if (!replay || replay.phase !== 'entry' || !(entry > 0)) return replay;
    const bar = replay.bars[replay.cursor - 1];
    if (!bar) return replay;
    return { ...replay, phase: 'stop', pending: { entry, time: bar.time } };
}

export function enterAtMarket(replay) {
    const armed = beginEntry(replay);
    const bar = armed?.bars?.[armed.cursor - 1];
    if (!bar) return replay;
    return setEntryPrice(armed, bar.close);
}

export function setStopPrice(replay, price) {
    const stop = finite(price);
    const entry = finite(replay?.pending?.entry);
    if (!replay || replay.phase !== 'stop' || !(entry > 0) || !(stop > 0) || stop === entry) return replay;
    const side = stop < entry ? 'long' : 'short';
    const risk = Math.abs(entry - stop);
    const take = side === 'long' ? entry + risk * REWARD_MULTIPLE : entry - risk * REWARD_MULTIPLE;
    if (!(risk > 0) || !(take > 0)) return replay;
    return {
        ...replay,
        phase: 'position',
        pending: null,
        active: { side, entry, stop, take, risk, time: replay.pending.time },
    };
}

export function cancelSetup(replay) {
    if (!replay || replay.active) return replay;
    return { ...replay, phase: 'flat', pending: null };
}

function hitOnBar(trade, bar) {
    const stopHit = trade.side === 'long' ? bar.low <= trade.stop : bar.high >= trade.stop;
    const takeHit = trade.side === 'long' ? bar.high >= trade.take : bar.low <= trade.take;
    if (stopHit) return { result: 'stop', r: -1, exitPrice: trade.stop };
    if (takeHit) return { result: 'take', r: REWARD_MULTIPLE, exitPrice: trade.take };
    return null;
}

function markR(trade, price) {
    const delta = trade.side === 'long' ? price - trade.entry : trade.entry - price;
    return delta / trade.risk;
}

export function advanceReplay(replay, steps = replay?.speed) {
    if (!replay || replay.status !== 'playing') return replay;
    const count = Math.max(0, Math.floor(Number(steps) || 0));
    if (!count) return replay;
    if (replay.cursor >= replay.bars.length) return finishOpen(replay, replay.cursor);
    const end = Math.min(replay.bars.length, replay.cursor + count);
    let active = replay.active;
    const trades = replay.trades.slice();
    for (let index = replay.cursor; index < end; index += 1) {
        const bar = replay.bars[index];
        if (!active || !(bar.time > active.time)) continue;
        const hit = hitOnBar(active, bar);
        if (!hit) continue;
        trades.push({ ...active, ...hit, closedTime: bar.time });
        active = null;
    }
    const done = end >= replay.bars.length;
    if (done && active) {
        const last = replay.bars[end - 1];
        trades.push({
            ...active,
            result: 'open',
            r: markR(active, last.close),
            exitPrice: last.close,
            closedTime: last.time,
        });
        active = null;
    }
    return {
        ...replay,
        cursor: end,
        trades,
        active,
        pending: done ? null : replay.pending,
        phase: done || !active ? (done ? 'flat' : (replay.phase === 'position' ? 'flat' : replay.phase)) : 'position',
        status: done ? 'done' : 'playing',
    };
}

function finishOpen(replay, cursor) {
    return { ...replay, cursor, status: 'done', phase: 'flat', pending: null, active: null };
}

export function jumpToSessionOpen(replay) {
    if (!replay || replay.status === 'done') return replay;
    const target = cursorAtSessionOpen(replay.bars);
    if (target == null || target <= replay.cursor) return replay;
    const stepped = advanceReplay({ ...replay, status: 'playing' }, target - replay.cursor);
    if (stepped.status === 'done') return stepped;
    return { ...stepped, status: replay.status === 'playing' ? 'playing' : 'paused' };
}

export function summarizeAttempts(trades = []) {
    const rows = (Array.isArray(trades) ? trades : []).filter((trade) => (
        trade?.result === 'take' || trade?.result === 'stop' || trade?.result === 'open'
    ));
    const totalR = rows.reduce((sum, trade) => sum + Number(trade.r || 0), 0);
    return {
        attempts: rows.length,
        wins: rows.filter((trade) => trade.result === 'take').length,
        losses: rows.filter((trade) => trade.result === 'stop').length,
        opens: rows.filter((trade) => trade.result === 'open').length,
        totalR,
        avgR: rows.length ? totalR / rows.length : 0,
    };
}

export function formatReplayPrice(value) {
    const number = finite(value);
    if (!(number > 0)) return '—';
    const digits = number >= 1 ? 2 : 4;
    return number.toFixed(digits);
}

export function formatReplayR(value) {
    const number = finite(value);
    if (number == null) return '—';
    const sign = number > 0 ? '+' : '';
    return `${sign}${number.toFixed(2)}R`;
}
