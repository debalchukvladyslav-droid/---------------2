const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_DISABLED = true;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

export function normalizeTicker(value) {
    const ticker = String(value || '').trim().toUpperCase();
    return /^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) ? ticker : '';
}

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function calculateAtr(bars, window = 14) {
    const valid = (Array.isArray(bars) ? bars : []).filter((bar) => [bar?.h, bar?.l, bar?.c].every((value) => finite(value) != null));
    if (valid.length < window + 1) return null;
    const recent = valid.slice(-(window + 1));
    const ranges = recent.slice(1).map((bar, index) => Math.max(Number(bar.h) - Number(bar.l), Math.abs(Number(bar.h) - Number(recent[index].c)), Math.abs(Number(bar.l) - Number(recent[index].c))));
    return round(ranges.reduce((sum, value) => sum + value, 0) / ranges.length, 4);
}

export function calculateRelativeVolume(currentVolume, bars, window = 10) {
    const current = finite(currentVolume);
    const volumes = (Array.isArray(bars) ? bars : []).map((bar) => finite(bar?.v)).filter((value) => value > 0).slice(-window);
    if (!(current > 0) || volumes.length < Math.min(5, window)) return null;
    const average = volumes.reduce((sum, value) => sum + value, 0) / volumes.length;
    return average > 0 ? round(current / average, 2) : null;
}

async function requestJson(url, fetchImpl) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body?.error || body?.message || `Market provider HTTP ${response.status}`);
        error.status = response.status;
        error.code = response.status === 429 ? 'MARKET_RATE_LIMITED' : response.status === 404 ? 'TICKER_NOT_FOUND' : 'MARKET_PROVIDER_ERROR';
        throw error;
    }
    return body;
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

async function polygonHistory(ticker, apiKey, fetchImpl) {
    if (POLYGON_DISABLED || !apiKey) return { bars: [], provider: null };
    const url = new URL(`${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${isoDaysAgo(45)}/${isoDaysAgo(0)}`);
    Object.entries({ adjusted: 'true', sort: 'asc', limit: '50', apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
    const data = await requestJson(url, fetchImpl);
    return { bars: Array.isArray(data.results) ? data.results : [], provider: 'Polygon' };
}

async function finnhubSnapshot(ticker, apiKey, fetchImpl) {
    if (!apiKey) return null;
    const urls = ['quote', 'stock/profile2', 'stock/metric'].map((path) => { const url = new URL(`${FINNHUB_BASE}/${path}`); url.searchParams.set('symbol', ticker); url.searchParams.set('token', apiKey); if (path === 'stock/metric') url.searchParams.set('metric', 'all'); return url; });
    const [quote, profile, metrics] = await Promise.all(urls.map((url) => requestJson(url, fetchImpl)));
    if (!finite(quote?.c) && !finite(quote?.pc) && !profile?.ticker) { const error = new Error(`Ticker ${ticker} not found`); error.status = 404; error.code = 'TICKER_NOT_FOUND'; throw error; }
    return { quote, profile, metrics: metrics?.metric || {} };
}

export async function enrichMarketData(tickerInput, options = {}) {
    const ticker = normalizeTicker(tickerInput);
    if (!ticker) { const error = new Error('Invalid ticker'); error.status = 400; error.code = 'INVALID_TICKER'; throw error; }
    const fetchImpl = options.fetchImpl || fetch; const environment = options.environment || process.env;
    const cacheKey = `${ticker}:${Boolean(environment.FINNHUB_API_KEY)}:${Boolean(environment.POLYGON_API_KEY)}`;
    const cached = cache.get(cacheKey);
    if (!options.skipCache && cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.value, cached: true };
    if (!environment.FINNHUB_API_KEY && !environment.POLYGON_API_KEY) { const error = new Error('No market data provider configured'); error.status = 503; error.code = 'MARKET_DATA_UNAVAILABLE'; throw error; }
    const warnings = [];
    const settled = await Promise.allSettled([finnhubSnapshot(ticker, environment.FINNHUB_API_KEY, fetchImpl), polygonHistory(ticker, environment.POLYGON_API_KEY, fetchImpl)]);
    const snapshot = settled[0].status === 'fulfilled' ? settled[0].value : null;
    const history = settled[1].status === 'fulfilled' ? settled[1].value : { bars: [], provider: null };
    if (settled[0].status === 'rejected' && environment.FINNHUB_API_KEY) warnings.push(settled[0].reason?.code || 'FINNHUB_UNAVAILABLE');
    if (settled[1].status === 'rejected' && environment.POLYGON_API_KEY) warnings.push(settled[1].reason?.code || 'POLYGON_UNAVAILABLE');
    if (!snapshot && !history.bars.length) throw settled.find((item) => item.status === 'rejected')?.reason || Object.assign(new Error('Market data unavailable'), { status: 502, code: 'MARKET_PROVIDER_ERROR' });
    const quote = snapshot?.quote || {}; const metrics = snapshot?.metrics || {}; const previousClose = finite(quote.pc); const open = finite(quote.o) || finite(quote.c);
    const gapPct = previousClose > 0 && open > 0 ? round(((open - previousClose) / previousClose) * 100, 2) : null;
    const profileShares = finite(snapshot?.profile?.shareOutstanding);
    const floatShares = finite(metrics.shareOutstanding) || (profileShares ? profileShares * 1_000_000 : null);
    const atr = calculateAtr(history.bars) ?? finite(metrics.atr14);
    const rvol = calculateRelativeVolume(finite(quote.v), history.bars);
    if (rvol == null) warnings.push('RVOL_REQUIRES_CURRENT_VOLUME'); if (floatShares == null) warnings.push('FLOAT_UNAVAILABLE'); if (atr == null) warnings.push('ATR_UNAVAILABLE');
    const value = { ticker, gapPct, rvol, floatShares: floatShares ? Math.round(floatShares) : null, atr, price: finite(quote.c), previousClose, fetchedAt: new Date().toISOString(), provider: [snapshot && 'Finnhub', history.provider].filter(Boolean).join(' + '), completeness: [gapPct, rvol, floatShares, atr].filter((value) => value != null).length / 4, warnings: [...new Set(warnings)], cached: false };
    cache.set(cacheKey, { at: Date.now(), value }); return value;
}

export function clearMarketEnrichmentCache() { cache.clear(); }
