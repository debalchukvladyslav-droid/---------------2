import { getGoogleAccessToken, supabaseRest, verifySupabaseUser } from '../lib/google_sheet_sync.js';
import { tradingWorkbookBuffer } from '../lib/trading_export.js';
import { buildTeamReport } from '../lib/team_report.js';

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
    let hyperlinks = [];
    try {
        const gridResponse = await sheetsFetch(encodeURIComponent(spreadsheetId), token, {
            ranges: fullRange,
            includeGridData: 'true',
            fields: 'sheets(data(rowData(values(hyperlink,userEnteredValue,textFormatRuns(format(link(uri)))))))',
        });
        const grid = await gridResponse.json().catch(() => ({}));
        if (gridResponse.ok) {
            const rowData = grid.sheets?.[0]?.data?.[0]?.rowData || [];
            hyperlinks = rowData.map(row => (row.values || []).map(cell => {
                if (cell.hyperlink) return cell.hyperlink;
                const richLink = (cell.textFormatRuns || []).map(run => run?.format?.link?.uri).find(Boolean);
                if (richLink) return richLink;
                const formula = cell.userEnteredValue?.formulaValue || '';
                return formula.match(/HYPERLINK\s*\(\s*"([^"]+)"/i)?.[1] || '';
            }));
        }
    } catch (error) {
        console.warn('[Sheets service] hyperlinks skipped', { message: error?.message || String(error) });
    }
    console.log('[Sheets service] values ok', { spreadsheetId, range: fullRange, rows: data.values?.length || 0 });
    return sendJson(res, 200, { ok: true, values: data.values || [], hyperlinks });
}

async function exportWorkbook(res, user) {
    const [days, reviews] = await Promise.all([
        supabaseRest(`journal_days?user_id=eq.${encodeURIComponent(user.id)}&select=trade_date,pnl,daily_metrics&order=trade_date.asc`),
        supabaseRest(`daily_reviews?user_id=eq.${encodeURIComponent(user.id)}&select=trade_date,status,debrief,strengths,mistakes,next_session_rules,model_name&order=trade_date.asc`),
    ]);
    const buffer = await tradingWorkbookBuffer({ days, reviews });
    const date = new Date().toISOString().slice(0, 10);
    res.status(200); res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="STRUM-trading-journal-${date}.xlsx"`); res.setHeader('Cache-Control', 'private, no-store');
    return res.end(Buffer.from(buffer));
}
async function teamReport(req, res, user) { const limit=Math.min(180,Math.max(7,Number(req.query.days)||30)); const [days,reviews]=await Promise.all([supabaseRest(`journal_days?user_id=eq.${encodeURIComponent(user.id)}&select=trade_date,daily_metrics&order=trade_date.desc&limit=${limit}`),supabaseRest(`daily_reviews?user_id=eq.${encodeURIComponent(user.id)}&select=trade_date,status,debrief,strengths,mistakes,next_session_rules&order=trade_date.desc&limit=${limit}`)]); return sendJson(res,200,{ok:true,report:buildTeamReport(days,reviews,{includePnl:req.query.includePnl==='true'})}); }

export default async function handler(req, res) {
    try {
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

        const action = String(req.query.action || 'metadata');
        if (action === 'export') return exportWorkbook(res, user);
        if (action === 'team-report') return teamReport(req, res, user);

        let token = String(req.headers['x-google-access-token'] || '').trim();
        let authMode = token ? 'user' : 'service-account';
        if (!token) {
            try {
                token = await getGoogleAccessToken();
            } catch (error) {
                console.warn('[Sheets service] service account token unavailable', {
                    message: error?.message || String(error),
                });
                return sendJson(res, 503, {
                    ok: false,
                    code: 'GOOGLE_SERVICE_ACCOUNT_UNAVAILABLE',
                    error: 'Google service account is not configured on the server',
                });
            }
        }
        console.log('[Sheets service] authorization', { action, authMode });
        if (action === 'metadata') return metadata(req, res, token);
        if (action === 'values') return values(req, res, token);
        return sendJson(res, 400, { ok: false, error: 'Unknown action' });
    } catch (error) {
        const message = error?.message || String(error);
        console.error('[Sheets service] fatal', { message });
        return sendJson(res, 500, { ok: false, error: message });
    }
}
