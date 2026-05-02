const CNN_FEAR_GREED_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ALLOWED_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);

let cache = { ts: 0, payload: null };

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

    const authResult = await verifySupabaseAuth(req);
    if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message });

    if (cache.payload && Date.now() - cache.ts < CACHE_TTL_MS) {
        return res.status(200).json({ ...cache.payload, cached: true });
    }

    try {
        const raw = await fetchCnnFearGreed();
        const payload = normalizeFearGreedPayload(raw);
        cache = { ts: Date.now(), payload };
        return res.status(200).json(payload);
    } catch (error) {
        const degraded = {
            provider: 'cnn',
            sourceUrl: 'https://www.cnn.com/markets/fear-and-greed',
            degraded: true,
            reason: error.message || 'Fear & Greed fetch failed',
            updatedAt: new Date().toISOString(),
        };
        cache = { ts: Date.now(), payload: degraded };
        return res.status(200).json(degraded);
    }
}

async function fetchCnnFearGreed() {
    const response = await fetch(CNN_FEAR_GREED_URL, {
        headers: {
            accept: 'application/json',
            referer: 'https://edition.cnn.com/',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
        throw new Error(data?.message || `CNN Fear & Greed error ${response.status}`);
    }
    return data;
}

function normalizeFearGreedPayload(raw) {
    const fg = raw?.fear_and_greed || {};
    const score = normalizeScore(fg.score);
    const rating = normalizeRating(fg.rating, score);
    const previous = {
        close: normalizeScore(fg.previous_close),
        week: normalizeScore(fg.previous_1_week),
        month: normalizeScore(fg.previous_1_month),
        year: normalizeScore(fg.previous_1_year),
    };

    return {
        provider: 'cnn',
        sourceUrl: 'https://www.cnn.com/markets/fear-and-greed',
        score,
        rating,
        ratingLabel: ratingToLabel(rating),
        timestamp: normalizeTimestamp(fg.timestamp),
        previous,
        history: normalizeHistory(raw?.fear_and_greed_historical?.data),
        indicators: normalizeIndicators(raw),
        updatedAt: new Date().toISOString(),
    };
}

function normalizeHistory(items) {
    return Array.isArray(items)
        ? items
            .map((item) => ({
                date: normalizeTimestamp(Number(item.x)),
                score: normalizeScore(item.y),
                rating: normalizeRating(item.rating, item.y),
            }))
            .filter((item) => item.date && item.score !== null)
            .slice(-30)
        : [];
}

function normalizeIndicators(raw) {
    const keys = [
        'market_momentum_sp500',
        'stock_price_strength',
        'stock_price_breadth',
        'put_call_options',
        'market_volatility_vix',
        'junk_bond_demand',
        'safe_haven_demand',
    ];
    return keys.reduce((acc, key) => {
        if (!raw?.[key]) return acc;
        acc[key] = {
            score: normalizeScore(raw[key].score),
            rating: normalizeRating(raw[key].rating, raw[key].score),
        };
        return acc;
    }, {});
}

function normalizeScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function normalizeRating(value, score) {
    const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (raw) return raw;
    const n = Number(score);
    if (!Number.isFinite(n)) return 'neutral';
    if (n <= 25) return 'extreme_fear';
    if (n < 45) return 'fear';
    if (n <= 55) return 'neutral';
    if (n < 75) return 'greed';
    return 'extreme_greed';
}

function ratingToLabel(rating) {
    return {
        extreme_fear: 'Extreme Fear',
        fear: 'Fear',
        neutral: 'Neutral',
        greed: 'Greed',
        extreme_greed: 'Extreme Greed',
    }[rating] || 'Neutral';
}

function normalizeTimestamp(value) {
    if (!value) return null;
    const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
