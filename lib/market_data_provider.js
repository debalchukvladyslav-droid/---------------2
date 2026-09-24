/**
 * Daily market data for Aggressiveness.
 * The gauge reads public Yahoo chart data. Polygon remains available when
 * MARKET_DATA_PROVIDER=polygon. Yield scale is applied by the caller, so
 * Yahoo ^TNX (already a percent) is stored in the same raw units as I:TNX.
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
    })).filter((bar) => bar.date && bar.close > 0);
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
        this.authToken = options.authToken || '';
        this.cache = new Map();
        if (!this.apiKey && !this.edgeConfigured()) {
            const error = new Error('POLYGON_API_KEY is not configured');
            error.code = 'MARKET_DATA_UNAVAILABLE';
            throw error;
        }
    }

    edgeConfigured() {
        const base = String(this.env.SUPABASE_URL || this.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
        return Boolean(base && this.authToken);
    }

    async getDailyBars(symbol, from, to) {
        const key = `${symbol}:${from}:${to}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.bars;
        const bars = this.apiKey
            ? await this.fetchPolygonDaily(symbol, from, to)
            : await this.fetchEdgeDaily(symbol, from, to);
        this.cache.set(key, { at: Date.now(), bars });
        return bars;
    }

    async fetchPolygonDaily(symbol, from, to) {
        const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`);
        url.searchParams.set('adjusted', 'true');
        url.searchParams.set('sort', 'asc');
        url.searchParams.set('limit', '50000');
        url.searchParams.set('apiKey', this.apiKey);
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload?.error || payload?.message || `Polygon ${response.status} for ${symbol}`);
            error.code = response.status === 429 ? 'RATE_LIMITED' : response.status === 404 ? 'SERIES_MISSING' : 'MARKET_PROVIDER_ERROR';
            error.symbol = symbol;
            throw error;
        }
        return normalizePolygonAggs(payload);
    }

    async fetchEdgeDaily(symbol, from, to) {
        const base = String(this.env.SUPABASE_URL || this.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
        const anon = this.env.SUPABASE_ANON_KEY || this.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
        const response = await this.fetchImpl(`${base}/functions/v1/polygon-aggs`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.authToken}`,
                apikey: anon,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ mode: 'daily', symbol, from, to }),
            signal: AbortSignal.timeout(20000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload?.message || payload?.error || `Polygon edge ${response.status} for ${symbol}`);
            error.code = response.status === 429 ? 'RATE_LIMITED' : response.status === 404 ? 'SERIES_MISSING' : 'MARKET_PROVIDER_ERROR';
            error.symbol = symbol;
            throw error;
        }
        return normalizePolygonAggs(payload);
    }

    async getLiveQuotes(symbols) {
        if (!this.apiKey) return { quotes: {}, incomplete: true };
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

const YAHOO_SYMBOLS = Object.freeze({
    'I:VIX': '^VIX',
    'I:TNX': '^TNX',
    'I:CL': 'CL=F',
});

export function yahooSymbol(symbol) {
    return YAHOO_SYMBOLS[symbol] || symbol;
}

export class YahooMarketDataProvider extends MarketDataProvider {
    constructor(options = {}) {
        super();
        this.fetchImpl = options.fetchImpl || fetch;
        this.cache = new Map();
    }

    async getDailyBars(symbol, from, to) {
        const key = `${symbol}:${from}:${to}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.bars;
        const yahoo = yahooSymbol(symbol);
        const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
        const period2 = Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 36 * 60 * 60;
        const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}`);
        url.searchParams.set('interval', '1d');
        url.searchParams.set('period1', String(period1));
        url.searchParams.set('period2', String(period2));
        url.searchParams.set('events', 'history');
        const response = await this.fetchImpl(url, {
            headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(20000),
        });
        const payload = await response.json().catch(() => ({}));
        const result = payload?.chart?.result?.[0];
        if (!response.ok || !result) {
            const error = new Error(payload?.chart?.error?.description || `Yahoo ${response.status} for ${symbol}`);
            error.code = response.status === 404 ? 'SERIES_MISSING' : 'MARKET_PROVIDER_ERROR';
            error.symbol = symbol;
            throw error;
        }
        const timestamps = result.timestamp || [];
        const quote = result.indicators?.quote?.[0] || {};
        let bars = timestamps.map((stamp, index) => ({
            date: polygonBarDate(stamp * 1000),
            open: numberOrNull(quote.open?.[index]),
            high: numberOrNull(quote.high?.[index]),
            low: numberOrNull(quote.low?.[index]),
            close: Number(quote.close?.[index]),
        })).filter((bar) => bar.date >= from && bar.date <= to && bar.close > 0);
        if (yahoo === '^TNX') {
            bars = bars.map((bar) => ({
                ...bar,
                open: scaleField(bar.open, 10),
                high: scaleField(bar.high, 10),
                low: scaleField(bar.low, 10),
                close: bar.close * 10,
            }));
        }
        this.cache.set(key, { at: Date.now(), bars });
        return bars;
    }

    async getLiveQuotes(symbols) {
        const quotes = {};
        const mapped = symbols.map((symbol) => yahooSymbol(symbol));
        const url = new URL('https://query1.finance.yahoo.com/v7/finance/quote');
        url.searchParams.set('symbols', mapped.join(','));
        try {
            const response = await this.fetchImpl(url, {
                headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(12000),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) return { quotes, incomplete: true };
            const byYahoo = new Map((payload?.quoteResponse?.result || []).map((row) => [row.symbol, row]));
            symbols.forEach((symbol, index) => {
                const row = byYahoo.get(mapped[index]);
                if (!row) return;
                const changePct = Number(row.regularMarketChangePercent);
                const previous = Number(row.regularMarketPreviousClose);
                const last = Number(row.regularMarketPrice);
                quotes[symbol] = {
                    change: Number.isFinite(changePct) ? changePct / 100 : null,
                    changePoints: Number.isFinite(last) && Number.isFinite(previous) ? last - previous : null,
                };
            });
        } catch {
            return { quotes, incomplete: true };
        }
        return { quotes, incomplete: symbols.some((symbol) => quotes[symbol]?.change == null) };
    }
}

export function createMarketDataProvider(env = process.env, fetchImpl = fetch, options = {}) {
    const explicit = String(env.MARKET_DATA_PROVIDER || '').trim().toLowerCase();
    const name = explicit || (options.allowPublic ? 'yahoo' : 'polygon');
    if (name === 'yahoo') return new YahooMarketDataProvider({ fetchImpl });
    if (name !== 'polygon') {
        const error = new Error(`Unsupported MARKET_DATA_PROVIDER "${name}". Use yahoo or polygon.`);
        error.code = 'MARKET_DATA_UNAVAILABLE';
        throw error;
    }
    return new PolygonMarketDataProvider({ env, fetchImpl, authToken: options.authToken || '' });
}
