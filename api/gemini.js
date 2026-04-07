const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY not configured on server' });

    const { payload, model: rawModel } = req.body || {};
    if (!payload || typeof payload !== 'object') return res.status(400).json({ message: 'Missing payload' });

    const model = typeof rawModel === 'string' && rawModel.startsWith('gemini-')
        ? rawModel
        : 'gemini-2.5-flash';

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
