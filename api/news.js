const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const MAX_TICKERS = 8;
const MAX_NEWS_ITEMS = 24;
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_ALLOWED_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);
const cache = new Map();

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

    const authResult = await verifySupabaseAuth(req);
    if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message });

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return res.status(500).json({ message: 'FINNHUB_API_KEY not configured on server' });

    const tickers = parseTickers(req.query?.tickers);
    const fromTs = parseUnixSeconds(req.query?.fromTs);
    const toTs = parseUnixSeconds(req.query?.toTs);
    const cacheKey = `finnhub:${tickers.join(',') || 'market'}:${fromTs || ''}:${toTs || ''}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return res.status(200).json({ ...cached.payload, cached: true });
    }

    try {
        const [marketNews, companyNews] = await Promise.all([
            fetchMarketNews(apiKey),
            tickers.length ? fetchCompanyNews(tickers, apiKey, fromTs, toTs) : Promise.resolve([]),
        ]);

        const generalItems = normalizeItems(marketNews, 'general').slice(0, 8);
        const allTickerItems = normalizeItems(companyNews, 'tickers');
        const windowTickerItems = filterNewsWindow(allTickerItems, fromTs, toTs);
        const tickerItems = (windowTickerItems.length ? windowTickerItems : allTickerItems)
            .map((item) => ({
                ...item,
                windowScore: scoreWindowNews(item, fromTs, toTs),
            }))
            .sort((a, b) => b.windowScore - a.windowScore || b.eventScore - a.eventScore || b.datetime - a.datetime)
            .slice(0, 16);

        const payload = {
            provider: 'finnhub',
            tickers,
            newsWindow: fromTs && toTs ? { fromTs, toTs, matched: windowTickerItems.length } : null,
            items: [...generalItems, ...tickerItems].slice(0, MAX_NEWS_ITEMS),
            updatedAt: new Date().toISOString(),
        };
        cache.set(cacheKey, { ts: Date.now(), payload });
        return res.status(200).json(payload);
    } catch (error) {
        return res.status(502).json({ message: error.message || 'News fetch failed' });
    }
}

function getAllowedOrigins() {
    const configured = String(process.env.ALLOWED_ORIGINS || process.env.APP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin && getAllowedOrigins().has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', 'https://traderjournal-six.vercel.app');
    res.setHeader('Vary', 'Origin');
}

function parseUnixSeconds(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function parseTickers(value) {
    return String(value || '')
        .split(',')
        .map((ticker) => ticker.trim().toUpperCase())
        .filter((ticker) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker))
        .slice(0, MAX_TICKERS);
}

async function fetchCompanyNews(tickers, apiKey, fromTs = null, toTs = null) {
    const to = new Date();
    const from = fromTs
        ? new Date((fromTs - 24 * 60 * 60) * 1000)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toDate = toTs
        ? new Date((toTs + 24 * 60 * 60) * 1000)
        : to;
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = toDate.toISOString().slice(0, 10);

    const results = await Promise.all(tickers.map(async (symbol) => {
        const url = new URL(`${FINNHUB_BASE}/company-news`);
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('from', fromStr);
        url.searchParams.set('to', toStr);
        url.searchParams.set('token', apiKey);
        return fetchJson(url);
    }));

    return results.flat();
}

function filterNewsWindow(items, fromTs, toTs) {
    if (!fromTs || !toTs) return [];
    const pad = 90 * 60;
    return items.filter((item) => {
        const ts = Number(item.datetime) || 0;
        return ts >= fromTs - pad && ts <= toTs + pad;
    });
}

function scoreWindowNews(item, fromTs, toTs) {
    const eventScore = Number(item.eventScore) || 0;
    if (!fromTs || !toTs || !item.datetime) return eventScore;
    const mid = (fromTs + toTs) / 2;
    const distanceMinutes = Math.abs(Number(item.datetime) - mid) / 60;
    const proximityScore = Math.max(0, 18 - Math.floor(distanceMinutes / 15));
    const inTradeWindow = item.datetime >= fromTs && item.datetime <= toTs ? 8 : 0;
    return eventScore * 2 + proximityScore + inTradeWindow;
}

async function fetchMarketNews(apiKey) {
    const url = new URL(`${FINNHUB_BASE}/news`);
    url.searchParams.set('category', 'general');
    url.searchParams.set('token', apiKey);
    return fetchJson(url);
}

async function fetchJson(url) {
    const response = await fetch(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(data?.error || data?.message || `Finnhub error ${response.status}`);
    }
    return Array.isArray(data) ? data : [];
}

function normalizeItems(rawItems, section = 'general') {
    const seen = new Set();
    return rawItems
        .map((item) => {
            const related = String(item.related || '')
                .split(',')
                .map((ticker) => ticker.trim().toUpperCase())
                .filter(Boolean);
            return {
                id: item.id || `${item.datetime || ''}:${item.url || item.headline || ''}`,
                title: String(item.headline || '').trim(),
                summary: String(item.summary || '').trim(),
                url: normalizeHttpUrl(item.url),
                source: String(item.source || 'Finnhub').trim(),
                image: String(item.image || '').trim(),
                related,
                section,
                datetime: Number(item.datetime) || 0,
                eventScore: scoreCatalystNews(item),
            };
        })
        .filter((item) => item.title && item.url)
        .sort((a, b) => b.datetime - a.datetime)
        .filter((item) => {
            const key = item.url || item.title;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function scoreCatalystNews(item) {
    const text = `${item.headline || ''} ${item.summary || ''}`.toLowerCase();
    const weights = [
        [/phase\s*(1|2|3|i|ii|iii)|clinical trial|trial data|endpoint|fda|approval|clearance|pdufa|drug|therapy|patients|biotech|study|data readout/, 14],
        [/earnings|revenue|guidance|forecast|outlook|eps|sales|profit|loss|quarter|q[1-4]/, 11],
        [/offering|public offering|registered direct|private placement|atm|warrant|dilution|convertible/, 10],
        [/merger|acquisition|buyout|takeover|strategic alternatives|asset sale/, 10],
        [/upgrade|downgrade|price target|initiates|analyst|rating/, 8],
        [/contract|partnership|collaboration|agreement|license|supply|order/, 7],
        [/sec|investigation|lawsuit|class action|delisting|nasdaq notice|compliance/, 7],
        [/launch|product|patent|presentation|conference|webcast/, 4],
    ];
    return weights.reduce((score, [pattern, value]) => score + (pattern.test(text) ? value : 0), 0);
}

function normalizeHttpUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

async function verifySupabaseAuth(req) {
    const SUPABASE_URL = (
        process.env.SUPABASE_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        ''
    ).replace(/\/$/, '');
    const SUPABASE_ANON_KEY =
        process.env.SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        '';

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return { ok: false, status: 500, message: 'Supabase auth env is not configured on server' };
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return { ok: false, status: 401, message: 'Missing auth token' };

    try {
        const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                Authorization: `Bearer ${token}`,
                apikey: SUPABASE_ANON_KEY,
            },
            signal: AbortSignal.timeout(10000),
        });

        if (!authRes.ok) return { ok: false, status: 401, message: 'Invalid auth token' };
        return { ok: true };
    } catch (error) {
        return { ok: false, status: 502, message: error.message || 'Supabase auth check failed' };
    }
}
