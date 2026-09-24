import { supabaseRest } from '../lib/google_sheet_sync.js';
import {
    SCORE_FORMULA,
    SCORE_VERSION,
    addCalendarDays,
    displaySessionDate,
    finalAggressiveness,
    isTradingDay,
    previousTradingDay,
    scoreSessionFromBars,
} from '../lib/aggressiveness_core.js';
import { buildGauge, buildHistoricalBacktest, loadScaledHistory, regimeRow } from '../lib/aggressiveness_service.js';
import { createMarketDataProvider } from '../lib/market_data_provider.js';

const DEFAULT_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    setCors(req, res);
    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (req.method !== 'GET') return json(res, 405, { message: 'Method not allowed' });

    const auth = await verifyUser(req);
    if (!auth.ok) return json(res, auth.status, { message: auth.message, status: 'incomplete' });

    const view = String(req.query?.view || '');
    try {
        if (view === 'backtest') {
            const admin = await isAdmin(auth);
            if (!admin.ok) return json(res, admin.status, { message: admin.message });
            const report = await runBacktest(req, auth);
            return json(res, 200, { ok: true, formula: SCORE_FORMULA, ...report });
        }
        const payload = await buildGauge({
            now: new Date(),
            env: process.env,
            store: safeStore(),
            provider: safeProvider(auth),
        });
        return json(res, 200, payload);
    } catch (error) {
        console.error('[Aggressiveness]', error);
        return json(res, 200, {
            status: 'incomplete',
            incomplete: true,
            message: 'Data incomplete',
            missing: [],
            scoreVersion: SCORE_VERSION,
            sessionDate: displaySessionDate(new Date()),
        });
    }
}

async function runBacktest(req, auth) {
    const today = displaySessionDate(new Date());
    const to = isTradingDay(String(req.query?.to || '')) ? String(req.query.to) : today;
    const from = isTradingDay(String(req.query?.from || '')) ? String(req.query.from) : addCalendarDays(to, -380);
    const provider = safeProvider(auth);
    if (!provider) {
        return { ok: false, message: 'Data incomplete', scoreVersion: SCORE_VERSION, buckets: [], days: 0 };
    }
    const store = safeStore();
    const history = await loadScaledHistory(provider, store, to, process.env, {
        from: addCalendarDays(from, -420),
        to: previousTradingDay(addCalendarDays(to, 1)),
    });
    const dates = [];
    for (let cursor = from; cursor <= to && dates.length < 900; cursor = addCalendarDays(cursor, 1)) {
        if (isTradingDay(cursor)) dates.push(cursor);
    }
    const mechanical = store ? await store.readMechanical(from, to).catch(() => ({})) : {};
    const report = await buildHistoricalBacktest(history.barsByKey, mechanical, dates);
    if (store?.insertRegimes) {
        const sessionDate = displaySessionDate(new Date());
        const now = new Date();
        const rows = dates.filter((date) => date < sessionDate).map((date) => {
            const computed = scoreSessionFromBars(history.barsByKey, date, { liveAdjustment: 0 });
            if (!computed.complete) return null;
            const liveScore = finalAggressiveness(computed.baseScore, computed.components.narrowPenalty, computed.components.meltUpPenalty, 0);
            return regimeRow(computed, { live: 0, liveScore, frozen: true, now });
        }).filter(Boolean);
        await store.insertRegimes(rows).catch((error) => console.warn('[Aggressiveness] history insert skipped:', error?.message || error));
    }
    return report;
}

async function verifyUser(req) {
    const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const token = String(req.headers.authorization || '').startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
    if (!token) return { ok: false, status: 401, message: 'Missing auth token' };
    if (!url || !anon) return { ok: false, status: 500, message: 'Supabase auth env is not configured on server' };
    try {
        const response = await fetch(`${url}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: anon },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return { ok: false, status: 401, message: 'Invalid auth token' };
        const user = await response.json();
        return { ok: true, userId: user.id, token, url, anon };
    } catch (error) {
        console.warn('[Aggressiveness] auth unavailable:', error?.message || error);
        return { ok: false, status: 503, message: 'Data incomplete' };
    }
}

async function isAdmin(auth) {
    try {
        const response = await fetch(`${auth.url}/rest/v1/profiles?id=eq.${auth.userId}&select=role`, {
            headers: { apikey: auth.anon, Authorization: `Bearer ${auth.token}` },
            signal: AbortSignal.timeout(10000),
        });
        const rows = await response.json().catch(() => []);
        if (!response.ok) return { ok: false, status: 403, message: 'Admin only' };
        return rows?.[0]?.role === 'admin'
            ? { ok: true }
            : { ok: false, status: 403, message: 'Admin only' };
    } catch {
        return { ok: false, status: 503, message: 'Data incomplete' };
    }
}

function safeProvider(auth) {
    try {
        return createMarketDataProvider(process.env, fetch, { authToken: auth?.token || '', allowPublic: true });
    } catch {
        return null;
    }
}

function safeStore() {
    try {
        return createStore();
    } catch {
        return null;
    }
}

function createStore() {
    return {
        async readBars(symbol, from, to) {
            const rows = await supabaseRest(`daily_market_bars?select=bar_date,open,high,low,close&symbol=eq.${encodeURIComponent(symbol)}&bar_date=gte.${from}&bar_date=lte.${to}&order=bar_date.asc`);
            return (rows || []).map(toBar);
        },
        async writeBars(symbol, bars) {
            const rows = bars.map((bar) => ({
                symbol,
                bar_date: bar.date,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                provider: 'polygon',
            }));
            for (let index = 0; index < rows.length; index += 400) {
                await supabaseRest('daily_market_bars?on_conflict=symbol,bar_date', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify(rows.slice(index, index + 400)),
                });
            }
        },
        async readRegime(date, version) {
            const rows = await supabaseRest(`daily_market_regime?select=*&date=eq.${date}&score_version=eq.${version}&limit=1`);
            return rows?.[0] || null;
        },
        async readLatest(version) {
            const rows = await supabaseRest(`daily_market_regime?select=*&score_version=eq.${version}&order=date.desc&limit=1`);
            return rows?.[0] || null;
        },
        async readPrevious(date, version) {
            const rows = await supabaseRest(`daily_market_regime?select=live_score,date&score_version=eq.${version}&date=lt.${date}&order=date.desc&limit=1`);
            return rows?.[0] || null;
        },
        async insertRegime(row) {
            await supabaseRest('daily_market_regime?on_conflict=date,score_version', {
                method: 'POST',
                headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
                body: JSON.stringify(row),
            });
            return true;
        },
        async insertRegimes(rows) {
            if (!rows?.length) return false;
            for (let index = 0; index < rows.length; index += 200) {
                await supabaseRest('daily_market_regime?on_conflict=date,score_version', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
                    body: JSON.stringify(rows.slice(index, index + 200)),
                });
            }
            return true;
        },
        async patchRegime(date, version, patch) {
            await supabaseRest(`daily_market_regime?date=eq.${date}&score_version=eq.${version}&live_frozen=eq.false`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(patch),
            });
            return true;
        },
        async readMechanical(from, to) {
            const rows = await supabaseRest(`daily_market_regime?select=date,mechanical_entries,mechanical_total_r,mechanical_win_rate,mechanical_avg_winner,mechanical_avg_loser&score_version=eq.${SCORE_VERSION}&date=gte.${from}&date=lte.${to}&mechanical_entries=not.is.null`);
            const byDate = {};
            for (const row of rows || []) {
                byDate[row.date] = {
                    entries: Number(row.mechanical_entries) || 0,
                    totalR: Number(row.mechanical_total_r) || 0,
                    winRate: row.mechanical_win_rate == null ? null : Number(row.mechanical_win_rate),
                    avgWinner: row.mechanical_avg_winner == null ? null : Number(row.mechanical_avg_winner),
                    avgLoser: row.mechanical_avg_loser == null ? null : Number(row.mechanical_avg_loser),
                };
            }
            return byDate;
        },
    };
}

function toBar(row) {
    return {
        date: row.bar_date,
        open: numberOrNull(row.open),
        high: numberOrNull(row.high),
        low: numberOrNull(row.low),
        close: Number(row.close),
    };
}

function numberOrNull(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function json(res, status, body) {
    res.status(status).json(body);
}

function setCors(req, res) {
    const origin = req.headers.origin;
    const allowed = new Set([
        ...DEFAULT_ORIGINS,
        ...String(process.env.ALLOWED_ORIGINS || process.env.APP_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean),
    ]);
    res.setHeader('Access-Control-Allow-Origin', origin && allowed.has(origin) ? origin : 'https://traderjournal-six.vercel.app');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
