/**
 * YouTube Data API v3 search через секрет YOUTUBE_API_KEY (опційно).
 * POST { query: string }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_QUERY_LENGTH = 160;
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

    const key = Deno.env.get('YOUTUBE_API_KEY');
    if (!key) {
        return json({ items: [], message: 'YOUTUBE_API_KEY not set' }, 200, req);
    }

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_REQUEST_BYTES) {
        return json({ message: 'Request body is too large' }, 413, req);
    }

    let body: { query?: string };
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400, req);
    }
    const q = String(body?.query || '').trim();
    if (!q) return json({ message: 'Missing query' }, 400, req);
    if (q.length > MAX_QUERY_LENGTH) return json({ message: 'Query is too long' }, 400, req);

    const u = new URL('https://www.googleapis.com/youtube/v3/search');
    u.searchParams.set('part', 'snippet');
    u.searchParams.set('q', q);
    u.searchParams.set('type', 'video');
    u.searchParams.set('maxResults', '3');
    u.searchParams.set('relevanceLanguage', 'en');
    u.searchParams.set('key', key);

    let yRes: Response;
    try {
        yRes = await fetch(u.toString(), { signal: AbortSignal.timeout(12000) });
    } catch (e) {
        return json({ message: (e as Error).message || 'YouTube fetch failed' }, 502, req);
    }

    const data = await yRes.json();
    return new Response(JSON.stringify(data), {
        status: yRes.ok ? 200 : yRes.status,
        headers: { ...cors(req), 'Content-Type': 'application/json' },
    });
});
