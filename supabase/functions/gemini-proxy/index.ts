/**
 * Проксі Gemini з секретом GEMINI_API_KEY (Supabase Dashboard → Edge Functions → Secrets).
 * Клієнт: POST + Authorization: Bearer <access_token користувача>.
 * Тіло: { payload, model? } — як у колишньому /api/gemini.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([DEFAULT_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-pro']);
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
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

function payloadSizeOk(obj: unknown): boolean {
    try {
        return new TextEncoder().encode(JSON.stringify(obj)).length <= MAX_PAYLOAD_BYTES;
    } catch {
        return false;
    }
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

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
    if (!GEMINI_API_KEY) {
        return json(
            {
                message:
                    'GEMINI_API_KEY не задано. Supabase Dashboard → Project Settings → Edge Functions → Secrets, або: supabase secrets set GEMINI_API_KEY=...',
            },
            500,
            req,
        );
    }

    let body: { payload?: unknown; model?: string };
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400, req);
    }

    const { payload, model: rawModel } = body || {};
    if (!payload || typeof payload !== 'object') {
        return json({ message: 'Missing payload' }, 400, req);
    }
    if (!payloadSizeOk(payload)) {
        return json({ message: 'AI payload is too large' }, 413, req);
    }

    const model = typeof rawModel === 'string' && ALLOWED_MODELS.has(rawModel) ? rawModel : DEFAULT_MODEL;
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    let geminiRes: Response;
    try {
        geminiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25000),
        });
    } catch (e) {
        return json({ message: (e as Error).message || 'Gemini fetch failed' }, 502, req);
    }

    let data: Record<string, unknown>;
    try {
        data = (await geminiRes.json()) as Record<string, unknown>;
    } catch {
        return json({ message: 'Invalid JSON from Gemini' }, 502, req);
    }

    if (!geminiRes.ok) {
        const err = data?.error as { message?: string } | undefined;
        return json({ message: err?.message || `Gemini error ${geminiRes.status}` }, geminiRes.status, req);
    }

    const candidates = data?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    const parts = candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim()
        : '';

    if (!text) return json({ message: 'Empty response from Gemini' }, 502, req);
    return json({ text }, 200, req);
});
