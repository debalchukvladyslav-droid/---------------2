/**
 * Проксі хвилинних агрегатів Polygon з секретом POLYGON_API_KEY.
 * Тіло: { symbol: "AAPL", fromMs: number, toMs: number } (unix ms, як у Polygon v2 aggs).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createPolygonStore } from '../_shared/polygon_store.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const POLYGON_DISABLED = false;
const DEFAULT_ALLOWED_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);

function allowedOrigins(): Set<string> {
    const configured = (Deno.env.get('APP_ALLOWED_ORIGINS') || Deno.env.get('ALLOWED_ORIGINS') || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function cors(req?: Request): Record<string, string> {
    const origin = req?.headers.get('Origin')?.trim() || '';
    const allowOrigin = origin && allowedOrigins().has(origin)
        ? origin
        : 'https://traderjournal-six.vercel.app';
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin',
    };
}

function json(body: unknown, status = 200, req?: Request) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors(req), 'Content-Type': 'application/json' },
    });
}

function serviceRest(path: string, init: RequestInit = {}) {
    const url = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return Promise.resolve(new Response(JSON.stringify({ message: 'Supabase service env missing' }), { status: 503 }));
    return fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
}

function sharedPolygon() {
    return createPolygonStore({ rest: serviceRest });
}

async function fetchPolygonPages(firstUrl: string, apiKey: string) {
    const results: any[] = [];
    let next = firstUrl;
    let status = 502;
    let payload: any = {};
    for (let page = 0; page < 10 && next; page += 1) {
        const response = await fetch(next, { signal: AbortSignal.timeout(12000) });
        status = response.status;
        payload = await response.json().catch(() => ({}));
        if (!response.ok) return { ok: false, status, payload, results, complete: false };
        if (Array.isArray(payload?.results)) results.push(...payload.results);
        const nextUrl = typeof payload?.next_url === 'string' ? payload.next_url : '';
        if (!nextUrl) return { ok: true, status: 200, payload, results, complete: true };
        const url = new URL(nextUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'api.polygon.io') {
            return { ok: true, status: 200, payload, results, complete: false };
        }
        if (!url.searchParams.has('apiKey')) url.searchParams.set('apiKey', apiKey);
        next = url.toString();
    }
    return { ok: true, status, payload, results, complete: false };
}

async function verifyUserJwt(authHeader: string | null): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    if (!authHeader?.startsWith('Bearer ')) {
        return { ok: false, status: 401, message: 'Missing auth token' };
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anon) {
        return { ok: false, status: 500, message: 'Supabase env missing on Edge' };
    }
    const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: authHeader, apikey: anon },
    });
    if (!authRes.ok) return { ok: false, status: 401, message: 'Invalid auth token' };
    return { ok: true };
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors(req) });
    }
    if (POLYGON_DISABLED) {
        return json({ message: 'Polygon тимчасово вимкнено адміністратором.', results: [] }, 503, req);
    }
    if (req.method !== 'POST') {
        return json({ message: 'Method not allowed' }, 405, req);
    }

    const v = await verifyUserJwt(req.headers.get('Authorization'));
    if (!v.ok) return json({ message: v.message }, v.status, req);

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_REQUEST_BYTES) {
        return json({ message: 'Request body is too large' }, 413, req);
    }

    let body: { mode?: string; symbol?: string; from?: string; to?: string; fromMs?: number; toMs?: number };
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400, req);
    }

    if (body?.mode === 'daily') {
        return proxyDailyBars(body, req);
    }

    const symbol = String(body?.symbol || '').toUpperCase().trim();
    const fromMs = Math.trunc(Number(body?.fromMs));
    const toMs = Math.trunc(Number(body?.toMs));
    if (!symbol || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        return json({ message: 'Missing symbol, fromMs, toMs' }, 400, req);
    }
    if (!/^[A-Z]{1,10}$/.test(symbol)) {
        return json({ message: 'Invalid symbol' }, 400, req);
    }
    const nowPlusOneDay = Date.now() + 24 * 60 * 60 * 1000;
    if (fromMs < MIN_TIMESTAMP_MS || toMs < MIN_TIMESTAMP_MS || fromMs > toMs || toMs > nowPlusOneDay) {
        return json({ message: 'Invalid date range' }, 400, req);
    }
    if (toMs - fromMs > MAX_RANGE_MS) {
        return json({ message: 'Date range is too large' }, 400, req);
    }

    const store = sharedPolygon();
    const stored = await store.read(symbol, 'minute', fromMs, toMs).catch(() => ({ hit: false, results: [] as any[] }));
    if (stored.hit) {
        return json({ status: 'OK', results: stored.results, resultsCount: stored.results.length, source: 'database' }, 200, req);
    }

    const POLYGON_API_KEY = Deno.env.get('POLYGON_API_KEY');
    if (!POLYGON_API_KEY) {
        return json(
            {
                message:
                    'POLYGON_API_KEY не задано. Supabase → Edge Functions → Secrets, або: supabase secrets set POLYGON_API_KEY=...',
                results: [],
            },
            500,
            req,
        );
    }

    const q = new URLSearchParams({
        adjusted: 'false',
        sort: 'asc',
        limit: '50000',
        apiKey: POLYGON_API_KEY,
    });
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${fromMs}/${toMs}?${q}`;

    let fetched: Awaited<ReturnType<typeof fetchPolygonPages>>;
    try {
        fetched = await fetchPolygonPages(url, POLYGON_API_KEY);
    } catch (e) {
        return json({ message: (e as Error).message || 'Polygon fetch failed' }, 502, req);
    }

    const polygonMessage = typeof fetched.payload?.message === 'string' ? fetched.payload.message : '';
    if (fetched.status === 403 && /plan doesn't include this data timeframe/i.test(polygonMessage)) {
        return json(
            {
                code: 'POLYGON_PLAN_TIMEFRAME',
                message: 'Поточний тариф Polygon не включає хвилинні дані за цей період.',
                providerMessage: polygonMessage,
                results: [],
            },
            403,
            req,
        );
    }
    if (!fetched.ok) {
        return new Response(JSON.stringify(fetched.payload), {
            status: fetched.status,
            headers: { ...cors(req), 'Content-Type': 'application/json' },
        });
    }
    await store.write({
        symbol,
        granularity: 'minute',
        rangeStart: fromMs,
        rangeEnd: toMs,
        results: fetched.results,
        complete: fetched.complete,
    }).catch((error) => console.warn(`[Polygon bars] write failed ${symbol}: ${error?.message || error}`));
    return json({
        ...fetched.payload,
        results: fetched.results,
        resultsCount: fetched.results.length,
        source: 'polygon',
    }, 200, req);
});

async function proxyDailyBars(
    body: { symbol?: string; from?: string; to?: string },
    req: Request,
) {
    const symbol = String(body.symbol || '').toUpperCase().trim();
    const from = String(body.from || '');
    const to = String(body.to || '');
    if (!/^[A-Z][A-Z0-9.:_-]{0,20}$/.test(symbol)) {
        return json({ message: 'Invalid symbol' }, 400, req);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return json({ message: 'Invalid date range' }, 400, req);
    }
    const span = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
    if (!Number.isFinite(span) || span > 800 * 24 * 60 * 60 * 1000) {
        return json({ message: 'Date range is too large' }, 400, req);
    }

    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    const store = sharedPolygon();
    const stored = await store.read(symbol, 'day', fromMs, toMs).catch(() => ({ hit: false, results: [] as any[] }));
    if (stored.hit) {
        return json({ status: 'OK', results: stored.results, resultsCount: stored.results.length, source: 'database' }, 200, req);
    }

    const apiKey = Deno.env.get('POLYGON_API_KEY');
    if (!apiKey) {
        return json({ message: 'POLYGON_API_KEY не задано.', results: [] }, 500, req);
    }
    const q = new URLSearchParams({
        adjusted: 'true',
        sort: 'asc',
        limit: '50000',
        apiKey,
    });
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}?${q}`;
    let fetched: Awaited<ReturnType<typeof fetchPolygonPages>>;
    try {
        fetched = await fetchPolygonPages(url, apiKey);
    } catch (error) {
        return json({ message: (error as Error).message || 'Polygon fetch failed' }, 502, req);
    }
    if (!fetched.ok) {
        return new Response(JSON.stringify(fetched.payload), {
            status: fetched.status,
            headers: { ...cors(req), 'Content-Type': 'application/json' },
        });
    }
    await store.write({
        symbol,
        granularity: 'day',
        rangeStart: fromMs,
        rangeEnd: toMs,
        toDate: to,
        results: fetched.results,
        complete: fetched.complete,
    }).catch((error) => console.warn(`[Polygon bars] daily write failed ${symbol}: ${error?.message || error}`));
    return json({
        ...fetched.payload,
        results: fetched.results,
        resultsCount: fetched.results.length,
        source: 'polygon',
    }, 200, req);
}
