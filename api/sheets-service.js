import { getGoogleAccessToken, verifySupabaseUser } from './_google_sheet_sync_lib.js';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function cleanSpreadsheetId(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    const id = match?.[1] || raw;
    return /^[a-zA-Z0-9_-]+$/.test(id) ? id : '';
}

function quoteSheetTitle(title) {
    return `'${String(title).replace(/'/g, "''")}'`;
}

function buildRange(range, sheetTitle) {
    if (!sheetTitle || String(range).includes('!')) return range;
    return `${quoteSheetTitle(sheetTitle)}!${range}`;
}

async function sheetsFetch(path, token, query = {}) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    return fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
    });
}

async function metadata(req, res, token) {
    const spreadsheetId = cleanSpreadsheetId(req.query.spreadsheetId);
    if (!spreadsheetId) return sendJson(res, 400, { ok: false, error: 'Missing spreadsheetId' });

    console.log('[Sheets service] metadata start', { spreadsheetId });
    const response = await sheetsFetch(encodeURIComponent(spreadsheetId), token, {
        fields: 'properties(title),sheets.properties(title,sheetId,index)',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.warn('[Sheets service] metadata failed', {
            spreadsheetId,
            status: response.status,
            message: data.error?.message || response.statusText,
        });
        return sendJson(res, response.status, { ok: false, error: data.error?.message || response.statusText });
    }

    const sheets = (data.sheets || [])
        .map(sheet => sheet.properties)
        .filter(Boolean)
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    console.log('[Sheets service] metadata ok', { spreadsheetId, title: data.properties?.title || '', sheets: sheets.length });
    return sendJson(res, 200, {
        ok: true,
        spreadsheetId,
        title: data.properties?.title || spreadsheetId,
        sheets,
    });
}

async function values(req, res, token) {
    const spreadsheetId = cleanSpreadsheetId(req.query.spreadsheetId);
    const range = String(req.query.range || '').trim();
    const sheetTitle = String(req.query.sheetTitle || '').trim();
    if (!spreadsheetId) return sendJson(res, 400, { ok: false, error: 'Missing spreadsheetId' });
    if (!range) return sendJson(res, 400, { ok: false, error: 'Missing range' });

    const fullRange = buildRange(range, sheetTitle);
    console.log('[Sheets service] values start', { spreadsheetId, range: fullRange });
    const response = await sheetsFetch(`${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(fullRange)}`, token);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.warn('[Sheets service] values failed', {
            spreadsheetId,
            range: fullRange,
            status: response.status,
            message: data.error?.message || response.statusText,
        });
        return sendJson(res, response.status, { ok: false, error: data.error?.message || response.statusText });
    }
    console.log('[Sheets service] values ok', { spreadsheetId, range: fullRange, rows: data.values?.length || 0 });
    return sendJson(res, 200, { ok: true, values: data.values || [] });
}

export default async function handler(req, res) {
    try {
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

        const token = await getGoogleAccessToken();
        const action = String(req.query.action || 'metadata');
        if (action === 'metadata') return metadata(req, res, token);
        if (action === 'values') return values(req, res, token);
        return sendJson(res, 400, { ok: false, error: 'Unknown action' });
    } catch (error) {
        const message = error?.message || String(error);
        console.error('[Sheets service] fatal', { message });
        const missingServiceAccount = message.includes('Google service account env is not configured');
        return sendJson(res, missingServiceAccount ? 501 : 500, { ok: false, error: message });
    }
}
