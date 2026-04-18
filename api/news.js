const DEFAULT_SUPABASE_URL = 'https://gijarvlerztfggxhuvow.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_4gU0201mMkinUqwH-4SkWA_eSoNqew6';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const MAX_TICKERS = 8;
const MAX_NEWS_ITEMS = 24;
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

    const authResult = await verifySupabaseAuth(req);
    if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message });

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return res.status(500).json({ message: 'FINNHUB_API_KEY not configured on server' });

    const tickers = parseTickers(req.query?.tickers);
    const cacheKey = `finnhub:${tickers.join(',') || 'market'}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return res.status(200).json({ ...cached.payload, cached: true });
    }

    try {
        const news = tickers.length
            ? await fetchCompanyNews(tickers, apiKey)
            : await fetchMarketNews(apiKey);

        const payload = {
            provider: 'finnhub',
            tickers,
            items: normalizeItems(news).slice(0, MAX_NEWS_ITEMS),
            updatedAt: new Date().toISOString(),
        };
        cache.set(cacheKey, { ts: Date.now(), payload });
        return res.status(200).json(payload);
    } catch (error) {
        return res.status(502).json({ message: error.message || 'News fetch failed' });
    }
}

function parseTickers(value) {
    return String(value || '')
        .split(',')
        .map((ticker) => ticker.trim().toUpperCase())
        .filter((ticker) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker))
        .slice(0, MAX_TICKERS);
}

async function fetchCompanyNews(tickers, apiKey) {
    const to = new Date();
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

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

function normalizeItems(rawItems) {
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
                url: String(item.url || '').trim(),
                source: String(item.source || 'Finnhub').trim(),
                image: String(item.image || '').trim(),
                related,
                datetime: Number(item.datetime) || 0,
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

async function verifySupabaseAuth(req) {
    const SUPABASE_URL = (
        process.env.SUPABASE_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        DEFAULT_SUPABASE_URL
    ).replace(/\/$/, '');
    const SUPABASE_ANON_KEY =
        process.env.SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        DEFAULT_SUPABASE_ANON_KEY;

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
