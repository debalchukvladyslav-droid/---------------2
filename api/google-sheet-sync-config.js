import { supabaseRest, verifySupabaseUser } from './_google_sheet_sync_lib.js';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
    try {
        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

        if (req.method === 'GET') {
            const rows = await supabaseRest(
                `google_sheet_sync_configs?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=updated_at.desc`,
            );
            return sendJson(res, 200, { ok: true, configs: rows || [] });
        }

        if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const cfg = body.config && typeof body.config === 'object' ? body.config : body;
        const spreadsheetId = String(cfg.spreadsheetId || '').trim();
        const sheetTitle = String(cfg.sheetTitle || '').trim();

        if (!spreadsheetId) return sendJson(res, 400, { ok: false, error: 'Missing spreadsheetId' });
        if (!cfg.smartColumns?.date || !cfg.smartColumns?.symbol) {
            return sendJson(res, 400, { ok: false, error: 'Missing date/symbol mapping' });
        }

        const row = {
            user_id: user.id,
            spreadsheet_id: spreadsheetId,
            sheet_title: sheetTitle,
            selected_file_name: String(cfg.selectedFileName || '').trim(),
            data_start_row: Number(cfg.dataStartRow) || null,
            config: cfg,
            enabled: !!cfg.autoSync?.enabled,
            updated_at: new Date().toISOString(),
        };

        await supabaseRest('google_sheet_sync_configs?on_conflict=user_id,spreadsheet_id,sheet_title', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify(row),
        });

        return sendJson(res, 200, { ok: true });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
}

