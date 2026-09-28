/**
 * Server-side Massive aggregates client.
 * The API key stays in the outbound request and is stripped from errors.
 */

const MASSIVE_HOST = 'api.massive.com';
const MIN_INTERVAL_MS = 250;
const HISTORICAL_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_TTL_MS = 45 * 1000;
const DENY_TTL_MS = 2 * 60 * 1000;

const cache = new Map();
const inflight = new Map();
let paceChain = Promise.resolve();
let lastRequestAt = 0;

export function redactSecrets(text, apiKey = '') {
    let clean = String(text || '');
    if (apiKey) clean = clean.split(apiKey).join('[redacted]');
    return clean
        .replace(/apiKey=[^&\s]+/gi, 'apiKey=[redacted]')
        .replace(/api_key=[^&\s]+/gi, 'api_key=[redacted]')
        .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]');
}

export function mapMassiveFailure(status, ticker) {
    if (status === 403) return { fetchStatus: 'forbidden', message: `Massive відхилив доступ до ${ticker} (403)` };
    if (status === 429) return { fetchStatus: 'rate_limited', message: `Massive обмежив частоту запитів для ${ticker} (429)` };
    if (status === 404) return { fetchStatus: 'missing_history', message: `Massive не має історії ${ticker}` };
    return { fetchStatus: 'error', message: `Massive відповів ${status} для ${ticker}` };
}

function pace(now = Date.now) {
    paceChain = paceChain.then(async () => {
        const wait = Math.max(0, MIN_INTERVAL_MS - (now() - lastRequestAt));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        lastRequestAt = now();
    });
    return paceChain;
}

function cacheTtl(to, now) {
    const end = Date.parse(`${to}T23:59:59Z`);
    if (Number.isFinite(end) && end < now - 36 * 60 * 60 * 1000) return HISTORICAL_TTL_MS;
    return LIVE_TTL_MS;
}

export function resetMassiveClientState() {
    cache.clear();
    inflight.clear();
    paceChain = Promise.resolve();
    lastRequestAt = 0;
}

export async function fetchMassiveAggregates({
    ticker,
    multiplier = 1,
    timespan,
    from,
    to,
    apiKey = process.env.MASSIVE_API_KEY || '',
    fetchImpl = fetch,
    now = Date.now,
    adjusted = true,
} = {}) {
    const symbol = String(ticker || '').trim().toUpperCase();
    if (!apiKey) {
        const error = new Error('MASSIVE_API_KEY не налаштовано');
        error.fetchStatus = 'unavailable';
        throw error;
    }
    if (!symbol || !timespan || !from || !to) {
        const error = new Error('Неповний запит свічок');
        error.fetchStatus = 'error';
        throw error;
    }
    const cacheKey = `${symbol}|${multiplier}|${timespan}|${from}|${to}|${adjusted}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < cached.ttl) {
        if (cached.error) {
            const error = new Error(cached.message);
            error.fetchStatus = cached.fetchStatus;
            throw error;
        }
        return cached.body;
    }
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const task = (async () => {
        await pace(now);
        const url = new URL(`https://${MASSIVE_HOST}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
        url.searchParams.set('adjusted', adjusted ? 'true' : 'false');
        url.searchParams.set('sort', 'asc');
        url.searchParams.set('limit', '50000');
        url.searchParams.set('apiKey', apiKey);
        let response;
        try {
            response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        } catch (cause) {
            const error = new Error(`Massive не відповів для ${symbol}`);
            error.fetchStatus = cause?.name === 'TimeoutError' ? 'unavailable' : 'error';
            throw error;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const mapped = mapMassiveFailure(response.status, symbol);
            const error = new Error(mapped.message);
            error.fetchStatus = mapped.fetchStatus;
            if (response.status === 403) {
                cache.set(cacheKey, { at: now(), ttl: DENY_TTL_MS, error: true, fetchStatus: mapped.fetchStatus, message: mapped.message });
            }
            throw error;
        }
        const bars = [];
        let page = payload;
        let pages = 0;
        let incomplete = false;
        while (page && pages < 5) {
            pages += 1;
            bars.push(...(Array.isArray(page.results) ? page.results : []));
            if (!page.next_url) break;
            if (pages >= 5) {
                incomplete = true;
                break;
            }
            await pace(now);
            const next = new URL(page.next_url);
            if (next.hostname !== MASSIVE_HOST) break;
            next.searchParams.delete('apiKey');
            next.searchParams.set('apiKey', apiKey);
            const nextResponse = await fetchImpl(next, { signal: AbortSignal.timeout(20000) });
            page = await nextResponse.json().catch(() => ({}));
            if (!nextResponse.ok) {
                incomplete = true;
                break;
            }
        }
        if (Number.isFinite(Number(payload.resultsCount)) && bars.length < Number(payload.resultsCount)) incomplete = true;
        const body = {
            ticker: symbol,
            adjusted: payload.adjusted !== false,
            status: payload.status || 'OK',
            results: bars,
            incomplete,
            delayed: String(payload.status || '').toUpperCase() === 'DELAYED',
        };
        if (body.adjusted !== true) {
            const error = new Error(`Massive повернув некориговані дані для ${symbol}`);
            error.fetchStatus = 'error';
            throw error;
        }
        cache.set(cacheKey, { at: now(), ttl: cacheTtl(String(to).slice(0, 10), now()), body });
        return body;
    })();

    inflight.set(cacheKey, task);
    try {
        return await task;
    } finally {
        inflight.delete(cacheKey);
    }
}
