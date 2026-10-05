import { createAssistantDb } from './db.js';
import { runAssistantAgent } from './agent.js';

const DEFAULT_ALLOWED_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const authResult = await verifySupabaseAuth(req);
    if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message });

    const message = req.body?.message ?? req.body?.text ?? '';
    const pageContext = req.body?.pageContext || {};
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    const url = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !serviceKey) {
        return res.status(500).json({ message: 'Supabase assistant env is not configured' });
    }

    try {
        const db = createAssistantDb({ url, serviceKey });
        const result = await runAssistantAgent({
            db,
            user: authResult.user,
            message,
            pageContext,
            history,
        });
        return res.status(200).json(result);
    } catch (error) {
        const status = Number(error?.status) || 502;
        return res.status(status).json({ message: error?.message || 'Assistant failed' });
    }
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    const allowed = getAllowedOrigins();
    if (origin && allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', 'https://traderjournal-six.vercel.app');
    res.setHeader('Vary', 'Origin');
}

function getAllowedOrigins() {
    const configured = String(process.env.ALLOWED_ORIGINS || process.env.APP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
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
        return { ok: true, user: await authRes.json() };
    } catch (error) {
        return { ok: false, status: 502, message: error.message || 'Supabase auth check failed' };
    }
}
