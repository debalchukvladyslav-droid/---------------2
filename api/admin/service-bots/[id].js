import { requireAdmin, sendJson } from '../../_service_bots_lib.js';
import { supabaseRest } from '../../_google_sheet_sync_lib.js';

function cleanId(value) {
    const id = String(value || '').trim();
    return /^\d+$/.test(id) || /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        const id = cleanId(req.query?.id);
        if (!id) return sendJson(res, 400, { ok: false, error: 'Invalid bot id' });

        if (req.method === 'PATCH') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
            const patch = {};
            if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 120) || 'Service bot';
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
            if (body.extra_data && typeof body.extra_data === 'object') patch.extra_data = body.extra_data;
            if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'No changes' });
            patch.updated_at = new Date().toISOString();

            const updated = await supabaseRest(`bots?id=eq.${encodeURIComponent(id)}&select=id,name,bot_type,user_id,extra_data,enabled,last_used_at,created_at,updated_at`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify(patch),
            });
            return sendJson(res, 200, { ok: true, bot: updated?.[0] || null });
        }

        if (req.method === 'DELETE') {
            await supabaseRest(`bots?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
            return sendJson(res, 200, { ok: true });
        }

        res.setHeader('Allow', 'PATCH, DELETE');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
        const status = error?.status || 500;
        return sendJson(res, status, { ok: false, error: error?.message || String(error) });
    }
}
