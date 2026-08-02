const compact = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const numberOrNull = (value) => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

export function buildBoundedJournalContext(journal = {}, { maxDays = 120, maxTradesPerDay = 50 } = {}) {
    const output = {};
    const dates = Object.keys(journal || {})
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, maxDays);
    for (const date of dates) {
        const day = journal[date] || {};
        const trades = (Array.isArray(day.trades) ? day.trades : []).slice(0, maxTradesPerDay).map((trade) => {
            const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
            const typeText = compact(trade.tradeType ?? trade.type ?? trade.classification ?? sheet.tradeType, 100);
            const notTaken = /не\s*(брав|взяв)|not\s*taken|no\s*trade|skip/i.test(typeText);
            return {
                symbol: compact(trade.symbol ?? trade.ticker ?? sheet.ticker, 16),
                direction: compact(trade.direction ?? trade.side ?? trade.position, 12),
                entryTime: compact(trade.entryTime ?? trade.time ?? trade.openTime, 30),
                exitTime: compact(trade.exitTime ?? trade.closeTime, 30),
                entryPrice: numberOrNull(trade.entryPrice ?? trade.entry ?? trade.openPrice),
                exitPrice: numberOrNull(trade.exitPrice ?? trade.exit ?? trade.closePrice),
                pnl: notTaken ? null : numberOrNull(trade.net ?? trade.pnl ?? trade.profit),
                setup: compact(trade.setup ?? trade.strategy ?? trade.pattern ?? sheet.setup, 100),
                tradeType: typeText,
                criteria: compact(trade.criteria ?? trade.criterion ?? sheet.criteria ?? sheet.criterion, 180),
                exceptions: compact(trade.exceptions ?? trade.exception ?? sheet.exceptions ?? sheet.exception, 180),
                comment: compact(trade.comment ?? trade.notes ?? trade.review ?? sheet.comment, 240),
                executionStatus: notTaken ? 'not_taken' : 'executed',
            };
        });
        output[date] = {
            pnl: numberOrNull(day?.fondexx?.pnl ?? day?.ppro?.pnl ?? day?.pnl),
            notes: compact(day.notes ?? day.comment ?? day.sessionComment, 500),
            errors: (Array.isArray(day.errors) ? day.errors : []).map((item) => compact(item, 120)).filter(Boolean).slice(0, 20),
            trades,
        };
    }
    return output;
}

export function buildBoundedScreenTagContext(screenTags = {}, maxItems = 100) {
    return Object.fromEntries(Object.entries(screenTags || {}).slice(-maxItems).map(([path, tags]) => [
        compact(String(path).split(/[\\/]/).pop(), 120),
        (Array.isArray(tags) ? tags : []).map((tag) => compact(tag, 60)).filter(Boolean).slice(0, 12),
    ]));
}
