const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_MODELS = new Set([
    DEFAULT_MODEL,
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
]);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const authResult = await verifySupabaseAuth(req);
    if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY not configured on server' });

    const { payload, model: rawModel } = req.body || {};
    if (!payload || typeof payload !== 'object') return res.status(400).json({ message: 'Missing payload' });
    if (!isPayloadSizeAllowed(payload)) return res.status(413).json({ message: 'AI payload is too large' });

    const model = typeof rawModel === 'string' && ALLOWED_MODELS.has(rawModel)
        ? rawModel
        : DEFAULT_MODEL;

    const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;

    let geminiRes;
    try {
        geminiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25000),
        });
    } catch (e) {
        return res.status(502).json({ message: e.message || 'Gemini fetch failed' });
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

function isPayloadSizeAllowed(payload) {
    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES;
    } catch {
        return false;
    }
}

async function verifySupabaseAuth(req) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return { ok: false, status: 500, message: 'Supabase auth env is not configured on server' };
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return { ok: false, status: 401, message: 'Missing auth token' };

    try {
        const authRes = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
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
