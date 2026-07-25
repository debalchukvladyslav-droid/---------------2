import { requireAdmin, sendJson } from '../../lib/service_bots.js';
import { supabaseRest } from '../_google_sheet_sync_lib.js';

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        if (req.method === 'GET') {
            const rows = await supabaseRest(
                'profiles?select=id,nick,email,first_name,last_name,team,role,settings,created_at&order=created_at.desc',
            );
            const requests = (rows || []).filter(row =>
                row.role !== 'admin'
                && row.settings?.account_approved !== true
                && row.settings?.registration_request?.status !== 'rejected'
            );
            return sendJson(res, 200, { ok: true, requests });
        }
        if (req.method !== 'PATCH') {
            res.setHeader('Allow', 'GET, PATCH');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const userId = String(body.user_id || '').trim();
        const action = String(body.action || '').trim();
        if (!userId || !['approve', 'reject'].includes(action)) {
            return sendJson(res, 400, { ok: false, error: 'Invalid request' });
        }
        const rows = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(userId)}&select=id,settings&limit=1`,
        );
        const profile = rows?.[0];
        if (!profile) return sendJson(res, 404, { ok: false, error: 'Profile not found' });
        const now = new Date().toISOString();
        const settings = {
            ...(profile.settings || {}),
            account_approved: action === 'approve',
            account_blocked: action === 'reject',
            registration_request: {
                ...(profile.settings?.registration_request || {}),
                status: action === 'approve' ? 'approved' : 'rejected',
                decided_at: now,
            },
        };
        await supabaseRest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ settings, updated_at: now }),
        });
        return sendJson(res, 200, { ok: true, status: settings.registration_request.status });
    } catch (error) {
        return sendJson(res, error?.status || 500, { ok: false, error: error?.message || String(error) });
    }
}
