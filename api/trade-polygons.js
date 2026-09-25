import { supabaseRest, verifySupabaseUser } from '../lib/google_sheet_sync.js';

const TICKER_RE = /^[A-Z0-9.\-^=]{1,20}$/;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function nyDate(timestampSeconds) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Number(timestampSeconds) * 1000));
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function splitJumpRemains(rows, split) {
    const when = nyDate(split?.date);
    const expected = Number(split?.denominator) / Number(split?.numerator);
    if (!(expected > 0)) return true;
    let before = null;
    let after = null;
    rows.forEach((row) => {
        if (row.date < when) before = row;
        if (!after && row.date >= when) after = row;
    });
    if (!before || !after || !(before.close > 0)) return false;
    const jump = after.close / before.close;
    return jump > expected * 0.4 && jump < expected * 2.5;
}

function laterSplitFactor(splits, rows, targetDate) {
    let factor = 1;
    Object.values(splits || {}).forEach((split) => {
        const when = nyDate(split?.date);
        const numerator = Number(split?.numerator);
        const denominator = Number(split?.denominator);
        if (!(when > targetDate) || !(numerator > 0) || !(denominator > 0)) return;
        if (splitJumpRemains(rows, split)) return;
        factor *= denominator / numerator;
    });
    return factor;
}

export function calculateYahooMetrics(chart, targetDate) {
    const result = chart?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp || [];
    if (!quote || !timestamps.length) throw new Error('Yahoo не повернув історичні дані');

    const rows = [];
    timestamps.forEach((timestamp, index) => {
        const row = {
            date: nyDate(timestamp),
            high: Number(quote.high?.[index]),
            low: Number(quote.low?.[index]),
            close: Number(quote.close?.[index]),
            volume: Number(quote.volume?.[index]),
        };
        if (![row.high, row.low, row.close, row.volume].every(Number.isFinite) || row.volume <= 0) return;
        if (rows.at(-1)?.date === row.date) rows.pop();
        rows.push(row);
    });

    // Якщо Yahoo вже переписав старі ціни під пізніший спліт, повертаємо масштаб дня угоди.
    const splitFactor = laterSplitFactor(result?.events?.splits, rows, targetDate);
    if (splitFactor !== 1) {
        rows.forEach((row) => {
            if (row.date >= targetDate) return;
            row.high /= splitFactor;
            row.low /= splitFactor;
            row.close /= splitFactor;
            row.volume *= splitFactor;
        });
    }

    // Критерії входу не повинні бачити результат поточного дня. Беремо останню
    // повністю завершену торгову сесію строго перед датою угоди.
    let targetIndex = -1;
    rows.forEach((row, index) => { if (row.date < targetDate) targetIndex = index; });
    if (targetIndex < 0) throw new Error(`Немає завершеної сесії перед ${targetDate}`);
    if (targetIndex < 14) throw new Error('Недостатньо історії для ATR 14');

    // Як у таблиці журналу: ATR — середній денний діапазон цих 14 сесій,
    // середній обсяг — 14 сесій перед ними, VolPlay — обсяг цього дня поділений на середнє разом із ним.
    const sessions = rows.slice(targetIndex - 13, targetIndex + 1);
    const priorSessions = rows.slice(targetIndex - 14, targetIndex);
    const vol = rows[targetIndex].volume;
    const playAverage = mean(sessions.map((row) => row.volume));

    return {
        atr: Number(mean(sessions.map((row) => row.high - row.low)).toFixed(2)),
        avg_vol: Math.round(mean(priorSessions.map((row) => row.volume))),
        vol: Math.round(vol),
        vol_play: Number((vol / playAverage).toFixed(1)),
        as_of_date: rows[targetIndex].date,
        basis: 'previous-session',
    };
}

function parseCompactNumber(text) {
    const cleaned = String(text || '').replace(/,/g, '').trim().toUpperCase();
    const match = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([KMBT])?$/);
    if (!match) return null;
    const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    return Math.round(Number(match[1]) * (multipliers[match[2]] || 1));
}

export function parseFinvizFloat(html) {
    const source = String(html || '');
    const match = source.match(/>\s*Shs Float\s*<\/(?:div|a|span)>[\s\S]{0,240}?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
        || source.match(/>\s*Shs Float\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!match) return { shs_float: null, shs_float_display: '', shs_float_raw: '' };
    const raw = match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim().slice(0, 40);
    const value = parseCompactNumber(raw);
    return {
        shs_float: value,
        shs_float_display: raw,
        shs_float_raw: raw,
    };
}

export function yahooRangeForDates(dates = []) {
    const sorted = [...dates].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    const start = new Date(`${(sorted[0] || '2024-01-01')}T12:00:00Z`);
    const end = new Date(`${(sorted.at(-1) || sorted[0] || '2024-01-01')}T12:00:00Z`);
    return {
        period1: Math.floor((start.getTime() - 180 * 86400000) / 1000),
        // Вікно до сьогодні, щоб у відповіді були спліти, які сталися вже після угоди.
        period2: Math.max(Math.floor((end.getTime() + 2 * 86400000) / 1000), Math.floor(Date.now() / 1000) + 86400),
    };
}

function requestDates(body = {}) {
    const many = Array.isArray(body.dates) ? body.dates : [];
    const single = body.date ? [body.date] : [];
    return [...new Set([...many, ...single].map((date) => String(date || '').trim()).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort().slice(0, 200);
}

function cleanVolPre(source) {
    if (!source || typeof source !== 'object') return {};
    return Object.fromEntries(Object.entries(source).filter(([minute, value]) => /^\d{3,4}$/.test(minute) && Number.isFinite(Number(value)) && Number(value) >= 0).map(([minute, value]) => [minute, Math.round(Number(value))]));
}

function volPreForDate(body, date, dates) {
    const mapped = body?.volPreByDate?.[date];
    if (mapped && typeof mapped === 'object') return cleanVolPre(mapped);
    if (dates.length === 1) return cleanVolPre(body?.volPreByMinute);
    return {};
}

function isTransientSourceError(error) {
    const message = String(error?.message || error || '');
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' || /HTTP (?:429|5\d\d)|не відповіло|Timeout|network|fetch failed/i.test(message);
}

async function fetchYahooChart(ticker, dates) {
    const { period1, period2 } = yahooRangeForDates(dates);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=split`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
    if (body?.chart?.error) throw new Error(body.chart.error.description || 'Yahoo ticker error');
    return body;
}

async function fetchFinvizFloat(ticker) {
    const response = await fetch(`https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}&p=d`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { shs_float: null, shs_float_display: '', shs_float_raw: '' };
    return parseFinvizFloat(await response.text());
}

async function archiveCriteria(ticker, tradeDate, metrics) {
    const url = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key) return false;
    const path = `${encodeURIComponent(ticker)}/${encodeURIComponent(tradeDate)}.criteria.json`;
    const response = await fetch(`${url}/storage/v1/object/polygon-cache/${path}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' },
        body: JSON.stringify({ version: 1, ticker, date: tradeDate, savedAt: new Date().toISOString(), criteria: metrics }),
    });
    if (!response.ok) console.warn(`[Trade criteria archive] ${ticker} ${tradeDate}: HTTP ${response.status}`);
    return response.ok;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    try {
        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user) return sendJson(res, 401, { ok: false, error: 'Потрібно увійти в акаунт' });

        const ticker = String(req.body?.ticker || '').trim().toUpperCase();
        const dates = requestDates(req.body);
        if (!TICKER_RE.test(ticker)) return sendJson(res, 400, { ok: false, error: 'Невірний тікер' });
        if (!dates.length) return sendJson(res, 400, { ok: false, error: 'Невірна дата' });

        const [yahooChartResult, floatResult] = await Promise.allSettled([
            fetchYahooChart(ticker, dates),
            fetchFinvizFloat(ticker),
        ]);
        if (yahooChartResult.status === 'rejected' && isTransientSourceError(yahooChartResult.reason) && floatResult.status === 'rejected') {
            throw yahooChartResult.reason;
        }
        const floatData = floatResult.status === 'fulfilled' ? floatResult.value : {
            shs_float: null, shs_float_display: '', shs_float_raw: '',
        };
        const updatedAt = new Date().toISOString();
        const results = [];
        for (const tradeDate of dates) {
            let yahoo = { atr: null, avg_vol: null, vol: null, vol_play: null, as_of_date: null, basis: 'unavailable' };
            let yahooError = yahooChartResult.status === 'rejected' ? (yahooChartResult.reason?.message || String(yahooChartResult.reason)) : '';
            if (!yahooError) {
                try {
                    yahoo = calculateYahooMetrics(yahooChartResult.value, tradeDate);
                } catch (error) {
                    yahooError = error?.message || String(error);
                }
            }
            if (isTransientSourceError(yahooError)) {
                results.push({ date: tradeDate, ok: false, error: yahooError });
                continue;
            }
            const metrics = {
                ...yahoo,
                ...floatData,
                vol_pre_by_minute: volPreForDate(req.body, tradeDate, dates),
                source: 'yahoo+finviz',
                source_errors: {
                    ...(yahooError ? { yahoo: yahooError } : {}),
                    ...(floatResult.status === 'rejected' ? { finviz: floatResult.reason?.message || String(floatResult.reason) } : {}),
                },
                updated_at: updatedAt,
            };
            try {
                const matches = await supabaseRest('rpc/upsert_trade_polygon_metrics', {
                    method: 'POST',
                    body: JSON.stringify({
                        p_user_id: user.id,
                        p_trade_date: tradeDate,
                        p_ticker: ticker,
                        p_metrics: metrics,
                    }),
                });
                const archived = await archiveCriteria(ticker, tradeDate, metrics).catch(() => false);
                results.push({
                    date: tradeDate,
                    ok: true,
                    partial: Boolean(yahooError) || floatResult.status === 'rejected',
                    matches: Number(matches) || 0,
                    archived,
                    metrics,
                });
            } catch (error) {
                results.push({ date: tradeDate, ok: false, error: error?.message || String(error) });
            }
        }
        const first = results[0] || {};
        return sendJson(res, results.some((item) => item.ok) ? 200 : 502, {
            ok: results.some((item) => item.ok),
            partial: results.some((item) => item.partial || !item.ok) || floatResult.status === 'rejected',
            ticker,
            date: dates.length === 1 ? dates[0] : undefined,
            matches: first.matches || 0,
            archived: first.archived || false,
            metrics: dates.length === 1 ? first.metrics : undefined,
            results,
        });
    } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return sendJson(res, timeout ? 504 : 500, {
            ok: false,
            error: timeout ? 'Джерело даних не відповіло вчасно' : (error?.message || String(error)),
        });
    }
}
