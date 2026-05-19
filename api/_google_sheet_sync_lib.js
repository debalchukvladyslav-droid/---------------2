import crypto from 'node:crypto';
import {
    enrichTradeWithSheet,
    findSheetMatchIndex,
    isValidIsoDateString,
    parseSheetGridToTrades,
    SHEET_DATA_FIRST_ROW,
} from '../js/sheet_sync_core.js';
import { isPureGoogleSheetTrade } from '../js/trade_filters.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

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
    const response = await fetch(`${url}/rest/v1/${path}`, {
        ...options,
        headers: {
            ...jsonHeaders(serviceKey),
            ...(options.headers || {}),
        },
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Supabase REST ${response.status}: ${text || response.statusText}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

export async function verifySupabaseUser(authHeader) {
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
    return response.json();
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

async function getGoogleAccessToken() {
    const { clientEmail, privateKey } = readServiceAccount();
    if (!clientEmail || !privateKey) {
        throw new Error('Google service account env is not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
        iss: clientEmail,
        scope: GOOGLE_SHEETS_SCOPE,
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

async function fetchSheetValues(spreadsheetId, range, sheetTitle) {
    const token = await getGoogleAccessToken();
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(buildRange(range, sheetTitle))}`);
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Google Sheets ${response.status}: ${data.error?.message || response.statusText}`);
    }
    return data.values || [];
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

function sumTradeMoney(trades = []) {
    return trades.reduce((sum, trade) => {
        sum.gross += Number(trade?.gross) || 0;
        sum.net += Number(trade?.net) || 0;
        sum.comm += Number(trade?.comm) || 0;
        return sum;
    }, { gross: 0, net: 0, comm: 0 });
}

function almostEqualMoney(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
}

function fondexxLooksDerivedFromTrades(fondexx, trades) {
    if (!fondexx || typeof fondexx !== 'object' || !Array.isArray(trades) || trades.length === 0) return false;
    const totals = sumTradeMoney(trades);
    return almostEqualMoney(fondexx.gross, totals.gross)
        && almostEqualMoney(fondexx.net, totals.net)
        && almostEqualMoney(fondexx.comm, totals.comm);
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
    const importTrades = trades.filter((t) => !(t?.sheet?.source === 'google' && !t.sheet?.matchedBy));

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

function isDayEmpty(day) {
    if (!day || typeof day !== 'object') return true;
    if (Array.isArray(day.trades) && day.trades.length > 0) return false;
    if (String(day.notes || '').trim() || String(day.mentor_comment || '').trim()) return false;
    if (Array.isArray(day.errors) && day.errors.length > 0) return false;
    if (Array.isArray(day.checkedParams) && day.checkedParams.length > 0) return false;
    if (String(day.sessionGoal || '').trim() || String(day.sessionPlan || '').trim() || day.sessionDone) return false;
    return true;
}

export async function runGoogleSheetSync(config) {
    const cfg = config.config && typeof config.config === 'object' ? config.config : config;
    const spreadsheetId = cfg.spreadsheetId || config.spreadsheet_id;
    const sheetTitle = cfg.sheetTitle || config.sheet_title || '';
    const smartColumns = cfg.smartColumns || {};
    const startRow = Math.max(1, Number(cfg.dataStartRow || config.data_start_row) || SHEET_DATA_FIRST_ROW);
    if (!config.user_id) throw new Error('Missing user_id');
    if (!spreadsheetId) throw new Error('Missing spreadsheetId');
    if (!smartColumns.date || !smartColumns.symbol) throw new Error('Missing date/symbol mapping');

    const values = await fetchSheetValues(spreadsheetId, `A${startRow}:ZZ2000`, sheetTitle);
    const parsed = parseSheetGridToTrades(values, smartColumns, spreadsheetId, startRow);

    const existingRows = await supabaseRest(
        `journal_days?user_id=eq.${encodeURIComponent(config.user_id)}&select=*`,
    );
    const journal = {};
    for (const row of existingRows || []) {
        if (isValidIsoDateString(row.trade_date)) journal[row.trade_date] = rowToDay(row);
    }

    const touched = new Set();
    const deleted = [];
    let matchedSheetRows = 0;
    let skippedSheetRows = 0;
    for (const dateStr of Object.keys(journal)) {
        const day = journal[dateStr];
        const trades = Array.isArray(day.trades) ? day.trades : [];
        const removedTrades = trades.filter((trade) => isPureGoogleSheetTrade(trade, spreadsheetId));
        const nextTrades = trades.filter((trade) => !isPureGoogleSheetTrade(trade, spreadsheetId));
        if (nextTrades.length === trades.length) continue;
        const clearSheetDerivedFondexx = nextTrades.length === 0 && fondexxLooksDerivedFromTrades(day.fondexx, removedTrades);
        day.trades = nextTrades;
        if (clearSheetDerivedFondexx) {
            day.fondexx = { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] };
            day.pnl = null;
            day.gross_pnl = null;
            day.commissions = null;
            day.locates = null;
        }
        syncTotalsFromTrades(day);
        if (isDayEmpty(day)) {
            delete journal[dateStr];
            deleted.push(dateStr);
        } else {
            touched.add(dateStr);
        }
    }

    for (const dateStr of Object.keys(parsed.outByDay)) {
        if (!isValidIsoDateString(dateStr)) continue;
        const incoming = parsed.outByDay[dateStr] || [];
        if (!incoming.length) continue;
        const day = journal[dateStr];
        const kept = Array.isArray(day?.trades) ? day.trades.filter((t) => !isPureGoogleSheetTrade(t, spreadsheetId)) : [];
        if (!kept.length) {
            skippedSheetRows += incoming.length;
            continue;
        }
        const usedIndices = new Set();
        const merged = [...kept];
        let matchedCount = 0;

        for (const trade of incoming) {
            const matchIndex = findSheetMatchIndex(merged, trade, usedIndices);
            if (matchIndex >= 0) {
                merged[matchIndex] = enrichTradeWithSheet(merged[matchIndex], trade);
                usedIndices.add(matchIndex);
                matchedCount++;
                matchedSheetRows++;
            } else {
                skippedSheetRows++;
            }
        }

        if (!matchedCount) continue;
        day.trades = merged;
        syncTotalsFromTrades(day);
        journal[dateStr] = day;
        touched.add(dateStr);
    }

    const rows = [...touched]
        .filter((dateStr) => journal[dateStr])
        .map((dateStr) => dayToRow(config.user_id, dateStr, journal[dateStr]));

    for (let i = 0; i < rows.length; i += 200) {
        await supabaseRest('journal_days?on_conflict=user_id,trade_date', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify(rows.slice(i, i + 200)),
        });
    }

    for (let i = 0; i < deleted.length; i += 100) {
        const chunk = deleted.slice(i, i + 100);
        const encodedDates = chunk.map((dateStr) => encodeURIComponent(`"${dateStr}"`)).join(',');
        await supabaseRest(
            `journal_days?user_id=eq.${encodeURIComponent(config.user_id)}&trade_date=in.(${encodedDates})`,
            { method: 'DELETE' },
        );
    }

    await supabaseRest(`google_sheet_sync_configs?id=eq.${encodeURIComponent(config.id)}`, {
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
        touchedDates: rows.length,
        deletedDates: deleted.length,
        stats: {
            ...parsed.stats,
            matchedSheetRows,
            skippedSheetRows,
        },
    };
}
