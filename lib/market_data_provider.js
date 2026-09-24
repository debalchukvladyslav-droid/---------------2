/**
 * Daily market data for Aggressiveness.
 * Polygon is the project provider. Symbols that are not equities are configurable.
 * Closes are cached raw; yield scale is applied by the caller before scoring.
 */

export const SERIES_CATALOG = Object.freeze([
    { key: 'SPY', fallback: 'SPY', scale: 1 },
    { key: 'QQQ', fallback: 'QQQ', scale: 1 },
    { key: 'IWM', fallback: 'IWM', scale: 1 },
    { key: 'IWC', fallback: 'IWC', scale: 1 },
    { key: 'XBI', fallback: 'XBI', scale: 1 },
    { key: 'ARKK', fallback: 'ARKK', scale: 1 },
    { key: 'SMH', fallback: 'SMH', scale: 1 },
    { key: 'VIX', env: 'MARKET_VIX_SYMBOL', fallback: 'I:VIX', scale: 1 },
    { key: 'US10Y', env: 'MARKET_US10Y_SYMBOL', fallback: 'I:TNX', scaleEnv: 'MARKET_US10Y_SCALE', scale: 0.1 },
    { key: 'OIL', env: 'MARKET_OIL_SYMBOL', fallback: 'I:CL', scale: 1 },
]);

export function seriesSymbol(spec, env = {}) {
    const configured = spec.env ? String(env[spec.env] || '').trim() : '';
    return configured || spec.fallback;
}

export function seriesScale(spec, env = {}) {
    if (!spec.scaleEnv) return spec.scale;
    const configured = Number(env[spec.scaleEnv]);
    return Number.isFinite(configured) && configured > 0 ? configured : spec.scale;
}

export function applySeriesScale(spec, bars, env = {}) {
    const scale = seriesScale(spec, env);
    if (scale === 1) return bars;
    return bars.map((bar) => ({
        ...bar,
        open: scaleField(bar.open, scale),
        high: scaleField(bar.high, scale),
        low: scaleField(bar.low, scale),
        close: bar.close * scale,
    }));
}

function scaleField(value, scale) {
    return Number.isFinite(Number(value)) ? Number(value) * scale : null;
}

export function polygonBarDate(epochMs) {
    return new Date(epochMs).toISOString().slice(0, 10);
}

export function normalizePolygonAggs(payload) {
    return (payload?.results || []).map((bar) => ({
        date: polygonBarDate(bar.t),
        open: numberOrNull(bar.o),
        high: numberOrNull(bar.h),
        low: numberOrNull(bar.l),
        close: Number(bar.c),
    })).filter((bar) => bar.date && Number.isFinite(bar.close));
}

function numberOrNull(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

export class MarketDataProvider {
    async getDailyBars() {
        throw new Error('MarketDataProvider.getDailyBars is not implemented');
    }

    async getLiveQuotes() {
        throw new Error('MarketDataProvider.getLiveQuotes is not implemented');
    }
}

export class PolygonMarketDataProvider extends MarketDataProvider {
    constructor(options = {}) {
        super();
        this.env = options.env || process.env;
        this.fetchImpl = options.fetchImpl || fetch;
        this.apiKey = this.env.POLYGON_API_KEY || this.env.MARKET_DATA_API_KEY || '';
        this.cache = new Map();
        if (!this.apiKey) {
            const error = new Error('POLYGON_API_KEY is not configured');
            error.code = 'MARKET_DATA_UNAVAILABLE';
            throw error;
        }
    }

    async getDailyBars(symbol, from, to) {
        const key = `${symbol}:${from}:${to}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.bars;
        const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`);
        url.searchParams.set('adjusted', 'true');
        url.searchParams.set('sort', 'asc');
        url.searchParams.set('limit', '50000');
        url.searchParams.set('apiKey', this.apiKey);
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload?.error || payload?.message || `Polygon ${response.status} for ${symbol}`);
            error.code = response.status === 404 ? 'SERIES_MISSING' : 'MARKET_PROVIDER_ERROR';
            error.symbol = symbol;
            throw error;
        }
        const bars = normalizePolygonAggs(payload);
        this.cache.set(key, { at: Date.now(), bars });
        return bars;
    }

    async getLiveQuotes(symbols) {
        const quotes = {};
        const joined = symbols.map((symbol) => encodeURIComponent(symbol)).join(',');
        const url = new URL('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers');
        url.searchParams.set('tickers', symbols.join(','));
        url.searchParams.set('apiKey', this.apiKey);
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(12000) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return { quotes, incomplete: true, detail: payload?.error || `snapshot ${response.status}`, requested: joined };
        for (const row of payload.tickers || []) {
            const changePct = Number(row.todaysChangePerc);
            const previous = Number(row.prevDay?.c);
            const last = Number(row.day?.c ?? row.lastTrade?.p);
            quotes[row.ticker] = {
                change: Number.isFinite(changePct) ? changePct / 100 : null,
                changePoints: Number.isFinite(Number(row.todaysChange)) ? Number(row.todaysChange) : (Number.isFinite(last) && Number.isFinite(previous) ? last - previous : null),
            };
        }
        return { quotes, incomplete: symbols.some((symbol) => quotes[symbol]?.change == null) };
    }
}

export function createMarketDataProvider(env = process.env, fetchImpl = fetch) {
    const name = String(env.MARKET_DATA_PROVIDER || 'polygon').trim().toLowerCase();
    if (name !== 'polygon') {
        const error = new Error(`Unsupported MARKET_DATA_PROVIDER "${name}". Use polygon.`);
        error.code = 'MARKET_DATA_UNAVAILABLE';
        throw error;
    }
    return new PolygonMarketDataProvider({ env, fetchImpl });
}
