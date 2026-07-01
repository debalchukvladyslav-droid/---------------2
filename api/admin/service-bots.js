import {
    buildServiceBotResponse,
    cleanBotPayload,
    createServiceBotApiKey,
    requireAdmin,
    sendJson,
    SERVICE_BOT_PERMISSION,
} from '../../lib/service_bots.js';
import { supabaseRest } from '../_google_sheet_sync_lib.js';

function botSelect() {
    return 'id,name,bot_type,user_id,extra_data,enabled,last_used_at,created_at,updated_at';
}

function firstValue(source = {}, names = []) {
    for (const name of names) {
        if (source?.[name] !== undefined && source?.[name] !== null && source?.[name] !== '') return source[name];
    }
    return '';
}

function collectArrayPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const candidates = ['data', 'items', 'orders', 'trades', 'positions', 'fills', 'rows', 'results'];
    for (const key of candidates) {
        if (Array.isArray(payload[key])) return payload[key];
        if (payload[key] && typeof payload[key] === 'object') {
            const nested = collectArrayPayload(payload[key]);
            if (nested.length) return nested;
        }
    }
    return [];
}

function normalizeExternalPproItems(payload, limit = 500) {
    const items = collectArrayPayload(payload).slice(0, limit);
    return items.map((item) => {
        const row = item && typeof item === 'object' ? item : {};
        return {
            date: firstValue(row, ['date', 'trade_date', 'created_at', 'time', 'timestamp', 'opened_at', 'opened']),
            trader: firstValue(row, ['trader', 'trader_nick', 'nick', 'nickname', 'username', 'user', 'account', 'login']),
            symbol: firstValue(row, ['symbol', 'ticker', 'instrument', 'sec', 'asset']),
            side: firstValue(row, ['side', 'direction', 'type', 'action']),
            qty: Number(firstValue(row, ['qty', 'quantity', 'shares', 'size', 'filled_size'])) || 0,
            entry_price: Number(firstValue(row, ['entry_price', 'price', 'avg_price', 'fill_price', 'opened_price'])) || 0,
            pnl: Number(firstValue(row, ['pnl', 'net', 'net_pnl', 'profit', 'realized_pnl'])) || 0,
            gross: Number(firstValue(row, ['gross', 'gross_pnl'])) || 0,
            commissions: Number(firstValue(row, ['commission', 'commissions', 'comm', 'fees', 'fee'])) || 0,
            locates: Number(firstValue(row, ['locates', 'locate_fee', 'locate_cost', 'borrow_fee'])) || 0,
            status: firstValue(row, ['status', 'state']),
            raw: row,
        };
    });
}

function assertSafeExternalUrl(rawUrl) {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol !== 'https:') throw new Error('External API URL must use https');
    const host = url.hostname.toLowerCase();
    if (
        host === 'localhost'
        || host.endsWith('.local')
        || host === '127.0.0.1'
        || host === '0.0.0.0'
        || host.startsWith('10.')
        || host.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
        throw new Error('External API host is not allowed');
    }
    return url;
}

async function fetchExternalPproProbe(body = {}) {
    const url = assertSafeExternalUrl(body.url || body.base_url || body.baseUrl);
    const apiKey = String(body.api_key || body.apiKey || body.secret_key || body.secretKey || '').trim();
    const authHeader = String(body.auth_header || body.authHeader || 'X-Api-Key').trim() || 'X-Api-Key';
    const limit = Math.max(1, Math.min(1000, Number(body.limit) || 500));
    ['start', 'end', 'date', 'limit'].forEach((name) => {
        const value = String(body[name] || '').trim();
        if (value) url.searchParams.set(name, value);
    });

    const headers = { Accept: 'application/json' };
    if (apiKey) headers[authHeader] = apiKey;

    const response = await fetch(url, { headers });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = { raw_text: text }; }
    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            payload,
        };
    }
    const items = normalizeExternalPproItems(payload, limit);
    return {
        ok: true,
        status: response.status,
        source_url: `${url.origin}${url.pathname}`,
        count: items.length,
        items,
        payload,
    };
}

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        const id = String(req.query?.id || '').trim();

        if (req.method === 'GET') {
            if (id && String(req.query?.data || '') === '1') {
                const endpoint = String(req.query?.endpoint || 'snapshot').trim();
                const allowed = new Set(['summary', 'tickers', 'locates', 'orders', 'snapshot']);
                if (!allowed.has(endpoint)) return sendJson(res, 404, { ok: false, error: 'Service bot endpoint not found' });
                const bots = await supabaseRest(`bots?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
                const bot = bots?.[0];
                if (!bot?.api_key) return sendJson(res, 404, { ok: false, error: 'Service bot key not found' });
                const query = { ...(req.query || {}) };
                delete query.id;
                delete query.data;
                delete query.endpoint;
                const response = await buildServiceBotResponse({
                    ...req,
                    query,
                    headers: {
                        ...(req.headers || {}),
                        'x-bot-key': bot.api_key,
                    },
                }, endpoint);
                return sendJson(res, 200, {
                    ...response.payload,
                    meta: {
                        ...(response.payload.meta || {}),
                        cache: {
                            ...(response.payload.meta?.cache || {}),
                            hit: response.cacheHit === true,
                        },
                    },
                });
            }

            const bots = await supabaseRest(`bots?select=${botSelect()}&order=created_at.desc`);
            const userIds = [...new Set((bots || []).map((bot) => bot.user_id).filter(Boolean))];
            let profiles = [];
            if (userIds.length) {
                const ids = userIds.map((id) => encodeURIComponent(`"${id}"`)).join(',');
                profiles = await supabaseRest(`profiles?id=in.(${ids})&select=id,nick,team`);
            }
            const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
            return sendJson(res, 200, {
                ok: true,
                bots: (bots || []).map((bot) => ({
                    ...bot,
                    profile: profileMap.get(bot.user_id) || null,
                })),
            });
        }

        if (req.method === 'PATCH') {
            if (!id) return sendJson(res, 400, { ok: false, error: 'Missing bot id' });
            const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
            const patch = {};
            if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 120) || 'Service bot';
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
            if (body.extra_data && typeof body.extra_data === 'object') patch.extra_data = body.extra_data;
            if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'No changes' });
            patch.updated_at = new Date().toISOString();

            const updated = await supabaseRest(`bots?id=eq.${encodeURIComponent(id)}&select=${botSelect()}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify(patch),
            });
            return sendJson(res, 200, { ok: true, bot: updated?.[0] || null });
        }

        if (req.method === 'DELETE') {
            if (!id) return sendJson(res, 400, { ok: false, error: 'Missing bot id' });
            await supabaseRest(`bots?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
            return sendJson(res, 200, { ok: true });
        }

        if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        if (body.action === 'external_ppro_probe') {
            const payload = await fetchExternalPproProbe(body);
            return sendJson(res, payload.ok ? 200 : 502, payload);
        }

        const payload = cleanBotPayload(body);
        if (!payload.userId && !payload.allTraders) return sendJson(res, 400, { ok: false, error: 'Missing user_id' });

        let profile = null;
        if (!payload.allTraders) {
            const profiles = await supabaseRest(
                `profiles?id=eq.${encodeURIComponent(payload.userId)}&select=id,nick,team&limit=1`,
            );
            if (!profiles?.[0]) return sendJson(res, 404, { ok: false, error: 'Profile not found' });
            profile = profiles[0];
        }

        if (payload.apiKey && payload.apiKey.length < 12) {
            return sendJson(res, 400, { ok: false, error: 'Secret key is too short' });
        }
        const apiKey = payload.apiKey || createServiceBotApiKey();
        const row = {
            name: payload.name,
            bot_type: 'service',
            api_key: apiKey,
            user_id: payload.allTraders ? null : payload.userId,
            extra_data: {
                allowed_endpoints: [SERVICE_BOT_PERMISSION],
                scope: payload.allTraders ? 'all_traders' : 'trader',
                data_source: payload.dataSource,
            },
            enabled: payload.enabled,
        };
        const inserted = await supabaseRest('bots?select=id,name,bot_type,user_id,extra_data,enabled,last_used_at,created_at,updated_at', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(row),
        });

        return sendJson(res, 201, {
            ok: true,
            api_key: apiKey,
            bot: {
                ...(inserted?.[0] || row),
                profile,
            },
        });
    } catch (error) {
        const status = error?.status || 500;
        return sendJson(res, status, { ok: false, error: error?.message || String(error) });
    }
}
