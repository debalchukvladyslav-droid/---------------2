import {
    normalizeTradeRecord,
    buildPerformanceStats,
    analyzeSetupPerformance,
    findSimilarTradeRecords,
} from '../analysis/performance_engine.js';

export function compactTrade(raw) {
    const trade = normalizeTradeRecord(raw);
    return {
        id: trade.id,
        tradeDate: trade.tradeDate,
        ticker: trade.ticker,
        side: trade.side,
        setup: trade.setup,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        stop: trade.stop,
        shares: trade.shares,
        pnl: trade.pnl,
        rMultiple: trade.rMultiple,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        tradeType: trade.tradeType,
        executionStatus: trade.executionStatus,
        comment: trade.comment,
    };
}

export function createTradeTools({ db, userId }) {
    return {
        async get_trade(args = {}, ctx = {}) {
            const pageContext = ctx.pageContext || {};
            const id = args.tradeId || args.id || pageContext?.tradeKey?.tradeId;
            if (id) {
                const row = await db.getTradeById(userId, id);
                if (!row) return { found: false };
                return {
                    found: true,
                    trade: compactTrade(row),
                    ui_hint: {
                        type: 'open_trade',
                        tradeId: row.id,
                        date: row.trade_date,
                        ticker: row.ticker,
                    },
                };
            }
            const date = dateOrEmpty(args.date) || pageContext?.tradeKey?.date || pageContext?.date;
            const ticker = String(args.ticker || pageContext?.tradeKey?.ticker || '').toUpperCase();
            const index = Number.isFinite(Number(args.tradeIndex ?? pageContext?.tradeKey?.tradeIndex))
                ? Number(args.tradeIndex ?? pageContext?.tradeKey?.tradeIndex)
                : null;
            if (!date) return { error: 'date_or_tradeId_required' };
            const rows = await db.getTrades(userId, { from: date, to: date, ticker: ticker || undefined, limit: 50 });
            if (!rows?.length) return { found: false, date, ticker: ticker || null };
            const ordered = sortTradesForDay(rows);
            let pick = null;
            // Prefer ticker match over raw index: DB order may differ from UI journal index.
            if (ticker) pick = ordered.find((r) => String(r.ticker || '').toUpperCase() === ticker) || null;
            if (!pick && index != null && ordered[index]) pick = ordered[index];
            if (!pick) pick = ordered[0];
            if (!pick) return { found: false };
            return {
                found: true,
                trade: compactTrade(pick),
                ui_hint: {
                    type: 'open_trade',
                    tradeId: pick.id,
                    date: pick.trade_date,
                    tradeIndex: Math.max(0, ordered.findIndex((row) => row.id === pick.id)),
                    ticker: pick.ticker,
                },
            };
        },

        async get_trades(args = {}) {
            const from = dateOrEmpty(args.from);
            const to = dateOrEmpty(args.to);
            const rows = await db.getTrades(userId, {
                from,
                to,
                ticker: args.ticker,
                setup: args.setup,
                side: args.side,
                limit: args.limit,
            });
            const trades = (rows || []).map(compactTrade);
            return { count: trades.length, from: from || null, to: to || null, trades };
        },

        async find_similar_trades(args = {}, ctx = {}) {
            const seedResult = await this.get_trade(args, ctx);
            if (!seedResult?.found) return { error: 'seed_trade_not_found' };
            const from = dateOrEmpty(args.from) || shiftDate(seedResult.trade.tradeDate, -90);
            const to = dateOrEmpty(args.to) || seedResult.trade.tradeDate;
            const pool = await db.getTrades(userId, {
                from,
                to,
                setup: args.setup || seedResult.trade.setup || undefined,
                limit: 100,
            });
            return findSimilarTradeRecords(pool || [], {
                id: seedResult.trade.id,
                trade_date: seedResult.trade.tradeDate,
                ticker: seedResult.trade.ticker,
                side: seedResult.trade.side,
                setup: seedResult.trade.setup,
                pnl: seedResult.trade.pnl,
                entry_price: seedResult.trade.entryPrice,
                exit_price: seedResult.trade.exitPrice,
                payload: {
                    opened: seedResult.trade.entryTime,
                    stop: seedResult.trade.stop,
                },
            }, { limit: Math.min(12, Number(args.limit) || 8) });
        },
    };
}

export function createDayTools({ db, userId }) {
    return {
        async get_day(args = {}, ctx = {}) {
            const pageContext = ctx.pageContext || {};
            const date = dateOrEmpty(args.date) || pageContext?.date || pageContext?.tradeKey?.date;
            if (!date) return { error: 'date_required' };
            const row = await db.getDay(userId, date);
            if (!row) return { found: false, date };
            const metrics = row.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
            const trades = Array.isArray(metrics.trades) ? metrics.trades : [];
            const tradeRows = await db.getTrades(userId, { from: date, to: date, limit: 50 }).catch(() => []);
            const compact = (tradeRows?.length
                ? tradeRows
                : trades.map((t) => ({
                    id: null,
                    trade_date: date,
                    ticker: t.symbol || t.ticker,
                    side: t.direction || t.side,
                    entry_price: t.entry || t.entryPrice,
                    exit_price: t.exit || t.exitPrice,
                    shares: t.qty || t.shares,
                    pnl: t.net ?? t.pnl,
                    setup: t.setup,
                    payload: t,
                }))).map(compactTrade);
            return {
                found: true,
                date,
                pnl: numberOrNull(row.pnl),
                grossPnl: numberOrNull(row.gross_pnl),
                notes: text(row.notes, 500),
                errors: (Array.isArray(metrics.errors) ? metrics.errors : []).map((e) => text(e, 120)).filter(Boolean).slice(0, 20),
                sessionGoal: text(metrics.sessionGoal, 200),
                sessionPlan: text(metrics.sessionPlan, 400),
                trades: compact,
                tradeCount: compact.length,
                ui_hint: { type: 'open_day', date },
            };
        },
    };
}

export function createStatsTools({ db, userId }) {
    return {
        async get_performance_stats(args = {}) {
            const from = dateOrEmpty(args.from) || shiftDate(todayNy(), -30);
            const to = dateOrEmpty(args.to) || todayNy();
            const rows = await fetchTradesPaged(db, userId, {
                from,
                to,
                ticker: args.ticker,
                setup: args.setup,
                side: args.side,
            });
            return buildPerformanceStats(rows, { from, to, setup: args.setup || '' });
        },

        async analyze_setup(args = {}) {
            const setup = String(args.setup || '').trim();
            if (!setup) return { error: 'setup_required' };
            const from = dateOrEmpty(args.from) || shiftDate(todayNy(), -90);
            const to = dateOrEmpty(args.to) || todayNy();
            const rows = await fetchTradesPaged(db, userId, { from, to, setup });
            return analyzeSetupPerformance(rows, setup, { from, to });
        },
    };
}

async function fetchTradesPaged(db, userId, filters = {}, { pageSize = 100, maxPages = 5 } = {}) {
    const all = [];
    for (let page = 0; page < maxPages; page += 1) {
        const batch = await db.getTrades(userId, {
            ...filters,
            limit: pageSize,
            offset: page * pageSize,
        });
        const rows = Array.isArray(batch) ? batch : [];
        all.push(...rows);
        if (rows.length < pageSize) break;
    }
    return all;
}

function sortTradesForDay(rows = []) {
    return [...rows].sort((a, b) => {
        const aMin = entryMinutesFromRow(a);
        const bMin = entryMinutesFromRow(b);
        if (aMin != null && bMin != null && aMin !== bMin) return aMin - bMin;
        return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

function entryMinutesFromRow(row) {
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
    const raw = payload.entryTime || payload.opened || payload.time || payload.openTime || '';
    const match = String(raw).match(/(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

function dateOrEmpty(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function text(value, limit) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function todayNy() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function shiftDate(iso, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    const date = new Date(`${iso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
