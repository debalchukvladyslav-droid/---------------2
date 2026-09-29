import { supabaseRest, verifySupabaseUser } from './google_sheet_sync.js';
import { readTelegramFloats } from './telegram_float_read.js';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

async function requireAdmin(authHeader) {
    const user = await verifySupabaseUser(authHeader);
    if (!user) return null;
    const profiles = await supabaseRest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`);
    return profiles?.[0]?.role === 'admin' ? user : null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }
    try {
        const admin = await requireAdmin(req.headers.authorization || '');
        if (!admin) return sendJson(res, 403, { ok: false, error: 'Лише для адміна' });
        const dates = Array.isArray(req.body?.dates) ? req.body.dates.map((date) => String(date || '').slice(0, 10)) : [];
        const chat = String(req.body?.chat || '').trim().slice(0, 80);
        const result = await readTelegramFloats(dates, chat);
        return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
        console.error('[telegram-float]', error?.message || error);
        return sendJson(res, 200, {
            ok: true,
            connected: false,
            floats: {},
            note: 'Не вдалося прочитати групу Telegram.',
        });
    }
}
