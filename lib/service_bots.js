import crypto from 'node:crypto';
import { supabaseRest, verifySupabaseUser } from '../api/_google_sheet_sync_lib.js';

export const SERVICE_BOT_PERMISSION = 'api_service_snapshot_read';
export const MAX_RANGE_DAYS = 31;
const DEFAULT_LIMIT = 100;
const DEFAULT_TOP_LIMIT = 20;
const DEFAULT_CACHE_TTL_SEC = 30;

const snapshotCache = new Map();

export function sendJson(res, status, body, extraHeaders = {}) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value));
    res.end(JSON.stringify(body));
}

export function sendEmpty(res, status, extraHeaders = {}) {
    Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value));
    res.status(status).end();
}

function isValidIsoDateString(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr, delta) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return dt.toISOString().slice(0, 10);
}

function inclusiveDays(start, end) {
    const a = Date.parse(`${start}T00:00:00Z`);
    const b = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.floor((b - a) / 86400000) + 1;
}

function cleanPositiveInt(value, fallback, max = 1000) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(max, Math.floor(n)));
}

export function parseServiceBotRange(query = {}, latestDate = '') {
    const date = String(query.date || '').trim();
    let start = String(query.start || '').trim();
    let end = String(query.end || '').trim();
    const days = cleanPositiveInt(query.days, 1, MAX_RANGE_DAYS);

    if (date) {
        if (!isValidIsoDateString(date)) throw Object.assign(new Error('Invalid date'), { status: 400 });
        start = date;
        end = date;
    } else if (start || end) {
        if (start && !isValidIsoDateString(start)) throw Object.assign(new Error('Invalid start'), { status: 400 });
        if (end && !isValidIsoDateString(end)) throw Object.assign(new Error('Invalid end'), { status: 400 });
        if (!start && end) start = addDays(end, -(days - 1));
        if (start && !end) end = addDays(start, days - 1);
    } else {
        if (!latestDate) return { start: '', end: '', days: 0 };
        end = latestDate;
        start = addDays(end, -(days - 1));
    }

    if (start > end) throw Object.assign(new Error('start must be before end'), { status: 400 });
    const count = inclusiveDays(start, end);
    if (count > MAX_RANGE_DAYS) throw Object.assign(new Error('Max range is 31 days'), { status: 400 });
    return { start, end, days: count };
}

function allowedEndpoints(extraData = {}) {
    const endpoints = extraData?.allowed_endpoints;
    if (!Array.isArray(endpoints)) return [];
    return endpoints.map((item) => String(item || '').trim()).filter(Boolean);
}

export function hasServiceBotPermission(bot) {
    const endpoints = allowedEndpoints(bot?.extra_data);
    return endpoints.includes(SERVICE_BOT_PERMISSION) || endpoints.includes('*') || endpoints.includes('all');
}

function isAllTradersBot(bot = {}) {
    const scope = String(bot?.extra_data?.scope || bot?.extra_data?.subject || '').trim().toLowerCase();
    return !bot?.user_id || scope === 'all_traders' || scope === 'all' || scope === '*';
}

function serviceBotDataSource(bot = {}) {
    const value = String(bot?.extra_data?.data_source || bot?.extra_data?.source || 'all').trim().toLowerCase();
    return ['all', 'ppro', 'fondexx'].includes(value) ? value : 'all';
}

function botKeyFromReq(req) {
    const value = req.headers['x-bot-key'] || req.headers['x-api-key'];
    return Array.isArray(value) ? value[0] : String(value || '').trim();
}

export async function authenticateServiceBot(req) {
    const apiKey = botKeyFromReq(req);
    if (!apiKey) throw Object.assign(new Error('No valid auth was provided'), { status: 401 });

    const rows = await supabaseRest(
        `bots?api_key=eq.${encodeURIComponent(apiKey)}&select=*&limit=1`,
    );
    const bot = rows?.[0];
    if (!bot) throw Object.assign(new Error('No valid auth was provided'), { status: 401 });
    if (bot.enabled === false) throw Object.assign(new Error('Bot is disabled'), { status: 403 });
    if (bot.bot_type !== 'service') throw Object.assign(new Error('Bot is not a service bot'), { status: 403 });
    if (!hasServiceBotPermission(bot)) throw Object.assign(new Error('Bot access is not allowed'), { status: 403 });
    const allTraders = isAllTradersBot(bot);
    let profile = { id: '', nick: 'All traders', team: '' };
    if (!allTraders) {
        if (!bot.user_id) throw Object.assign(new Error('Bot has no subject user'), { status: 403 });
        const profiles = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(bot.user_id)}&select=id,nick,team&limit=1`,
        );
        profile = profiles?.[0] || { id: bot.user_id, nick: '', team: '' };
    }

    await supabaseRest(`bots?id=eq.${encodeURIComponent(bot.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => null);

    return { bot, profile, allTraders };
}

export async function getLatestTradeDate(userId) {
    const rows = await supabaseRest(
        `journal_days?user_id=eq.${encodeURIComponent(userId)}&select=trade_date&order=trade_date.desc&limit=1`,
    );
    return rows?.[0]?.trade_date || '';
}

export async function getLatestTradeDateAll() {
    const rows = await supabaseRest(
        'journal_days?select=trade_date&order=trade_date.desc&limit=1',
    );
    return rows?.[0]?.trade_date || '';
}

export async function fetchJournalRows(userId, range) {
    if (!range?.start || !range?.end) return [];
    return supabaseRest(
        `journal_days?user_id=eq.${encodeURIComponent(userId)}&trade_date=gte.${encodeURIComponent(range.start)}&trade_date=lte.${encodeURIComponent(range.end)}&select=user_id,trade_date,pnl,gross_pnl,commissions,locates,daily_metrics&order=trade_date.desc`,
    );
}

export async function fetchJournalRowsAll(range) {
    if (!range?.start || !range?.end) return [];
    return supabaseRest(
        `journal_days?trade_date=gte.${encodeURIComponent(range.start)}&trade_date=lte.${encodeURIComponent(range.end)}&select=user_id,trade_date,pnl,gross_pnl,commissions,locates,daily_metrics&order=trade_date.desc`,
    );
}

export async function fetchProfilesForRows(rows = []) {
    const userIds = [...new Set((rows || []).map((row) => row.user_id).filter(Boolean))];
    if (!userIds.length) return new Map();
    const ids = userIds.map((id) => encodeURIComponent(`"${id}"`)).join(',');
    const profiles = await supabaseRest(`profiles?id=in.(${ids})&select=id,nick,team`);
    return new Map((profiles || []).map((profile) => [profile.id, profile]));
}

function isPureGoogleSheetTrade(trade) {
    return !!(trade?.sheet && typeof trade.sheet === 'object' && trade.sheet.source === 'google' && !trade.sheet.matchedBy);
}

function visibleTradesFromRow(row, source = 'all') {
    const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
    if (source === 'ppro') return sourceDerivedTrades('ppro', metrics.ppro, row);
    if (source === 'fondexx') return sourceDerivedTrades('fondexx', metrics.fondexx, row);

    const trades = Array.isArray(metrics.trades) ? metrics.trades : [];
    const visible = trades.filter((trade) => !isPureGoogleSheetTrade(trade));
    return visible.length ? visible : derivedTradesFromRow(row);
}

function numberOrZero(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function normalizeSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function sourceHasValue(source = {}) {
    return !!(
        Number(source?.gross)
        || Number(source?.net)
        || Number(source?.comm)
        || Number(source?.locates)
        || (Array.isArray(source?.tickers) && source.tickers.length)
    );
}

function splitMoney(value, count) {
    const n = Number(value) || 0;
    const c = Math.max(1, count || 1);
    return Number((n / c).toFixed(2));
}

function sourceDerivedTrades(sourceName, source = {}, row) {
    if (!sourceHasValue(source)) return [];
    const tickers = Array.isArray(source.tickers)
        ? [...new Set(source.tickers.map(normalizeSymbol).filter(Boolean))]
        : [];
    const symbols = tickers.length ? tickers : [sourceName.toUpperCase()];
    return symbols.map((symbol) => ({
        symbol,
        type: 'derived',
        opened: `${row.trade_date} 00:00:00`,
        closed: '',
        qty: 0,
        gross: splitMoney(source.gross, symbols.length),
        comm: splitMoney(source.comm, symbols.length),
        net: splitMoney(source.net, symbols.length),
        exchange: sourceName,
        demo: false,
        derived: true,
        derived_source: `daily_metrics.${sourceName}`,
    }));
}

function derivedTradesFromRow(row) {
    const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
    const sourceTrades = [
        ...sourceDerivedTrades('fondexx', metrics.fondexx, row),
        ...sourceDerivedTrades('ppro', metrics.ppro, row),
    ];
    if (sourceTrades.length) return sourceTrades;

    const tickers = Array.isArray(metrics.traded_tickers)
        ? [...new Set(metrics.traded_tickers.map(normalizeSymbol).filter(Boolean))]
        : [];
    const symbols = tickers.length ? tickers : ['JOURNAL_TOTAL'];
    const hasDayTotal = Number(row?.pnl) || Number(row?.gross_pnl) || Number(row?.commissions) || Number(row?.locates);
    if (!hasDayTotal && !tickers.length) return [];
    return symbols.map((symbol) => ({
        symbol,
        type: 'derived',
        opened: `${row.trade_date} 00:00:00`,
        closed: '',
        qty: 0,
        gross: splitMoney(row?.gross_pnl ?? row?.pnl, symbols.length),
        comm: splitMoney(row?.commissions, symbols.length),
        net: splitMoney(row?.pnl, symbols.length),
        exchange: 'journal',
        demo: false,
        derived: true,
        derived_source: 'journal_days',
    }));
}

function tradeOpenedValue(trade, dateStr) {
    return String(trade?.opened || `${dateStr} 00:00:00`).trim();
}

function tradeExchange(trade) {
    return String(trade?.exchange || trade?.sheet?.exchange || '').trim() || 'unknown';
}

function recentTradeItem(trade, row, index, profile = null) {
    return {
        date: row.trade_date,
        user_id: row.user_id || '',
        trader: profile
            ? { id: profile.id || row.user_id || '', nick: profile.nick || '', team: profile.team || '' }
            : null,
        index,
        symbol: normalizeSymbol(trade?.symbol),
        type: trade?.type || trade?.sheet?.tradeType || '',
        opened: tradeOpenedValue(trade, row.trade_date),
        closed: trade?.closed || '',
        qty: numberOrZero(trade?.qty),
        gross: numberOrZero(trade?.gross),
        comm: numberOrZero(trade?.comm),
        net: numberOrZero(trade?.net),
        exchange: tradeExchange(trade),
        demo: trade?.demo === true,
        derived: trade?.derived === true,
        derived_source: trade?.derived_source || '',
        sheet: trade?.sheet && typeof trade.sheet === 'object'
            ? {
                source: trade.sheet.source || '',
                matchedBy: trade.sheet.matchedBy || '',
                spreadsheetId: trade.sheet.spreadsheetId || '',
                sheetRow: trade.sheet.sheetRow ?? null,
            }
            : null,
    };
}

function topRows(map, limit, mapper = (value) => value) {
    return [...map.values()]
        .sort((a, b) => (b.count || b.total || 0) - (a.count || a.total || 0) || String(a.symbol || a.key || '').localeCompare(String(b.symbol || b.key || '')))
        .slice(0, limit)
        .map(mapper);
}

export function buildServiceBotSnapshot(rows = [], range = {}, options = {}) {
    const limit = cleanPositiveInt(options.limit, DEFAULT_LIMIT, 500);
    const topLimit = cleanPositiveInt(options.top_limit, DEFAULT_TOP_LIMIT, 100);
    const dataSource = ['ppro', 'fondexx'].includes(String(options.data_source || '').toLowerCase())
        ? String(options.data_source).toLowerCase()
        : 'all';
    const profilesById = options.profilesById instanceof Map ? options.profilesById : new Map();
    const tickerMap = new Map();
    const exchangeMap = new Map();
    const traderMap = new Map();
    const tradeItems = [];
    const locateItems = [];
    let requestedSize = 0;
    let filledSize = 0;
    let demoCount = 0;
    let totalLocates = 0;

    for (const row of rows || []) {
        const profile = profilesById.get(row.user_id) || null;
        const trades = visibleTradesFromRow(row, dataSource);
        trades.forEach((trade, index) => {
            const symbol = normalizeSymbol(trade?.symbol);
            if (!symbol) return;
            const qty = numberOrZero(trade?.qty);
            const net = numberOrZero(trade?.net);
            const gross = numberOrZero(trade?.gross);
            const comm = numberOrZero(trade?.comm);
            requestedSize += qty;
            filledSize += qty;
            if (trade?.demo === true) demoCount++;

            const current = tickerMap.get(symbol) || { symbol, count: 0, qty: 0, gross: 0, comm: 0, net: 0 };
            current.count += 1;
            current.qty += qty;
            current.gross += gross;
            current.comm += comm;
            current.net += net;
            tickerMap.set(symbol, current);

            const exchange = tradeExchange(trade);
            const ex = exchangeMap.get(exchange) || { exchange, count: 0 };
            ex.count += 1;
            exchangeMap.set(exchange, ex);

            const traderKey = row.user_id || 'unknown';
            const trader = traderMap.get(traderKey) || {
                user_id: row.user_id || '',
                nick: profile?.nick || row.user_id || 'unknown',
                team: profile?.team || '',
                count: 0,
                qty: 0,
                net: 0,
            };
            trader.count += 1;
            trader.qty += qty;
            trader.net += net;
            traderMap.set(traderKey, trader);

            tradeItems.push(recentTradeItem(trade, row, index, profile));
        });

        const locates = numberOrZero(row?.locates);
        if (locates > 0) {
            totalLocates += locates;
            locateItems.push({
                date: row.trade_date,
                status: 'derived',
                total_price: Number(locates.toFixed(2)),
                source: 'journal_days.locates',
            });
        }
    }

    tradeItems.sort((a, b) => String(b.opened).localeCompare(String(a.opened)));
    locateItems.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const topTickers = topRows(tickerMap, topLimit, row => ({
        ...row,
        gross: Number(row.gross.toFixed(2)),
        comm: Number(row.comm.toFixed(2)),
        net: Number(row.net.toFixed(2)),
    }));
    const byExchange = topRows(exchangeMap, topLimit);
    const topTraders = topRows(traderMap, topLimit, row => ({
        ...row,
        net: Number(row.net.toFixed(2)),
    }));
    const uniqueTickers = tickerMap.size;
    const totalEvents = tradeItems.length;
    const traderCount = traderMap.size || (rows?.length ? 1 : 0);

    const tickers = {
        range,
        summary: {
            total_events: totalEvents,
            unique_count: uniqueTickers,
            with_locate_price_count: locateItems.length,
            blocked_count: 0,
        },
        top: topTickers,
        by_exchange: byExchange,
        items: tradeItems.slice(0, limit),
    };

    const orders = {
        range,
        summary: {
            total: totalEvents,
            unique_tickers: uniqueTickers,
            traders: traderCount,
            requested_size: requestedSize,
            filled_size: filledSize,
            demo_count: demoCount,
        },
        by_status: totalEvents ? [{ status: 'filled', count: totalEvents }] : [],
        top_tickers: topTickers,
        top_traders: topTraders,
        items: tradeItems.slice(0, limit).map(item => ({ ...item, status: 'filled' })),
    };

    const locates = {
        range,
        summary: {
            total: locateItems.length,
            unique_tickers: 0,
            traders: traderCount,
            bots: 1,
            total_size: 0,
            average_price: locateItems.length ? Number((totalLocates / locateItems.length).toFixed(4)) : 0,
            total_price: Number(totalLocates.toFixed(2)),
        },
        by_status: locateItems.length ? [{ status: 'derived', count: locateItems.length }] : [],
        top_tickers: [],
        top_traders: topTraders,
        items: locateItems.slice(0, limit),
    };

    return {
        summary: {
            range,
            tickers: tickers.summary,
            locates: locates.summary,
            orders: orders.summary,
        },
        tickers,
        locates,
        orders,
    };
}

function cacheTtlMs() {
    const n = Number(process.env.SERVICE_BOT_SNAPSHOT_CACHE_TTL_SEC);
    return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_SEC) * 1000;
}

function createEtag(payload) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
    return `"${hash}"`;
}

export async function buildServiceBotResponse(req, endpoint) {
    const { bot, profile, allTraders } = await authenticateServiceBot(req);
    const dataSource = serviceBotDataSource(bot);
    const latestDate = allTraders ? await getLatestTradeDateAll() : await getLatestTradeDate(bot.user_id);
    const range = parseServiceBotRange(req.query || {}, latestDate);
    const limit = cleanPositiveInt(req.query?.limit, DEFAULT_LIMIT, 500);
    const topLimit = cleanPositiveInt(req.query?.top_limit, DEFAULT_TOP_LIMIT, 100);
    const refreshValue = String(req.query?.refresh || '').toLowerCase();
    const refresh = refreshValue === 'true' || refreshValue === '1';
    const ttl = cacheTtlMs();
    const cacheKey = JSON.stringify({ endpoint, botId: bot.id, userId: bot.user_id || 'all_traders', dataSource, range, limit, topLimit });
    const cached = snapshotCache.get(cacheKey);
    const now = Date.now();
    if (!refresh && cached && ttl > 0 && now - cached.ts < ttl) {
        return { ...cached.response, cacheHit: true };
    }

    const rows = allTraders ? await fetchJournalRowsAll(range) : await fetchJournalRows(bot.user_id, range);
    const profilesById = allTraders ? await fetchProfilesForRows(rows || []) : new Map([[profile.id || bot.user_id, profile]]);
    const sections = buildServiceBotSnapshot(rows || [], range, { limit, top_limit: topLimit, profilesById, data_source: dataSource });
    const baseMeta = {
        subject: {
            scope: allTraders ? 'all_traders' : 'trader',
            user_id: allTraders ? null : (profile.id || bot.user_id),
            nick: profile.nick || '',
            team: profile.team || '',
            traders: allTraders ? profilesById.size : 1,
        },
        bot: {
            id: bot.id,
            name: bot.name || '',
        },
        generated_at: new Date().toISOString(),
        cache: {
            ttl_sec: Math.round(ttl / 1000),
            refresh,
            hit: false,
        },
        data_source: dataSource === 'all' ? 'journal_days' : `journal_days.${dataSource}`,
    };

    const withMeta = (payload, warnings = []) => ({
        meta: warnings.length ? { ...baseMeta, warnings } : baseMeta,
        ...payload,
    });

    const payloadByEndpoint = {
        summary: withMeta(sections.summary),
        tickers: withMeta(sections.tickers),
        locates: withMeta(sections.locates, ['locates_derived_from_journal_totals']),
        orders: withMeta(sections.orders, ['orders_may_be_derived_from_journal_totals']),
        snapshot: withMeta({
            range,
            summary: sections.summary,
            tickers: sections.tickers,
            locates: sections.locates,
            orders: sections.orders,
        }, ['locates_derived_from_journal_totals', 'orders_may_be_derived_from_journal_totals']),
    };
    const payload = payloadByEndpoint[endpoint] || payloadByEndpoint.snapshot;
    const etag = createEtag(payload);
    const response = { status: 200, payload, etag, cacheHit: false };
    if (ttl > 0) snapshotCache.set(cacheKey, { ts: now, response });
    return response;
}

export async function handleServiceBotEndpoint(req, res, endpoint) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }
    try {
        const response = await buildServiceBotResponse(req, endpoint);
        const etag = response.etag;
        if (etag && req.headers['if-none-match'] === etag) {
            return sendEmpty(res, 304, { ETag: etag });
        }
        const payload = {
            ...response.payload,
            meta: {
                ...response.payload.meta,
                cache: {
                    ...(response.payload.meta?.cache || {}),
                    hit: response.cacheHit === true,
                },
            },
        };
        return sendJson(res, 200, payload, etag ? { ETag: etag } : {});
    } catch (error) {
        const status = error?.status || 500;
        return sendJson(res, status, { ok: false, error: error?.message || String(error) });
    }
}

export async function requireAdmin(req) {
    const user = await verifySupabaseUser(req.headers.authorization || '');
    if (!user?.id) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    const rows = await supabaseRest(
        `profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role&limit=1`,
    );
    if (rows?.[0]?.role !== 'admin') throw Object.assign(new Error('Admin only'), { status: 403 });
    return user;
}

export function createServiceBotApiKey() {
    return `shs_service_${crypto.randomBytes(24).toString('base64url')}`;
}

export function cleanBotPayload(body = {}) {
    const name = String(body.name || '').trim().slice(0, 120);
    const userId = String(body.user_id || body.userId || '').trim();
    const apiKey = String(body.api_key || body.apiKey || body.secret_key || body.secretKey || '').trim();
    const rawDataSource = String(body.data_source || body.dataSource || 'all').trim().toLowerCase();
    const dataSource = ['all', 'ppro', 'fondexx'].includes(rawDataSource) ? rawDataSource : 'all';
    const allTraders = body.all_traders === true || body.allTraders === true || userId === '__all_traders__';
    const enabled = body.enabled !== false;
    return { name: name || 'Service bot', userId: allTraders ? '' : userId, apiKey, dataSource, allTraders, enabled };
}
