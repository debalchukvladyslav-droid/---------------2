import { runGoogleSheetSync, supabaseRest } from '../_google_sheet_sync_lib.js';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET || '';
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
        const configs = await supabaseRest(
            'google_sheet_sync_configs?enabled=eq.true&select=*&order=updated_at.asc',
        );
        const results = [];

        for (const config of configs || []) {
            try {
                results.push(await runGoogleSheetSync(config));
            } catch (error) {
                const message = error?.message || String(error);
                results.push({
                    ok: false,
                    id: config.id,
                    userId: config.user_id,
                    spreadsheetId: config.spreadsheet_id,
                    error: message,
                });
                await supabaseRest(`google_sheet_sync_configs?id=eq.${encodeURIComponent(config.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        last_sync_at: new Date().toISOString(),
                        last_sync_status: 'error',
                        last_sync_error: message.slice(0, 1000),
                    }),
                }).catch(() => {});
            }
        }

        return sendJson(res, 200, {
            ok: true,
            count: results.length,
            results,
        });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
}

