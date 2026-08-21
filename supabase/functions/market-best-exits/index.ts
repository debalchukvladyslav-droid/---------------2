import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const DEFAULT_ORIGIN = 'https://traderjournal-six.vercel.app';
const MAX_ITEMS = 200;
const INTRADAY_CACHE_VERSION = 2;
const POLYGON_ARCHIVE_BUCKET = 'polygon-cache';
const POLYGON_ARCHIVE_VERSION = 1;
const POLYGON_CONTROL_PATH = '_control/state.json';

function cors(req: Request) {
    const allowed = new Set([DEFAULT_ORIGIN, 'http://localhost:8787', 'http://127.0.0.1:8787', ...(Deno.env.get('APP_ALLOWED_ORIGINS') || '').split(',')]);
    const origin = req.headers.get('Origin') || '';
    return {
        'Access-Control-Allow-Origin': allowed.has(origin) ? origin : DEFAULT_ORIGIN,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

function fiveMinutePriceQuery(item: { symbol: string; date: string }, targetMinute: number) {
    return `market_time_price_cache?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&target_minute=eq.${targetMinute}&limit=1&select=target_minute,close_price,price_at`;
}

async function readStopScenario(item: any, targetMinute: number | null) {
    const stopPrice = Number(item?.stopPrice);
    const stopEntryMinute = Number(item?.stopEntryMinute);
    if (targetMinute != null && Number.isInteger(stopEntryMinute) && targetMinute < stopEntryMinute) {
        return { available: true, result: { notOpened: true, stopHit: false, stopPrice: stopPrice > 0 ? stopPrice : null, stopEntryMinute } };
    }
    if (!(stopPrice > 0) || !Number.isInteger(stopEntryMinute) || targetMinute == null) {
        return { available: true, result: { stopHit: false, stopPrice: stopPrice > 0 ? stopPrice : null, stopEntryMinute } };
    }
    const query = `market_time_price_cache?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&target_minute=gte.${stopEntryMinute}&target_minute=lte.${targetMinute}&high_price=not.is.null&order=target_minute.asc&select=target_minute,high_price,high_at`;
    const response = await rest(query);
    const rows = response.ok ? await response.json() : [];
    if (!rows.length) return { available: false, result: null };
    const hit = rows.find((row: any) => Number(row.high_price) >= stopPrice);
    return {
        available: true,
        result: hit
            ? { stopHit: true, stopPrice, stopEntryMinute, stopMinute: Number(hit.target_minute), stopTime: hit.high_at }
            : { stopHit: false, stopPrice, stopEntryMinute },
    };
}

async function rest(path: string, init: RequestInit = {}) {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    return fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
}

function polygonArchivePath(symbol: string, date: string) {
    return `${symbol}/${date}.json`;
}

async function readPolygonArchive(symbol: string, date: string) {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const path = polygonArchivePath(symbol, date).split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/authenticated/${POLYGON_ARCHIVE_BUCKET}/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    // Storage returns 400 ("Object not found") for a missing private object.
    // A missing archive is a cache miss, not a failed Polygon job.
    if (response.status === 400 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Polygon archive read ${response.status}`);
    const archive = await response.json().catch(() => null);
    if (Number(archive?.version) !== POLYGON_ARCHIVE_VERSION || !Array.isArray(archive?.results) || !archive.results.length) return null;
    return archive.results;
}

async function writePolygonArchive(symbol: string, date: string, results: any[]) {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const path = polygonArchivePath(symbol, date).split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/${POLYGON_ARCHIVE_BUCKET}/${path}`, {
        method: 'POST',
        headers: {
            apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
            'x-upsert': 'true', 'Cache-Control': 'max-age=31536000',
        },
        body: JSON.stringify({ version: POLYGON_ARCHIVE_VERSION, symbol, date, provider: 'polygon', savedAt: new Date().toISOString(), results }),
    });
    if (!response.ok) throw new Error(`Polygon archive write ${response.status}`);
}

async function readPolygonControl() {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const path = POLYGON_CONTROL_PATH.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/authenticated/${POLYGON_ARCHIVE_BUCKET}/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return { paused: false };
    const value = await response.json().catch(() => ({}));
    return { paused: Number(value?.version) === 2 && value?.paused === true, updatedAt: String(value?.updatedAt || '') };
}

async function writePolygonControl(paused: boolean) {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const path = POLYGON_CONTROL_PATH.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/${POLYGON_ARCHIVE_BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-upsert': 'true' },
        body: JSON.stringify({ version: 2, paused, updatedAt: new Date().toISOString() }),
    });
    if (!response.ok) throw new Error(`Polygon control write ${response.status}`);
    return { paused, updatedAt: new Date().toISOString() };
}

async function isAdmin(userId: string) {
    const response = await rest(`profiles?id=eq.${userId}&select=role&limit=1`);
    const rows = response.ok ? await response.json() : [];
    return rows?.[0]?.role === 'admin';
}

async function enqueueAllJournalTrades() {
    const daysResponse = await rest('journal_days?select=trade_date,daily_metrics&order=trade_date.asc&limit=10000');
    if (!daysResponse.ok) throw new Error(`Journal read ${daysResponse.status}`);
    const days = await daysResponse.json();
    const unique = new Map<string, { symbol: string; trade_date: string }>();
    for (const day of days || []) {
        const trades = Array.isArray(day?.daily_metrics?.trades) ? day.daily_metrics.trades : [];
        for (const trade of trades) {
            const symbol = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
            const date = String(trade?.date || trade?.tradeDate || day.trade_date || '');
            if (/^[A-Z]{1,10}$/.test(symbol) && /^\d{4}-\d{2}-\d{2}$/.test(date)) unique.set(`${symbol}/${date}.json`, { symbol, trade_date: date });
        }
    }
    const archiveResponse = await rest('rpc/list_polygon_archive_keys', { method: 'POST', body: '{}' });
    if (!archiveResponse.ok) throw new Error(`Archive index ${archiveResponse.status}`);
    const archivedRows = await archiveResponse.json();
    const archived = new Set((archivedRows || []).map((row: any) => String(row?.object_name || row || '')));
    const missing = [...unique.entries()].filter(([path]) => !archived.has(path)).map(([, item]) => item);
    for (let offset = 0; offset < missing.length; offset += 250) {
        const now = new Date().toISOString();
        const rows = missing.slice(offset, offset + 250).map((item) => ({ ...item, status: 'pending', next_attempt_at: '1970-01-01T00:00:00.000Z', attempted_at: null, updated_at: now, last_error: '' }));
        const queued = await rest('market_low_jobs?on_conflict=symbol,trade_date', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
        });
        if (!queued.ok) throw new Error(`Queue write ${queued.status}`);
    }
    return { total: unique.size, archived: unique.size - missing.length, queued: missing.length, kickItem: missing[0] || null };
}

async function readDatabaseGraph(symbol: string, date: string) {
    const statusResponse = await rest(`market_intraday_cache_status?symbol=eq.${symbol}&trade_date=eq.${date}&select=bar_count&limit=1`);
    const statusRows = statusResponse.ok ? await statusResponse.json() : [];
    const expectedBars = Number(statusRows?.[0]?.bar_count) || 0;
    if (!expectedBars) return null;
    const rowsResponse = await rest(`market_time_price_cache?symbol=eq.${symbol}&trade_date=eq.${date}&order=target_minute.asc&limit=1000&select=open_price,high_price,low_price,close_price,price_at,volume,vwap,transactions`);
    const rows = rowsResponse.ok ? await rowsResponse.json() : [];
    if (rows.length < expectedBars) return null;
    return rows.map((row: any) => ({
        t: new Date(row.price_at).getTime(), o: Number(row.open_price), h: Number(row.high_price),
        l: Number(row.low_price), c: Number(row.close_price), v: Number(row.volume) || 0,
        vw: Number(row.vwap) || null, n: Number.isInteger(Number(row.transactions)) ? Number(row.transactions) : null,
    })).filter((bar: any) => Number.isFinite(bar.t) && bar.o > 0 && bar.h > 0 && bar.l > 0 && bar.c > 0);
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'POST') return json(req, { message: 'Method not allowed' }, 405);
    const auth = req.headers.get('Authorization');
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const user = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, { headers: { Authorization: auth || '', apikey: anon } });
    if (!user.ok) return json(req, { message: 'Invalid auth token' }, 401);
    const userData = await user.json().catch(() => ({}));

    const body = await req.json().catch(() => ({}));
    let adminQueueResult: any = null;
    if (String(body?.action || '').startsWith('admin-')) {
        if (!await isAdmin(String(userData?.id || ''))) return json(req, { message: 'Admin access required' }, 403);
        if (body.action === 'admin-status') {
            const control = await readPolygonControl();
            const countsResponse = await rest('market_low_jobs?select=status');
            const rows = countsResponse.ok ? await countsResponse.json() : [];
            const counts = (rows || []).reduce((acc: Record<string, number>, row: any) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
            return json(req, { ...control, counts });
        }
        if (body.action === 'admin-pause') {
            const control = await writePolygonControl(body.paused === true);
            console.log(`[Polygon admin] ${control.paused ? 'paused' : 'resumed'} by ${userData.id}`);
            return json(req, control);
        }
        if (body.action === 'admin-enqueue-all') {
            const queued = await enqueueAllJournalTrades();
            const control = await writePolygonControl(false);
            console.log(`[Polygon admin] enqueue all by ${userData.id}: total ${queued.total}, archived ${queued.archived}, queued ${queued.queued}; resumed`);
            if (!queued.kickItem) return json(req, { ...queued, ...control });
            adminQueueResult = { ...queued, ...control, kickItem: undefined };
            body.action = '';
            body.items = [{ symbol: queued.kickItem.symbol, date: queued.kickItem.trade_date, entryMinute: 570 }];
        }
        if (body.action) return json(req, { message: 'Unknown admin action' }, 400);
    }
    const requestedTargetMinute = Number(body?.targetMinute);
    const targetMinute = Number.isInteger(requestedTargetMinute) && requestedTargetMinute >= 540 && requestedTargetMinute <= 720 && requestedTargetMinute % 5 === 0
        ? requestedTargetMinute
        : null;
    const items = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : [];
    if (!items.length || body?.items?.length > MAX_ITEMS) return json(req, { message: `items must contain 1-${MAX_ITEMS} rows` }, 400);
    const normalized = items.map((item: any) => ({
        symbol: String(item?.symbol || '').toUpperCase(),
        date: String(item?.date || ''),
        entryMinute: Math.max(570, Number(item?.entryMinute) || 570),
        stopEntryMinute: Math.max(540, Math.min(720, Number(item?.stopEntryMinute) || Number(item?.entryMinute) || 570)),
        stopPrice: Number(item?.stopPrice) > 0 ? Number(item.stopPrice) : null,
    })).filter((item: any) => /^[A-Z]{1,10}$/.test(item.symbol) && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.entryMinute < 720);

    const cachedChecks = await Promise.all(normalized.map(async (item) => {
        const query = `market_best_exit_cache?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&entry_minute=eq.${item.entryMinute}&select=symbol,trade_date,entry_minute,low_price,low_at`;
        const cachedRes = await rest(query);
        const cached = cachedRes.ok ? await cachedRes.json() : [];
        const statusRes = await rest(`market_intraday_cache_status?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&cache_version=gte.${INTRADAY_CACHE_VERSION}&select=bar_count,cache_version&limit=1`);
        const statusRows = statusRes.ok ? await statusRes.json() : [];
        const fullGraphCached = Number(statusRows?.[0]?.bar_count) > 0;
        const cachedMinute = cached?.[0] ? minuteInNewYork(cached[0].low_at) : null;
        let timePrice: any = null;
        if (targetMinute != null) {
            const priceQuery = fiveMinutePriceQuery(item, targetMinute);
            const priceRes = await rest(priceQuery);
            const prices = priceRes.ok ? await priceRes.json() : [];
            timePrice = prices?.[0] || null;
        }
        const stopScenario = await readStopScenario(item, targetMinute);
        if (fullGraphCached && cached?.[0] && cachedMinute != null && cachedMinute >= 570 && cachedMinute < 720 && (targetMinute == null || (timePrice && stopScenario.available))) {
            return { item, result: { symbol: item.symbol, date: item.date, entryMinute: item.entryMinute, low: Number(cached[0].low_price), lowTime: cached[0].low_at, cached: true, ...(timePrice ? { targetMinute, priceMinute: Number(timePrice.target_minute), priceAtTime: Number(timePrice.close_price), priceTime: timePrice.price_at, ...stopScenario.result } : {}) } };
        }
        return { item, result: null };
    }));
    const results: any[] = cachedChecks.map((row) => row.result).filter(Boolean);
    const missing = cachedChecks.filter((row) => !row.result).map((row) => row.item);

    const uniqueMissing = [...new Map(missing.map((item) => [`${item.symbol}|${item.date}`, item])).values()];
    if (uniqueMissing.length) {
        await rest('market_low_jobs?on_conflict=symbol,trade_date', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(uniqueMissing.map((item) => ({ symbol: item.symbol, trade_date: item.date }))),
        });
        await Promise.all(uniqueMissing.map((item) => rest(`market_low_jobs?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&status=neq.processing`, {
            method: 'PATCH', body: JSON.stringify({ status: 'pending', next_attempt_at: '1970-01-01T00:00:00.000Z', updated_at: new Date().toISOString() }),
        })));
    }
    const control = await readPolygonControl();
    const claimResponse = control.paused ? null : await rest('rpc/claim_market_low_jobs', { method: 'POST', body: JSON.stringify({ max_jobs: 1 }) });
    const claimed = claimResponse?.ok ? await claimResponse.json() : [];
    const polygonKey = Deno.env.get('POLYGON_API_KEY') || '';
    const backgroundWork = Promise.all((claimed || []).slice(0, 1).map(async (job: any) => {
        const item = { symbol: String(job.symbol), date: String(job.trade_date) };
        try {
        let marketResults = await readPolygonArchive(item.symbol, item.date);
        let marketSource = 'supabase-storage';
        if (!marketResults) {
            marketResults = await readDatabaseGraph(item.symbol, item.date);
            marketSource = marketResults ? 'supabase-database' : 'polygon';
            if (!marketResults) {
                const offset = nyOffset(item.date);
                const from = new Date(`${item.date}T04:00:00${offset}`).getTime();
                const to = new Date(`${item.date}T20:00:00${offset}`).getTime();
                const params = new URLSearchParams({ adjusted: 'false', sort: 'asc', limit: '1000', apiKey: polygonKey });
                const marketRes = await fetch(`https://api.polygon.io/v2/aggs/ticker/${item.symbol}/range/1/minute/${from}/${to}?${params}`, { signal: AbortSignal.timeout(12000) });
                const market = await marketRes.json().catch(() => ({}));
                if (!marketRes.ok || !Array.isArray(market.results) || !market.results.length) throw new Error(market?.error || market?.message || `Polygon ${marketRes.status}`);
                marketResults = market.results;
            }
            try { await writePolygonArchive(item.symbol, item.date, marketResults); }
            catch (archiveError) { console.warn(`[Polygon archive] write deferred ${item.symbol} ${item.date}: ${archiveError?.message || archiveError}`); }
        }
        const minuteFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const barsByMinute = new Map<number, any>();
        marketResults.forEach((bar: any) => {
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
        const lowCacheSaved = await rest('market_best_exit_cache?on_conflict=symbol,trade_date,entry_minute', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(cacheRows),
        });
        if (!lowCacheSaved.ok) throw new Error(`Low cache write ${lowCacheSaved.status}`);
        const priceRows = [...barsByMinute.entries()]
            .filter(([minute, bar]) => minute >= 240 && minute <= 1200 && Number(bar?.c) > 0 && Number(bar?.h) > 0)
            .map(([minute, bar]) => ({
                symbol: item.symbol, trade_date: item.date, target_minute: minute,
                open_price: Number(bar.o),
                close_price: Number(bar.c), price_at: new Date(Number(bar.t)).toISOString(),
                high_price: Number(bar.h), high_at: new Date(Number(bar.t)).toISOString(),
                low_price: Number(bar.l),
                volume: Number(bar.v) || 0,
                vwap: Number(bar.vw) || null,
                transactions: Number.isInteger(Number(bar.n)) ? Number(bar.n) : null,
                provider: 'polygon', updated_at: new Date().toISOString(),
            }));
        for (let offset = 0; offset < priceRows.length; offset += 150) {
            const chunk = priceRows.slice(offset, offset + 150);
            const saved = await rest('market_time_price_cache?on_conflict=symbol,trade_date,target_minute', {
                method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(chunk),
            });
            if (!saved.ok) throw new Error(`Intraday cache write ${saved.status}`);
        }
        const statusSaved = await rest('market_intraday_cache_status?on_conflict=symbol,trade_date', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({
                symbol: item.symbol, trade_date: item.date, from_minute: 240, to_minute: 1200,
                bar_count: priceRows.length, cache_version: INTRADAY_CACHE_VERSION,
                provider: 'polygon', fetched_at: new Date().toISOString(),
            }),
        });
        if (!statusSaved.ok) throw new Error(`Cache status write ${statusSaved.status}`);
        await rest(`market_low_jobs?symbol=eq.${item.symbol}&trade_date=eq.${item.date}`, {
            method: 'PATCH', body: JSON.stringify({ status: 'ready', updated_at: new Date().toISOString(), last_error: '' }),
        });
        console.log(`[Polygon queue] ready ${item.symbol} ${item.date}; source: ${marketSource}; full graph cached: ${priceRows.length} one-minute OHLCV bars`);
        } catch (error) {
            const message = String(error?.message || error).slice(0, 500);
            await rest(`market_low_jobs?symbol=eq.${item.symbol}&trade_date=eq.${item.date}`, {
                method: 'PATCH', body: JSON.stringify({ status: 'failed', next_attempt_at: new Date(Date.now() + 65000).toISOString(), updated_at: new Date().toISOString(), last_error: message }),
            });
            console.warn(`[Polygon queue] failed ${item.symbol} ${item.date}: ${message}`);
        }
    }));
    EdgeRuntime.waitUntil(backgroundWork);
    for (const item of missing) {
        const query = `market_best_exit_cache?symbol=eq.${item.symbol}&trade_date=eq.${item.date}&entry_minute=eq.${item.entryMinute}&select=symbol,trade_date,entry_minute,low_price,low_at`;
        const cachedRes = await rest(query); const cached = cachedRes.ok ? await cachedRes.json() : [];
        let timePrice: any = null;
        if (targetMinute != null) {
            const priceQuery = fiveMinutePriceQuery(item, targetMinute);
            const priceRes = await rest(priceQuery); const prices = priceRes.ok ? await priceRes.json() : [];
            timePrice = prices?.[0] || null;
        }
        const stopScenario = await readStopScenario(item, targetMinute);
        if (cached?.[0] && (targetMinute == null || (timePrice && stopScenario.available))) results.push({ symbol: item.symbol, date: item.date, entryMinute: item.entryMinute, low: Number(cached[0].low_price), lowTime: cached[0].low_at, cached: false, ...(timePrice ? { targetMinute, priceMinute: Number(timePrice.target_minute), priceAtTime: Number(timePrice.close_price), priceTime: timePrice.price_at, ...stopScenario.result } : {}) });
    }
    return json(req, { ...(adminQueueResult || {}), results, queued: adminQueueResult?.queued ?? Math.max(0, uniqueMissing.length - results.length), processed: (claimed || []).length, polygonPaused: control.paused });
});
