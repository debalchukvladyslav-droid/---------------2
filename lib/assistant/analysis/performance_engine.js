const MAX_TRADES = 2000;
const TIME_BUCKETS = [
    { key: '04:00-06:00', start: 4 * 60, end: 6 * 60 },
    { key: '06:00-08:00', start: 6 * 60, end: 8 * 60 },
    { key: '08:00-09:30', start: 8 * 60, end: 9 * 60 + 30 },
    { key: 'other', start: -1, end: -1 },
];

export function normalizeTradeRecord(raw = {}) {
    const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
    const sheet = payload.sheet && typeof payload.sheet === 'object' ? payload.sheet : {};
    const ticker = text(raw.ticker || payload.symbol || payload.ticker || sheet.ticker, 16).toUpperCase();
    const rawSide = text(raw.side || payload.direction || payload.side || payload.position, 40);
    const side = normalizeSide(rawSide, payload);
    const typeFromSide = looksLikeDirection(rawSide) ? '' : rawSide;
    const setup = text(raw.setup || payload.setup || payload.strategy || sheet.setup, 100);
    const pnl = numberOrNull(raw.pnl ?? payload.net ?? payload.pnl ?? payload.profit);
    const entryPrice = numberOrNull(raw.entry_price ?? payload.entryPrice ?? payload.entry ?? payload.openPrice);
    const exitPrice = numberOrNull(raw.exit_price ?? payload.exitPrice ?? payload.exit ?? payload.closePrice);
    const stop = numberOrNull(payload.stop ?? payload.stopPrice ?? sheet.stop);
    const entryTime = text(payload.entryTime || payload.opened || payload.time || payload.openTime || raw.opened, 40);
    const exitTime = text(payload.exitTime || payload.closed || payload.closeTime, 40);
    const tradeDate = text(raw.trade_date || payload.tradeDate || payload.date, 10);
    const typeText = text(
        payload.tradeType || payload.type || payload.classification || sheet.tradeType || typeFromSide,
        100,
    );
    const notTaken = /не\s*(брав|взяв)|not\s*taken|no\s*trade|skip/i.test(typeText);
    const rMultiple = computeR({ side, entryPrice, exitPrice, stop, pnl });
    return {
        id: raw.id || null,
        tradeDate,
        ticker,
        side,
        setup,
        pnl: notTaken ? null : pnl,
        entryPrice,
        exitPrice,
        stop,
        shares: numberOrNull(raw.shares ?? payload.qty ?? payload.shares),
        entryTime,
        exitTime,
        entryMinutes: parseEntryMinutes(entryTime),
        rMultiple: notTaken ? null : rMultiple,
        tradeType: typeText,
        executionStatus: notTaken ? 'not_taken' : 'executed',
        comment: text(payload.comment || payload.notes || sheet.comment, 240),
    };
}

function looksLikeDirection(value) {
    return /^(long|short|buy|sell|л[оo]нг|ш[оo]рт)$/i.test(String(value || '').trim());
}

function normalizeSide(rawSide, payload = {}) {
    const candidates = [
        rawSide,
        payload.direction,
        payload.position,
        payload.side,
        payload.tradeSide,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    for (const value of candidates) {
        if (/short|sell|ш[оo]рт/i.test(value) && looksLikeDirection(value)) return 'short';
        if (/long|buy|л[оo]нг/i.test(value) && looksLikeDirection(value)) return 'long';
    }
    // Journal default: short US equities. Many rows store entry style in `side`.
    return 'short';
}

export function summarizeTrades(trades = []) {
    const executed = trades.filter((t) => t.executionStatus === 'executed' && t.pnl != null);
    const wins = executed.filter((t) => t.pnl > 0);
    const losses = executed.filter((t) => t.pnl < 0);
    const withR = executed.filter((t) => Number.isFinite(t.rMultiple));
    return {
        trades: executed.length,
        wins: wins.length,
        losses: losses.length,
        winRate: executed.length ? round(wins.length / executed.length) : null,
        totalPnl: round(executed.reduce((sum, t) => sum + (t.pnl || 0), 0)),
        avgPnl: executed.length ? round(executed.reduce((sum, t) => sum + (t.pnl || 0), 0) / executed.length) : null,
        avgR: withR.length ? round(withR.reduce((sum, t) => sum + t.rMultiple, 0) / withR.length) : null,
        sampleSize: executed.length,
    };
}

export function groupByTimeBucket(trades = []) {
    const groups = {};
    for (const bucket of TIME_BUCKETS) groups[bucket.key] = [];
    for (const trade of trades) {
        if (trade.executionStatus !== 'executed') continue;
        const key = timeBucketKey(trade.entryMinutes);
        groups[key].push(trade);
    }
    return Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, summarizeTrades(rows)]));
}

export function groupBySetup(trades = [], { limit = 20 } = {}) {
    const map = new Map();
    for (const trade of trades) {
        if (trade.executionStatus !== 'executed') continue;
        const key = trade.setup || '(без сетапу)';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(trade);
    }
    return [...map.entries()]
        .map(([setup, rows]) => ({ setup, ...summarizeTrades(rows) }))
        .sort((a, b) => (b.sampleSize || 0) - (a.sampleSize || 0))
        .slice(0, limit);
}

export function groupByTradeType(trades = [], { limit = 12 } = {}) {
    const map = new Map();
    for (const trade of trades) {
        if (trade.executionStatus !== 'executed') continue;
        const key = trade.tradeType || '(без типу)';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(trade);
    }
    return [...map.entries()]
        .map(([tradeType, rows]) => ({ tradeType, ...summarizeTrades(rows) }))
        .sort((a, b) => (b.sampleSize || 0) - (a.sampleSize || 0))
        .slice(0, limit);
}

export function groupBySide(trades = []) {
    const map = {};
    for (const trade of trades) {
        if (trade.executionStatus !== 'executed') continue;
        const key = trade.side || 'unknown';
        if (!map[key]) map[key] = [];
        map[key].push(trade);
    }
    return Object.fromEntries(Object.entries(map).map(([side, rows]) => [side, summarizeTrades(rows)]));
}

/** Перша збиткова угода дня → середній результат наступної у тому ж дні. */
export function performanceAfterFirstLoss(trades = []) {
    const byDate = new Map();
    for (const trade of trades) {
        if (trade.executionStatus !== 'executed' || !trade.tradeDate) continue;
        if (!byDate.has(trade.tradeDate)) byDate.set(trade.tradeDate, []);
        byDate.get(trade.tradeDate).push(trade);
    }
    const nextAfterLoss = [];
    const nextWithoutImmediateReentry = [];
    for (const dayTrades of byDate.values()) {
        const ordered = [...dayTrades].sort((a, b) => (a.entryMinutes ?? 0) - (b.entryMinutes ?? 0));
        const lossIndex = ordered.findIndex((t) => (t.pnl || 0) < 0);
        if (lossIndex < 0 || lossIndex >= ordered.length - 1) continue;
        nextAfterLoss.push(ordered[lossIndex + 1]);
        const gap = (ordered[lossIndex + 1].entryMinutes ?? 0) - (ordered[lossIndex].entryMinutes ?? 0);
        if (gap >= 15) nextWithoutImmediateReentry.push(ordered[lossIndex + 1]);
    }
    return {
        afterFirstLoss: summarizeTrades(nextAfterLoss),
        afterFirstLossWithCooldown15m: summarizeTrades(nextWithoutImmediateReentry),
    };
}

export function buildPerformanceStats(rawTrades = [], { from = '', to = '', setup = '' } = {}) {
    const trades = (Array.isArray(rawTrades) ? rawTrades : [])
        .slice(0, MAX_TRADES)
        .map(normalizeTradeRecord)
        .filter((t) => {
            if (from && t.tradeDate && t.tradeDate < from) return false;
            if (to && t.tradeDate && t.tradeDate > to) return false;
            if (setup && !String(t.setup || '').toLowerCase().includes(String(setup).toLowerCase())) return false;
            return true;
        });
    return {
        scope: { from: from || null, to: to || null, setup: setup || null, tradeCount: trades.length },
        overall: summarizeTrades(trades),
        notTaken: {
            count: trades.filter((t) => t.executionStatus === 'not_taken').length,
        },
        byTimeBucket: groupByTimeBucket(trades),
        bySetup: groupBySetup(trades),
        byTradeType: groupByTradeType(trades),
        bySide: groupBySide(trades),
        afterFirstLoss: performanceAfterFirstLoss(trades),
    };
}

export function analyzeSetupPerformance(rawTrades = [], setup = '', options = {}) {
    const needle = String(setup || '').trim().toLowerCase();
    if (!needle) return { error: 'setup_required', setup: '' };
    const stats = buildPerformanceStats(rawTrades, { ...options, setup: needle });
    const match = (stats.bySetup || []).find((row) => String(row.setup || '').toLowerCase().includes(needle));
    return {
        setup: match?.setup || setup,
        overall: match || summarizeTrades([]),
        byTimeBucket: stats.byTimeBucket,
        sampleNote: (match?.sampleSize || 0) < 10 ? 'observation_only_n_lt_10' : 'pattern_candidate',
    };
}

export function findSimilarTradeRecords(rawTrades = [], seed = {}, { limit = 8 } = {}) {
    const target = normalizeTradeRecord(seed);
    const scored = (Array.isArray(rawTrades) ? rawTrades : [])
        .map(normalizeTradeRecord)
        .filter((t) => t.executionStatus === 'executed')
        .filter((t) => !(t.id && target.id && t.id === target.id))
        .map((trade) => {
            let score = 0;
            if (target.ticker && trade.ticker === target.ticker) score += 3;
            if (target.setup && trade.setup && trade.setup.toLowerCase() === target.setup.toLowerCase()) score += 4;
            if (target.side && trade.side === target.side) score += 1;
            if (target.entryMinutes != null && trade.entryMinutes != null) {
                const diff = Math.abs(target.entryMinutes - trade.entryMinutes);
                if (diff <= 30) score += 2;
                else if (diff <= 90) score += 1;
            }
            return { trade, score };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || String(b.trade.tradeDate).localeCompare(String(a.trade.tradeDate)))
        .slice(0, limit);

    return {
        seed: {
            ticker: target.ticker,
            setup: target.setup,
            side: target.side,
            tradeDate: target.tradeDate,
            entryTime: target.entryTime,
        },
        matches: scored.map(({ trade, score }) => ({
            score,
            id: trade.id,
            tradeDate: trade.tradeDate,
            ticker: trade.ticker,
            setup: trade.setup,
            side: trade.side,
            pnl: trade.pnl,
            rMultiple: trade.rMultiple,
            entryTime: trade.entryTime,
        })),
        aggregate: summarizeTrades(scored.map((row) => row.trade)),
    };
}

function computeR({ side, entryPrice, exitPrice, stop, pnl }) {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(stop) || Math.abs(entryPrice - stop) < 1e-9) return null;
    if (!Number.isFinite(exitPrice) && !Number.isFinite(pnl)) return null;
    const riskPerShare = Math.abs(entryPrice - stop);
    if (!Number.isFinite(exitPrice)) return null;
    const isShort = /short|sell/i.test(String(side || ''));
    const move = isShort ? (entryPrice - exitPrice) : (exitPrice - entryPrice);
    return round(move / riskPerShare);
}

function parseEntryMinutes(value) {
    const textValue = String(value || '');
    const match = textValue.match(/(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return hours * 60 + minutes;
}

function timeBucketKey(minutes) {
    if (minutes == null) return 'other';
    for (const bucket of TIME_BUCKETS) {
        if (bucket.key === 'other') continue;
        if (minutes >= bucket.start && minutes < bucket.end) return bucket.key;
    }
    return 'other';
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function text(value, limit = 120) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function round(value) {
    return Math.round(Number(value) * 1000) / 1000;
}
