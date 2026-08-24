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

export function calculateYahooMetrics(chart, targetDate) {
    const result = chart?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp || [];
    if (!quote || !timestamps.length) throw new Error('Yahoo не повернув історичні дані');

    const rows = timestamps.map((timestamp, index) => ({
        date: nyDate(timestamp),
        high: Number(quote.high?.[index]),
        low: Number(quote.low?.[index]),
        close: Number(quote.close?.[index]),
        volume: Number(quote.volume?.[index]),
    })).filter((row) => [row.high, row.low, row.close, row.volume].every(Number.isFinite));

    // Критерії входу не повинні бачити результат поточного дня. Беремо останню
    // повністю завершену торгову сесію строго перед датою угоди.
    let targetIndex = -1;
    rows.forEach((row, index) => { if (row.date < targetDate) targetIndex = index; });
    if (targetIndex < 0) throw new Error(`Немає завершеної сесії перед ${targetDate}`);
    if (targetIndex < 14) throw new Error('Недостатньо історії для ATR 14');

    const sessions = rows.slice(targetIndex - 13, targetIndex + 1);
    const trueRanges = sessions.map((row, offset) => {
        const rowIndex = targetIndex - 13 + offset;
        const previousClose = rows[rowIndex - 1].close;
        return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
    });
    const avgVol = mean(sessions.map((row) => row.volume));
    const vol = rows[targetIndex].volume;

    return {
        atr: Number(mean(trueRanges).toFixed(4)),
        avg_vol: Math.round(avgVol),
        vol: Math.round(vol),
        vol_play: Number((vol / avgVol).toFixed(4)),
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
    const match = String(html || '').match(/>\s*Shs Float\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!match) return { shs_float: null, shs_float_display: '' };
    const display = match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
    return { shs_float: parseCompactNumber(display), shs_float_display: display.slice(0, 40) };
}

async function fetchYahooMetrics(ticker, targetDate) {
    const target = new Date(`${targetDate}T12:00:00Z`);
    const period1 = Math.floor((target.getTime() - 90 * 86400000) / 1000);
    const period2 = Math.floor((target.getTime() + 2 * 86400000) / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
    if (body?.chart?.error) throw new Error(body.chart.error.description || 'Yahoo ticker error');
    return calculateYahooMetrics(body, targetDate);
}

async function fetchFinvizFloat(ticker) {
    const response = await fetch(`https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}&p=d`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { shs_float: null, shs_float_display: '' };
    return parseFinvizFloat(await response.text());
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
        const tradeDate = String(req.body?.date || '').trim();
        if (!TICKER_RE.test(ticker)) return sendJson(res, 400, { ok: false, error: 'Невірний тікер' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return sendJson(res, 400, { ok: false, error: 'Невірна дата' });

        const yahoo = await fetchYahooMetrics(ticker, tradeDate);
        const floatData = await fetchFinvizFloat(ticker);
        const metrics = {
            ...yahoo,
            ...floatData,
            source: 'yahoo+finviz',
            updated_at: new Date().toISOString(),
        };
        const result = await supabaseRest('rpc/upsert_trade_polygon_metrics', {
            method: 'POST',
            body: JSON.stringify({
                p_user_id: user.id,
                p_trade_date: tradeDate,
                p_ticker: ticker,
                p_metrics: metrics,
            }),
        });
        return sendJson(res, 200, {
            ok: true, ticker, date: tradeDate, matches: Number(result) || 0, metrics,
        });
    } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return sendJson(res, timeout ? 504 : 500, {
            ok: false,
            error: timeout ? 'Джерело даних не відповіло вчасно' : (error?.message || String(error)),
        });
    }
}
