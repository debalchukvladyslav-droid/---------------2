/**
 * Проксі Gemini з секретом GEMINI_API_KEY (Supabase Dashboard → Edge Functions → Secrets).
 * Клієнт: POST + Authorization: Bearer <access_token користувача>.
 * Тіло: { payload, model? } — як у колишньому /api/gemini.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.5';
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

    if (shouldUseOpenRouter()) {
        return handleOpenRouter(req, payload);
    }

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

    const model = typeof rawModel === 'string' && ALLOWED_MODELS.has(rawModel) ? rawModel : DEFAULT_MODEL;
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const referer = getGeminiReferer(req);

    let geminiRes: Response;
    try {
        geminiRes = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(50000),
        });
    } catch (e) {
        return json({ message: normalizeGeminiFetchError(e) }, 502, req);
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

async function handleOpenRouter(req: Request, payload: unknown): Promise<Response> {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) return json({ message: 'OPENROUTER_API_KEY not configured on Edge' }, 500, req);

    const referer = getGeminiReferer(req);
    const body = {
        model: getOpenRouterModel(),
        messages: geminiPayloadToOpenAIMessages(payload),
        temperature: 0.35,
    };

    let openRouterRes: Response;
    try {
        openRouterRes = await fetch(OPENROUTER_CHAT_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...(referer ? { 'HTTP-Referer': referer } : {}),
                'X-Title': 'Trading Journal Pro',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(50000),
        });
    } catch (e) {
        return json({ message: normalizeGeminiFetchError(e) }, 502, req);
    }

    let data: Record<string, unknown>;
    try {
        data = (await openRouterRes.json()) as Record<string, unknown>;
    } catch {
        return json({ message: 'Invalid JSON from OpenRouter' }, 502, req);
    }

    if (!openRouterRes.ok) {
        const err = data?.error as { message?: string } | undefined;
        return json({ message: err?.message || `OpenRouter error ${openRouterRes.status}` }, openRouterRes.status, req);
    }

    const text = extractOpenRouterText(data);
    if (!text) return json({ message: 'Empty response from OpenRouter' }, 502, req);
    return json({ text }, 200, req);
}

function getGeminiReferer(req: Request): string {
    const raw = [
        Deno.env.get('GEMINI_REFERER'),
        Deno.env.get('APP_PUBLIC_URL'),
        req.headers.get('Origin'),
        'https://traderjournal-six.vercel.app',
    ]
        .map((value) => String(value || '').trim())
        .find(Boolean);

    if (!raw) return '';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const url = new URL(withProtocol);
        return `${url.origin}/`;
    } catch {
        return '';
    }
}

function normalizeGeminiFetchError(error: unknown): string {
    const err = error as { name?: string; message?: string };
    const message = String(err?.message || error || '');
    const name = String(err?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError' || /aborted|abort|timeout|timed out/i.test(message)) {
        return 'Gemini довго не відповідає. Спробуйте ще раз або зробіть запит коротшим.';
    }
    return message || 'Gemini fetch failed';
}

function shouldUseOpenRouter(): boolean {
    const provider = String(Deno.env.get('AI_PROVIDER') || Deno.env.get('LLM_PROVIDER') || '').trim().toLowerCase();
    return provider === 'openrouter' || (!!getOpenRouterApiKey() && !Deno.env.get('GEMINI_API_KEY'));
}

function getOpenRouterApiKey(): string {
    return String(Deno.env.get('OPENROUTER_API_KEY') || Deno.env.get('OPENROUTER_KEY') || '').trim();
}

function getOpenRouterModel(): string {
    return String(Deno.env.get('OPENROUTER_MODEL') || Deno.env.get('AI_MODEL') || DEFAULT_OPENROUTER_MODEL).trim();
}

function geminiPayloadToOpenAIMessages(payload: unknown): Array<{ role: string; content: string | unknown[] }> {
    const p = payload as {
        systemInstruction?: { parts?: Array<{ text?: string }> };
        contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
    };
    const messages: Array<{ role: string; content: string | unknown[] }> = [];
    const systemText = partsToText(p?.systemInstruction?.parts);
    if (systemText) messages.push({ role: 'system', content: systemText });

    const contents = Array.isArray(p?.contents) ? p.contents : [];
    for (const item of contents) {
        const role = item?.role === 'model' ? 'assistant' : 'user';
        const content = geminiPartsToOpenAIContent(item?.parts);
        if (typeof content === 'string' ? content.trim() : content.length) {
            messages.push({ role, content });
        }
    }

    return messages.length ? messages : [{ role: 'user', content: 'Проаналізуй дані трейдинг-журналу.' }];
}

function geminiPartsToOpenAIContent(parts: Array<Record<string, unknown>> | undefined): string | unknown[] {
    const normalized = Array.isArray(parts) ? parts : [];
    const content: unknown[] = [];

    for (const part of normalized) {
        if (typeof part?.text === 'string' && part.text.trim()) {
            content.push({ type: 'text', text: part.text });
        }
        const inline = (part?.inline_data || part?.inlineData) as { data?: string; mime_type?: string; mimeType?: string } | undefined;
        if (inline?.data) {
            const mimeType = inline.mime_type || inline.mimeType || 'image/jpeg';
            content.push({
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${inline.data}` },
            });
        }
    }

    const only = content[0] as { type?: string; text?: string } | undefined;
    if (content.length === 1 && only?.type === 'text') return only.text || '';
    return content;
}

function partsToText(parts: Array<{ text?: string }> | undefined): string {
    return Array.isArray(parts)
        ? parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim()
        : '';
}

function extractOpenRouterText(data: Record<string, unknown>): string {
    const choices = data?.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const content = choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
    }
    return '';
}
