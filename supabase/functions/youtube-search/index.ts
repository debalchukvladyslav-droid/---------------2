/**
 * YouTube Data API v3 search через секрет YOUTUBE_API_KEY (опційно).
 * POST { query: string }
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

    const key = Deno.env.get('YOUTUBE_API_KEY');
    if (!key) {
        return json({ items: [], message: 'YOUTUBE_API_KEY not set' }, 200);
    }

    let body: { query?: string };
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400);
    }
    const q = String(body?.query || '').trim();
    if (!q) return json({ message: 'Missing query' }, 400);

    const u = new URL('https://www.googleapis.com/youtube/v3/search');
    u.searchParams.set('part', 'snippet');
    u.searchParams.set('q', q);
    u.searchParams.set('type', 'video');
    u.searchParams.set('maxResults', '3');
    u.searchParams.set('relevanceLanguage', 'en');
    u.searchParams.set('key', key);

    let yRes: Response;
    try {
        yRes = await fetch(u.toString());
    } catch (e) {
        return json({ message: (e as Error).message || 'YouTube fetch failed' }, 502);
    }

    const data = await yRes.json();
    return new Response(JSON.stringify(data), {
        status: yRes.ok ? 200 : yRes.status,
        headers: { ...cors(), 'Content-Type': 'application/json' },
    });
});
