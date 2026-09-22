import crypto from 'node:crypto';
import { fetchWithRetry } from './integration_io.js';
import { readSheetRangePages } from '../js/sheet_range_paging.js';
import { canonicalJournalRow, journalRowToIntegrationDay, integrationDayToJournalRow, mergeSiteAuthoritativeSheetRows } from '../js/integration_merge.js';
import {
    isValidIsoDateString,
    parseSheetGridToTrades,
    SHEET_DATA_FIRST_ROW,
} from '../js/sheet_sync_core.js';
import { isPureGoogleSheetTrade } from '../js/trade_filters.js';
import { mergeGoogleSheetTradesIntoJournal } from '../js/sheet_journal_merge.js';
import { migrateLegacyClassificationMapping } from '../js/sheet_auto_mapping.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function env(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

export function getSupabaseEnv() {
    const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY');
    const anonKey = env('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
    if (!url) throw new Error('SUPABASE_URL is not configured');
    return { url, serviceKey, anonKey };
}

function jsonHeaders(key) {
    return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
    };
}

export async function supabaseRest(path, options = {}) {
    const { url, serviceKey } = getSupabaseEnv();
    if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    const response = await fetchWithRetry(`${url}/rest/v1/${path}`, {
        ...options,
        headers: {
            ...jsonHeaders(serviceKey),
            ...(options.headers || {}),
        },
    }, { attempts: !options.method || options.method === 'GET' ? 3 : 1 });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw Object.assign(new Error(`Supabase REST ${response.status}: ${text || response.statusText}`), { status: response.status });
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

export async function supabaseRestAll(path, { pageSize = 500 } = {}) {
    const rows = [];
    for (let offset = 0; ; ) {
        const page = await supabaseRest(`${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${offset}`);
        if (!Array.isArray(page)) throw new Error('Expected a paginated database result');
        if (!page.length) return rows;
        rows.push(...page);
        offset += page.length;
    }
}

export async function verifySupabaseUser(authHeader, options = {}) {
    const { url, anonKey } = getSupabaseEnv();
    const token = String(authHeader || '').startsWith('Bearer ') ? String(authHeader).slice(7) : '';
    if (!anonKey) throw new Error('SUPABASE_ANON_KEY is not configured');
    if (!token) return null;
    const response = await fetch(`${url}/auth/v1/user`, {
        headers: {
            apikey: anonKey,
            Authorization: `Bearer ${token}`,
        },
    });
    if (!response.ok) return null;
    const user = await response.json();
    if (options.requireApproved === false) return user;
    const profiles = await supabaseRest(
        `profiles?id=eq.${encodeURIComponent(user.id)}&select=settings,role&limit=1`,
    );
    const profile = profiles?.[0];
    const approved = profile?.role === 'admin' || profile?.settings?.account_approved === true;
    return approved ? user : null;
}

function base64Url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function readServiceAccount() {
    const rawJson = env('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (rawJson) {
        const parsed = JSON.parse(rawJson);
        return {
            clientEmail: parsed.client_email,
            privateKey: parsed.private_key,
        };
    }

    return {
        clientEmail: env('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_CLIENT_EMAIL'),
        privateKey: env('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    };
}

export function getGoogleServiceAccountEmail() {
    return readServiceAccount().clientEmail || '';
}

export async function getGoogleAccessToken(scope = GOOGLE_SHEETS_SCOPE) {
    const { clientEmail, privateKey } = readServiceAccount();
    if (!clientEmail || !privateKey) {
        throw new Error('Google service account env is not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
        iss: clientEmail,
        scope,
        aud: GOOGLE_TOKEN_URL,
        exp: now + 3600,
        iat: now,
    }));
    const unsigned = `${header}.${payload}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey);
    const assertion = `${unsigned}.${base64Url(signature)}`;

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
    });
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(`Google token error ${response.status}: ${data.error_description || data.error || response.statusText}`);
    }
    return data.access_token;
}

function quoteSheetTitle(title) {
    return `'${String(title).replace(/'/g, "''")}'`;
}

function buildRange(range, sheetTitle) {
    if (!sheetTitle || String(range).includes('!')) return range;
    return `${quoteSheetTitle(sheetTitle)}!${range}`;
}

export async function fetchSheetValues(spreadsheetId, range, sheetTitle) {
    return readSheetRangePages(range, {
        rowCount: async () => {
            const token = await getGoogleAccessToken();
            const response = await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(title,gridProperties.rowCount)`, { headers: { Authorization: `Bearer ${token}` } });
            const data = await response.json();
            if (!response.ok) throw new Error(`Google Sheets metadata ${response.status}`);
            const title = range.includes('!') ? range.slice(0, range.lastIndexOf('!')).replace(/^'|'$/g, '').replace(/''/g, "'") : sheetTitle;
            const sheet = data.sheets?.find(item => !title || item.properties.title === title);
            return sheet?.properties?.gridProperties?.rowCount;
        },
        read: page => fetchSheetValuesPage(spreadsheetId, page, sheetTitle),
    });
}

async function fetchSheetValuesPage(spreadsheetId, range, sheetTitle) {
    const token = await getGoogleAccessToken();
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(buildRange(range, sheetTitle))}`);
    const response = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Google Sheets ${response.status}: ${data.error?.message || response.statusText}`);
    }
    const values = data.values || [];
    try {
        const fullRange = buildRange(range, sheetTitle);
        const gridUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`);
        gridUrl.searchParams.set('ranges', fullRange);
        gridUrl.searchParams.set('includeGridData', 'true');
        gridUrl.searchParams.set('fields', 'sheets(data(rowData(values(hyperlink,userEnteredValue,textFormatRuns(format(link(uri)))))))');
        const gridResponse = await fetchWithRetry(gridUrl, { headers: { Authorization: `Bearer ${token}` } });
        const grid = await gridResponse.json().catch(() => ({}));
        if (gridResponse.ok) {
            const rowData = grid.sheets?.[0]?.data?.[0]?.rowData || [];
            values.hyperlinks = rowData.map(row => (row.values || []).map(cell => {
                if (cell.hyperlink) return cell.hyperlink;
                const richLink = (cell.textFormatRuns || []).map(run => run?.format?.link?.uri).find(Boolean);
                if (richLink) return richLink;
                return (cell.userEnteredValue?.formulaValue || '').match(/HYPERLINK\s*\(\s*"([^"]+)"/i)?.[1] || '';
            }));
        }
    } catch (error) {
        console.warn('[Sheet sync] hyperlinks skipped', error?.message || String(error));
    }
    return values;
}

function defaultDayEntry() {
    return {
        pnl: null,
        gross_pnl: null,
        commissions: null,
        locates: null,
        kf: null,
        notes: '',
        mentor_comment: '',
        ai_advice: '',
        errors: [],
        screenshots: { good: [], normal: [], bad: [], error: [] },
        checkedParams: [],
        sliders: {},
        tradeTypesData: {},
        tickers: {},
        traded_tickers: [],
        fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        fondexxSource: '',
        pproSource: '',
        sessionGoal: '',
        sessionPlan: '',
        sessionReadiness: null,
        sessionSetups: [],
        sessionAiResult: '',
        sessionDone: false,
        trades: [],
        review_requests: {},
    };
}

function rowToDay(row) {
    const m = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
    return {
        ...defaultDayEntry(),
        pnl: row?.pnl ?? null,
        gross_pnl: row?.gross_pnl ?? null,
        commissions: row?.commissions ?? null,
        locates: row?.locates ?? null,
        kf: row?.kf ?? null,
        notes: row?.notes ?? '',
        mentor_comment: row?.mentor_comment ?? '',
        ai_advice: row?.ai_advice ?? '',
        errors: Array.isArray(m.errors) ? m.errors : [],
        checkedParams: Array.isArray(m.checkedParams) ? m.checkedParams : [],
        sliders: m.sliders && typeof m.sliders === 'object' ? m.sliders : {},
        tradeTypesData: m.tradeTypesData && typeof m.tradeTypesData === 'object' ? m.tradeTypesData : {},
        screenshots: m.screenshots && typeof m.screenshots === 'object' ? m.screenshots : { good: [], normal: [], bad: [], error: [] },
        tickers: m.tickers && typeof m.tickers === 'object' ? m.tickers : {},
        traded_tickers: Array.isArray(m.traded_tickers) ? m.traded_tickers : [],
        fondexx: m.fondexx && typeof m.fondexx === 'object' ? m.fondexx : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: m.ppro && typeof m.ppro === 'object' ? m.ppro : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        fondexxSource: typeof m.fondexxSource === 'string' ? m.fondexxSource : '',
        pproSource: typeof m.pproSource === 'string' ? m.pproSource : '',
        sessionGoal: m.sessionGoal ?? '',
        sessionPlan: m.sessionPlan ?? '',
        sessionReadiness: m.sessionReadiness ?? null,
        sessionSetups: Array.isArray(m.sessionSetups) ? m.sessionSetups : [],
        sessionAiResult: m.sessionAiResult ?? '',
        sessionDone: m.sessionDone ?? false,
        trades: Array.isArray(m.trades) ? m.trades : [],
        review_requests: m.review_requests && typeof m.review_requests === 'object' ? m.review_requests : {},
    };
}

function dayToRow(userId, tradeDate, day) {
    return {
        user_id: userId,
        trade_date: tradeDate,
        pnl: day.pnl,
        gross_pnl: day.gross_pnl,
        commissions: day.commissions,
        locates: day.locates,
        kf: day.kf,
        notes: day.notes || '',
        mentor_comment: typeof day.mentor_comment === 'string' ? day.mentor_comment : '',
        ai_advice: typeof day.ai_advice === 'string' ? day.ai_advice : '',
        daily_metrics: {
            errors: Array.isArray(day.errors) ? day.errors : [],
            checkedParams: Array.isArray(day.checkedParams) ? day.checkedParams : [],
            sliders: day.sliders && typeof day.sliders === 'object' ? day.sliders : {},
            tradeTypesData: day.tradeTypesData && typeof day.tradeTypesData === 'object' ? day.tradeTypesData : {},
            screenshots: day.screenshots && typeof day.screenshots === 'object' ? day.screenshots : { good: [], normal: [], bad: [], error: [] },
            tickers: day.tickers && typeof day.tickers === 'object' ? day.tickers : {},
            traded_tickers: Array.isArray(day.traded_tickers) ? day.traded_tickers : [],
            fondexx: day.fondexx && typeof day.fondexx === 'object' ? day.fondexx : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            ppro: day.ppro && typeof day.ppro === 'object' ? day.ppro : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            fondexxSource: typeof day.fondexxSource === 'string' ? day.fondexxSource : '',
            pproSource: typeof day.pproSource === 'string' ? day.pproSource : '',
            sessionGoal: day.sessionGoal ?? '',
            sessionPlan: day.sessionPlan ?? '',
            sessionReadiness: day.sessionReadiness ?? null,
            sessionSetups: Array.isArray(day.sessionSetups) ? day.sessionSetups : [],
            sessionAiResult: day.sessionAiResult ?? '',
            sessionDone: day.sessionDone ?? false,
            trades: Array.isArray(day.trades) ? day.trades : [],
            review_requests: day.review_requests && typeof day.review_requests === 'object' ? day.review_requests : {},
        },
    };
}

function tradeTickers(trades) {
    return Array.from(new Set((trades || []).map((t) => String(t?.symbol || '').trim()).filter(Boolean)));
}

function hasSourceMoney(source) {
    return !!(Number(source?.gross) || Number(source?.net) || Number(source?.comm));
}

function syncTotalsFromTrades(day) {
    const trades = Array.isArray(day.trades) ? day.trades : [];
    const tickers = tradeTickers(trades);
    const prevFx = day.fondexx && typeof day.fondexx === 'object' ? day.fondexx : {};
    const ppro = day.ppro && typeof day.ppro === 'object' ? day.ppro : {};
    const importTrades = trades.filter((trade) => !isPureGoogleSheetTrade(trade));

    if (importTrades.length > 0) {
        const totals = importTrades.reduce((sum, trade) => {
            sum.gross += Number(trade?.gross) || 0;
            sum.net += Number(trade?.net) || 0;
            sum.comm += Number(trade?.comm) || 0;
            return sum;
        }, { gross: 0, net: 0, comm: 0 });
        day.fondexx = {
            gross: Number(totals.gross.toFixed(2)),
            net: Number(totals.net.toFixed(2)),
            comm: Number(totals.comm.toFixed(2)),
            locates: Number(prevFx.locates) || 0,
            tickers,
        };
    } else if (!hasSourceMoney(prevFx)) {
        day.fondexx = { gross: 0, net: 0, comm: 0, locates: Number(prevFx.locates) || 0, tickers };
    } else {
        day.fondexx = { ...prevFx, tickers: Array.from(new Set([...(prevFx.tickers || []), ...tickers])) };
    }

    const f = day.fondexx || {};
    day.traded_tickers = Array.from(new Set([...(f.tickers || []), ...(ppro.tickers || [])]));
    if (hasSourceMoney(f) || hasSourceMoney(ppro)) {
        day.gross_pnl = Number(((Number(f.gross) || 0) + (Number(ppro.gross) || 0)).toFixed(2));
        day.commissions = Number(((Number(f.comm) || 0) + (Number(ppro.comm) || 0)).toFixed(2));
        day.locates = Number(((Number(f.locates) || 0) + (Number(ppro.locates) || 0)).toFixed(2));
        day.pnl = Number((((Number(f.net) || 0) - (Number(f.locates) || 0)) + (Number(ppro.net) || 0)).toFixed(2));
    } else {
        day.pnl = null;
        day.gross_pnl = null;
        day.commissions = null;
        day.locates = null;
    }
}

export async function runGoogleSheetSync(config) {
    const rawCfg = config.config && typeof config.config === 'object' ? config.config : config;
    const spreadsheetId = rawCfg.spreadsheetId || config.spreadsheet_id;
    const sheetTitle = rawCfg.sheetTitle || config.sheet_title || '';
    const headerRows = spreadsheetId ? await fetchSheetValues(spreadsheetId, 'A1:ZZ20', sheetTitle) : [];
    const cfg = migrateLegacyClassificationMapping(rawCfg, headerRows).config;
    const smartColumns = cfg.smartColumns || {};
    const startRow = Math.max(1, Number(cfg.dataStartRow || config.data_start_row) || SHEET_DATA_FIRST_ROW);
    if (!config.user_id) throw new Error('Missing user_id');
    if (!spreadsheetId) throw new Error('Missing spreadsheetId');
    if (!smartColumns.date || !smartColumns.symbol) throw new Error('Missing date/symbol mapping');

    const values = await fetchSheetValues(spreadsheetId, `A${startRow}:ZZ`, sheetTitle);
    const parsed = parseSheetGridToTrades(values, smartColumns, spreadsheetId, startRow);
    const syncState = await supabaseRest('rpc/get_data_sync_state', { method: 'POST', body: JSON.stringify({ p_user_id: config.user_id }) });
    const existingRows = await supabaseRestAll(`journal_days?user_id=eq.${encodeURIComponent(config.user_id)}&select=*&order=trade_date.asc`);
    const journal = {};
    for (const row of existingRows || []) {
        if (isValidIsoDateString(row.trade_date)) journal[row.trade_date] = journalRowToIntegrationDay(row);
    }
    const mergeResult = mergeSiteAuthoritativeSheetRows(journal, parsed.outByDay, spreadsheetId, { sheetTitle });
    const originals = new Map(existingRows.map(row => [row.trade_date, row]));
    const operations = mergeResult.touchedDates.map(date => {
        const original = originals.get(date);
        const updated = integrationDayToJournalRow(original, journal[date]);
        return {
            operationId: crypto.randomUUID(), userId: config.user_id, domain: 'journal', entityId: date,
            baseVersion: Number(original.sync_version) || 0, epoch: syncState.epoch,
            base: canonicalJournalRow(original), patch: { daily_metrics: { trades: updated.daily_metrics.trades } },
        };
    });
    if (operations.length) {
        if (operations.length > 2000 || Buffer.byteLength(JSON.stringify(operations)) > 8 * 1024 * 1024) throw new Error('Import exceeds atomic transaction limit; narrow the source date range');
        const receipt = await supabaseRest('rpc/apply_data_operations', { method: 'POST', body: JSON.stringify({ p_operations: operations, p_atomic: true }) });
        const results = Array.isArray(receipt) ? receipt : receipt?.results || receipt?.operations || [];
        if (results.length !== operations.length || results.some(result => !['applied', 'duplicate', 'noop', 'acknowledged'].includes(result.status))) {
            throw Object.assign(new Error('Source import paused because site data changed; it will retry against the latest revision'), { status: 409 });
        }
    }
    if (config.id) await supabaseRest(`google_sheet_sync_configs?id=eq.${encodeURIComponent(config.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
            last_sync_at: new Date().toISOString(),
            last_sync_status: 'ok',
            last_sync_error: null,
        }),
    });

    return {
        ok: true,
        userId: config.user_id,
        spreadsheetId,
        sheetTitle,
        touchedDates: operations.length,
        deletedDates: 0,
        revision: crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex'),
        stats: {
            ...parsed.stats,
            matchedSheetRows: mergeResult.matchedSheetRows,
            skippedSheetRows: mergeResult.skippedSheetRows,
        },
    };
}
