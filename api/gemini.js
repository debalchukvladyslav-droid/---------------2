const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.5';
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_ALLOWED_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);
const ALLOWED_MODELS = new Set([
    DEFAULT_MODEL,
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
]);

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const authResult = await verifySupabaseAuth(req);
    if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message });

    const { payload, model: rawModel } = req.body || {};
    if (!payload || typeof payload !== 'object') return res.status(400).json({ message: 'Missing payload' });
    if (!isPayloadSizeAllowed(payload)) return res.status(413).json({ message: 'AI payload is too large' });

    if (shouldUseOpenRouter()) {
        return handleOpenRouter(req, res, payload);
    }

    const GEMINI_API_KEY = getGeminiApiKey();
    if (!GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY not configured on server' });

    const model = typeof rawModel === 'string' && ALLOWED_MODELS.has(rawModel)
        ? rawModel
        : DEFAULT_MODEL;

    const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const referer = getGeminiReferer(req);

    let geminiRes;
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
        return res.status(502).json({ message: normalizeGeminiFetchError(e) });
    }

    let data;
    try { data = await geminiRes.json(); } catch { return res.status(502).json({ message: 'Invalid JSON from Gemini' }); }

    if (!geminiRes.ok) {
        return res.status(geminiRes.status).json({ message: data?.error?.message || `Gemini error ${geminiRes.status}` });
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim()
        : '';

    if (!text) return res.status(502).json({ message: 'Empty response from Gemini' });

    return res.status(200).json({ text });
}

async function handleOpenRouter(req, res, payload) {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) return res.status(500).json({ message: 'OPENROUTER_API_KEY not configured on server' });

    const referer = getGeminiReferer(req);
    const model = getOpenRouterModel();
    const body = {
        model,
        messages: geminiPayloadToOpenAIMessages(payload),
        temperature: 0.35,
    };

    let openRouterRes;
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
        return res.status(502).json({ message: normalizeGeminiFetchError(e) });
    }

    let data;
    try { data = await openRouterRes.json(); } catch { return res.status(502).json({ message: 'Invalid JSON from OpenRouter' }); }

    if (!openRouterRes.ok) {
        return res.status(openRouterRes.status).json({ message: data?.error?.message || `OpenRouter error ${openRouterRes.status}` });
    }

    const text = extractOpenRouterText(data);
    if (!text) return res.status(502).json({ message: 'Empty response from OpenRouter' });
    return res.status(200).json({ text });
}

function shouldUseOpenRouter() {
    const provider = String(process.env.AI_PROVIDER || process.env.LLM_PROVIDER || '').trim().toLowerCase();
    return provider === 'openrouter' || (!!getOpenRouterApiKey() && !getGeminiApiKey());
}

function getOpenRouterApiKey() {
    return String(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || '').trim();
}

function getOpenRouterModel() {
    return String(process.env.OPENROUTER_MODEL || process.env.AI_MODEL || DEFAULT_OPENROUTER_MODEL).trim();
}

function geminiPayloadToOpenAIMessages(payload) {
    const messages = [];
    const systemText = partsToText(payload?.systemInstruction?.parts);
    if (systemText) messages.push({ role: 'system', content: systemText });

    const contents = Array.isArray(payload?.contents) ? payload.contents : [];
    for (const item of contents) {
        const role = item?.role === 'model' ? 'assistant' : 'user';
        const content = geminiPartsToOpenAIContent(item?.parts);
        if (typeof content === 'string' ? content.trim() : content.length) {
            messages.push({ role, content });
        }
    }

    return messages.length ? messages : [{ role: 'user', content: 'Проаналізуй дані трейдинг-журналу.' }];
}

function geminiPartsToOpenAIContent(parts) {
    const normalized = Array.isArray(parts) ? parts : [];
    const content = [];
    for (const part of normalized) {
        if (typeof part?.text === 'string' && part.text.trim()) {
            content.push({ type: 'text', text: part.text });
        }
        const inline = part?.inline_data || part?.inlineData;
        if (inline?.data) {
            const mimeType = inline.mime_type || inline.mimeType || 'image/jpeg';
            content.push({
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${inline.data}` },
            });
        }
    }
    if (content.length === 1 && content[0].type === 'text') return content[0].text;
    return content;
}

function partsToText(parts) {
    return Array.isArray(parts)
        ? parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim()
        : '';
}

function extractOpenRouterText(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
    }
    return '';
}

function normalizeGeminiFetchError(error) {
    const message = String(error?.message || error || '');
    const name = String(error?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError' || /aborted|abort|timeout|timed out/i.test(message)) {
        return 'Gemini довго не відповідає. Спробуйте ще раз або зробіть запит коротшим.';
    }
    return message || 'Gemini fetch failed';
}

function getGeminiApiKey() {
    return [
        process.env.GEMINI_API_KEY,
        process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        process.env.GOOGLE_AI_API_KEY,
        process.env.GEMINI_KEY,
    ]
        .map((value) => String(value || '').trim())
        .find(Boolean) || '';
}

function getGeminiReferer(req) {
    const raw = [
        process.env.GEMINI_REFERER,
        process.env.APP_PUBLIC_URL,
        process.env.NEXT_PUBLIC_SITE_URL,
        req.headers.origin,
        process.env.VERCEL_PROJECT_PRODUCTION_URL,
        process.env.VERCEL_URL,
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

function isPayloadSizeAllowed(payload) {
    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES;
    } catch {
        return false;
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
