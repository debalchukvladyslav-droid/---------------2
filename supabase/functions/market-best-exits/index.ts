import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const DEFAULT_ORIGIN = 'https://traderjournal-six.vercel.app';
const MAX_ITEMS = 5;

function cors(req: Request) {
    const allowed = new Set([DEFAULT_ORIGIN, 'http://localhost:8787', 'http://127.0.0.1:8787', ...(Deno.env.get('APP_ALLOWED_ORIGINS') || '').split(',')]);
    const origin = req.headers.get('Origin') || '';
    return {
        'Access-Control-Allow-Origin': allowed.has(origin) ? origin : DEFAULT_ORIGIN,
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin',
    };
}

function json(req: Request, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

function nyOffset(date: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', timeZoneName: 'shortOffset', hour: '2-digit',
    }).formatToParts(new Date(`${date}T16:00:00Z`));
    const raw = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT-5';
    const match = raw.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    const hour = Number(match?.[1] || -5);
    return `${hour >= 0 ? '+' : '-'}${String(Math.abs(hour)).padStart(2, '0')}:${match?.[2] || '00'}`;
}

function minuteInNewYork(value: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

async function rest(path: string, init: RequestInit = {}) {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    return fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'POST') return json(req, { message: 'Method not allowed' }, 405);
    const auth = req.headers.get('Authorization');
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const user = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, { headers: { Authorization: auth || '', apikey: anon } });
    if (!user.ok) return json(req, { message: 'Invalid auth token' }, 401);

    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : [];
    if (!items.length || body?.items?.length > MAX_ITEMS) return json(req, { message: `items must contain 1-${MAX_ITEMS} rows` }, 400);
    const normalized = items.map((item: any) => ({
        symbol: String(item?.symbol || '').toUpperCase(),
        date: String(item?.date || ''),
        entryMinute: Math.max(570, Number(item?.entryMinute) || 570),
    })).filter((item: any) => /^[A-Z]{1,10}$/.test(item.symbol) && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.entryMinute < 720);

    const cachedChecks = await Promise.all(normalized.map(async (item) => {
        const query = `market_best_exit_cache?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&entry_minute=eq.${item.entryMinute}&select=symbol,trade_date,entry_minute,low_price,low_at`;
        const cachedRes = await rest(query);
        const cached = cachedRes.ok ? await cachedRes.json() : [];
        const cachedMinute = cached?.[0] ? minuteInNewYork(cached[0].low_at) : null;
        if (cached?.[0] && cachedMinute != null && cachedMinute >= 570 && cachedMinute < 720) {
            return { item, result: { symbol: item.symbol, date: item.date, entryMinute: item.entryMinute, low: Number(cached[0].low_price), lowTime: cached[0].low_at, cached: true } };
        }
        return { item, result: null };
    }));
    const results: any[] = cachedChecks.map((row) => row.result).filter(Boolean);
    const missing = cachedChecks.filter((row) => !row.result).map((row) => row.item);

    const polygonKey = Deno.env.get('POLYGON_API_KEY') || '';
    const groups = new Map<string, any[]>();
    missing.forEach((item) => {
        const key = `${item.symbol}|${item.date}`;
        groups.set(key, [...(groups.get(key) || []), item]);
    });
    const downloaded = await Promise.all([...groups.values()].map(async (groupItems) => {
        const item = groupItems[0];
        const offset = nyOffset(item.date);
        const from = new Date(`${item.date}T09:30:00${offset}`).getTime();
        const to = new Date(`${item.date}T12:00:00${offset}`).getTime();
        const params = new URLSearchParams({ adjusted: 'false', sort: 'asc', limit: '1000', apiKey: polygonKey });
        const marketRes = await fetch(`https://api.polygon.io/v2/aggs/ticker/${item.symbol}/range/1/minute/${from}/${to}?${params}`, { signal: AbortSignal.timeout(12000) });
        const market = await marketRes.json().catch(() => ({}));
        if (!marketRes.ok || !Array.isArray(market.results) || !market.results.length) return [];
        const minuteFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const barsByMinute = new Map<number, any>();
        market.results.forEach((bar: any) => {
            const [hour, minute] = minuteFormatter.format(new Date(Number(bar.t))).split(':').map(Number);
            barsByMinute.set(hour * 60 + minute, bar);
        });
        let suffixLow: any = null;
        const cacheRows: any[] = [];
        for (let minute = 719; minute >= 570; minute -= 1) {
            const bar = barsByMinute.get(minute);
            if (bar && (!suffixLow || Number(bar.l) <= Number(suffixLow.l))) suffixLow = bar;
            if (!suffixLow) continue;
            cacheRows.push({
                symbol: item.symbol, trade_date: item.date, entry_minute: minute,
                low_price: Number(suffixLow.l), low_at: new Date(Number(suffixLow.t)).toISOString(),
                provider: 'polygon', updated_at: new Date().toISOString(),
            });
        }
        await rest('market_best_exit_cache?on_conflict=symbol,trade_date,entry_minute', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(cacheRows),
        });
        const groupResults: any[] = [];
        groupItems.forEach((requested) => {
            const row = cacheRows.find((candidate) => candidate.entry_minute === requested.entryMinute);
            if (row) groupResults.push({ symbol: item.symbol, date: item.date, entryMinute: requested.entryMinute, low: row.low_price, lowTime: row.low_at, cached: false });
        });
        return groupResults;
    }));
    downloaded.forEach((rows) => results.push(...rows));
    return json(req, { results });
});
