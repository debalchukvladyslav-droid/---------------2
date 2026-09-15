import { getGoogleAccessToken, supabaseRest, supabaseRestAll, verifySupabaseUser } from '../lib/google_sheet_sync.js';
import { migrateLegacyClassificationMapping } from '../js/sheet_auto_mapping.js';
import { resolveSourceConnection, saveVerifiedConnection, sourceProfile, sourceAccessError } from '../lib/source_access.js';
import { fetchWithRetry } from '../lib/integration_io.js';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
    try {
        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

        if (req.method === 'GET') {
            const rows = await supabaseRestAll(
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
        const legacyColumns = cfg.columns && typeof cfg.columns === 'object' ? cfg.columns : {};
        const smartColumns = cfg.smartColumns && typeof cfg.smartColumns === 'object'
            ? { ...legacyColumns, ...cfg.smartColumns }
            : { ...legacyColumns };
        cfg.smartColumns = smartColumns;
        const normalizedCfg = migrateLegacyClassificationMapping(cfg).config;
        const normalizedSmartColumns = normalizedCfg.smartColumns || smartColumns;

        if (!spreadsheetId) return sendJson(res, 400, { ok: false, error: 'Missing spreadsheetId' });
        if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId) || !sheetTitle) return sendJson(res, 400, { ok: false, error: 'Missing valid spreadsheet or worksheet' });
        if (!normalizedSmartColumns.date || !normalizedSmartColumns.symbol) {
            return sendJson(res, 400, { ok: false, error: 'Missing date/symbol mapping' });
        }

        const admin = (await sourceProfile(user.id)).role === 'admin';
        const ownerId = admin && body.userId ? body.userId : user.id;
        const googleToken = String(req.headers['x-google-access-token'] || '');
        if (!admin && !googleToken) await resolveSourceConnection(user, 'sheets', spreadsheetId, { scope: sheetTitle, write: true });
        if (googleToken) {
            const proof = await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${googleToken}` } });
            const metadata = await proof.json().catch(() => ({}));
            if (!proof.ok || !metadata.sheets?.some(sheet => sheet.properties?.title === sheetTitle)) throw sourceAccessError('Google не підтвердив доступ до аркуша.');
        }
        const serviceToken = await getGoogleAccessToken();
        const serviceProof = await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${serviceToken}` } });
        const serviceMetadata = await serviceProof.json().catch(() => ({}));
        if (!serviceProof.ok || !serviceMetadata.sheets?.some(sheet => sheet.properties?.title === sheetTitle)) throw sourceAccessError('Надайте сервісу доступ до аркуша для фонової синхронізації.');
        const row = {
            user_id: ownerId,
            spreadsheet_id: spreadsheetId,
            sheet_title: sheetTitle,
            selected_file_name: String(cfg.selectedFileName || '').trim(),
            data_start_row: Number(cfg.dataStartRow) || null,
            config: normalizedCfg,
            enabled: true,
            updated_at: new Date().toISOString(),
        };

        await supabaseRest('google_sheet_sync_configs?on_conflict=user_id,spreadsheet_id,sheet_title', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify(row),
        });
        const connection = await saveVerifiedConnection({ userId: ownerId, kind: 'sheets', resourceId: spreadsheetId, scope: sheetTitle, config: normalizedCfg });
        const job = await supabaseRest('rpc/enqueue_source_sync', { method: 'POST', body: JSON.stringify({ p_connection_id: connection.id }) });
        return sendJson(res, 202, { ok: true, connectionId: connection.id, job });
    } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error?.message || String(error), code: error.code || '' });
    }
}
