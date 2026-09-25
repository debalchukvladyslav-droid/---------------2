const SYMBOL = /^[A-Z][A-Z0-9.:_-]{0,20}$/;
const CHUNK = 300;

export function isClosedRange({ granularity, rangeEndMs, toDate, now = Date.now() }) {
    if (granularity === 'day') {
        const today = new Date(now).toISOString().slice(0, 10);
        return typeof toDate === 'string' && toDate < today;
    }
    return Number.isFinite(rangeEndMs) && rangeEndMs <= now;
}

export function normalizeBars(results, fromMs, toMs) {
    const byTime = new Map();
    for (const bar of results || []) {
        const time = Number(bar?.t);
        const open = Number(bar?.o);
        const high = Number(bar?.h);
        const low = Number(bar?.l);
        const close = Number(bar?.c);
        if (!Number.isFinite(time) || time < fromMs || time > toMs) continue;
        if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) continue;
        byTime.set(Math.trunc(time), {
            bar_ms: Math.trunc(time),
            open,
            high,
            low,
            close,
            volume: Number.isFinite(Number(bar?.v)) ? Number(bar.v) : null,
            vwap: Number.isFinite(Number(bar?.vw)) ? Number(bar.vw) : null,
            transactions: Number.isInteger(Number(bar?.n)) ? Number(bar.n) : null,
        });
    }
    return [...byTime.values()];
}

function validRange(symbol, granularity, fromMs, toMs) {
    return SYMBOL.test(symbol)
        && (granularity === 'minute' || granularity === 'day')
        && Number.isInteger(fromMs)
        && Number.isInteger(toMs)
        && fromMs <= toMs;
}

export function createPolygonStore({ rest }) {
    return {
        async read(symbol, granularity, fromMs, toMs) {
            const ticker = String(symbol || '').toUpperCase();
            if (!validRange(ticker, granularity, fromMs, toMs)) return { hit: false, results: [] };
            const covered = await rest(
                `polygon_range_fetches?symbol=eq.${encodeURIComponent(ticker)}&granularity=eq.${granularity}&range_start=lte.${fromMs}&range_end=gte.${toMs}&select=bar_count&limit=1`,
            );
            if (!covered.ok) return { hit: false, results: [] };
            const spans = await covered.json();
            if (!Array.isArray(spans) || !spans.length) return { hit: false, results: [] };
            if (!Number(spans[0].bar_count)) return { hit: true, results: [] };
            const bars = await rest('rpc/polygon_bars_between', {
                method: 'POST',
                body: JSON.stringify({
                    p_symbol: ticker,
                    p_granularity: granularity,
                    p_from: fromMs,
                    p_to: toMs,
                }),
            });
            if (!bars.ok) return { hit: false, results: [] };
            const results = await bars.json();
            return Array.isArray(results) ? { hit: true, results } : { hit: false, results: [] };
        },

        async write({ symbol, granularity, rangeStart, rangeEnd, toDate, results, complete = true, now = Date.now() }) {
            const ticker = String(symbol || '').toUpperCase();
            if (!complete || !validRange(ticker, granularity, rangeStart, rangeEnd)) return { stored: false };
            if (!isClosedRange({ granularity, rangeEndMs: rangeEnd, toDate, now })) return { stored: false };
            const bars = normalizeBars(results, rangeStart, rangeEnd).map((bar) => ({
                ...bar,
                symbol: ticker,
                granularity,
            }));
            for (let offset = 0; offset < bars.length; offset += CHUNK) {
                const saved = await rest('polygon_bars?on_conflict=symbol,granularity,bar_ms', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify(bars.slice(offset, offset + CHUNK)),
                });
                if (!saved.ok) return { stored: false };
            }
            const span = await rest('polygon_range_fetches?on_conflict=symbol,granularity,range_start,range_end', {
                method: 'POST',
                headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                body: JSON.stringify({
                    symbol: ticker,
                    granularity,
                    range_start: rangeStart,
                    range_end: rangeEnd,
                    bar_count: bars.length,
                    fetched_at: new Date(now).toISOString(),
                }),
            });
            return span.ok ? { stored: true, barCount: bars.length } : { stored: false };
        },
    };
}
