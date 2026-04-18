/**
 * Проксі хвилинних агрегатів Polygon з секретом POLYGON_API_KEY.
 * Тіло: { symbol: "AAPL", fromMs: number, toMs: number } (unix ms, як у Polygon v2 aggs).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

function cors(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors(), 'Content-Type': 'application/json' },
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
        return new Response(null, { status: 204, headers: cors() });
    }
    if (req.method !== 'POST') {
        return json({ message: 'Method not allowed' }, 405);
    }

    const v = await verifyUserJwt(req.headers.get('Authorization'));
    if (!v.ok) return json({ message: v.message }, v.status);

    const POLYGON_API_KEY = Deno.env.get('POLYGON_API_KEY');
    if (!POLYGON_API_KEY) {
        return json(
            {
                message:
                    'POLYGON_API_KEY не задано. Supabase → Edge Functions → Secrets, або: supabase secrets set POLYGON_API_KEY=...',
                results: [],
            },
            500,
        );
    }

    let body: { symbol?: string; fromMs?: number; toMs?: number };
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400);
    }

    const symbol = String(body?.symbol || '').toUpperCase().trim();
    const fromMs = Number(body?.fromMs);
    const toMs = Number(body?.toMs);
    if (!symbol || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        return json({ message: 'Missing symbol, fromMs, toMs' }, 400);
    }
    if (!/^[A-Z]{1,10}$/.test(symbol)) {
        return json({ message: 'Invalid symbol' }, 400);
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
        pRes = await fetch(url);
    } catch (e) {
        return json({ message: (e as Error).message || 'Polygon fetch failed' }, 502);
    }

    const data = await pRes.json();
    return new Response(JSON.stringify(data), {
        status: pRes.ok ? 200 : pRes.status,
        headers: { ...cors(), 'Content-Type': 'application/json' },
    });
});
