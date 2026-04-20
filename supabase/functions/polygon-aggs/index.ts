/**
 * Проксі хвилинних агрегатів Polygon з секретом POLYGON_API_KEY.
 * Тіло: { symbol: "AAPL", fromMs: number, toMs: number } (unix ms, як у Polygon v2 aggs).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
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
    if (req.method !== 'POST') {
        return json({ message: 'Method not allowed' }, 405, req);
    }

    const v = await verifyUserJwt(req.headers.get('Authorization'));
    if (!v.ok) return json({ message: v.message }, v.status, req);

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

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_REQUEST_BYTES) {
        return json({ message: 'Request body is too large' }, 413, req);
    }

    let body: { symbol?: string; fromMs?: number; toMs?: number };
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400, req);
    }

    const symbol = String(body?.symbol || '').toUpperCase().trim();
    const fromMs = Number(body?.fromMs);
    const toMs = Number(body?.toMs);
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

    const q = new URLSearchParams({
        adjusted: 'false',
        sort: 'asc',
        limit: '1000',
        apiKey: POLYGON_API_KEY,
    });
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${fromMs}/${toMs}?${q}`;

    let pRes: Response;
    try {
        pRes = await fetch(url, { signal: AbortSignal.timeout(12000) });
    } catch (e) {
        return json({ message: (e as Error).message || 'Polygon fetch failed' }, 502, req);
    }

    const data = await pRes.json();
    return new Response(JSON.stringify(data), {
        status: pRes.ok ? 200 : pRes.status,
        headers: { ...cors(req), 'Content-Type': 'application/json' },
    });
});
