export const config = { runtime: 'edge' };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders(),
        });
    }

    if (req.method !== 'POST') {
        return json({ message: 'Method not allowed' }, 405);
    }

    if (!GEMINI_API_KEY) {
        return json({ message: 'GEMINI_API_KEY not configured' }, 500);
    }

    let body;
    try {
        body = await req.json();
    } catch {
        return json({ message: 'Invalid JSON' }, 400);
    }

    const model = typeof body.model === 'string' && body.model.startsWith('gemini-')
        ? body.model
        : 'gemini-2.5-flash';

    const payload = body.payload;
    if (!payload || typeof payload !== 'object') {
        return json({ message: 'Missing payload' }, 400);
    }

    const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let geminiRes;
    try {
        geminiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } catch (e) {
        return json({ message: e.message || 'Gemini fetch failed' }, 502);
    } finally {
        clearTimeout(timeout);
    }

    const raw = await geminiRes.text();
    let data;
    try { data = JSON.parse(raw); } catch { return json({ message: 'Invalid JSON from Gemini' }, 502); }

    if (!geminiRes.ok) {
        const msg = data?.error?.message || `Gemini error ${geminiRes.status}`;
        return json({ message: msg }, geminiRes.status);
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim()
        : '';

    if (!text) return json({ message: 'Empty response from Gemini' }, 502);

    return json({ text }, 200);
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
}
