import { verifySupabaseUser } from './google_sheet_sync.js';

const SHS_BASE = 'https://shsbot-production.up.railway.app/api/service-bots';
const DAY_LIMIT = 1000;
const MAX_RANGE_DAYS = 31;

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function addDays(dateStr, delta) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return dt.toISOString().slice(0, 10);
}

function inclusiveDays(start, end) {
    const a = Date.parse(`${start}T00:00:00Z`);
    const b = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return Math.floor((b - a) / 86400000) + 1;
}

function eachDate(start, end) {
    const dates = [];
    let cursor = start;
    while (cursor <= end) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return dates;
}

function sameNick(left, right) {
    const a = String(left || '').trim().toUpperCase();
    const b = String(right || '').trim().toUpperCase();
    return Boolean(a) && a === b;
}

async function shsGet(path, key) {
    const response = await fetch(`${SHS_BASE}${path}`, {
        headers: { 'X-Bot-Key': key },
    });
    if (!response.ok) {
        const error = new Error(`Стрічка бота відповіла помилкою ${response.status}`);
        error.status = response.status === 401 || response.status === 403 ? 502 : 502;
        throw error;
    }
    return response.json();
}

async function mapPool(items, size, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next;
            next += 1;
            out[index] = await fn(items[index], index);
        }
    }
    const workers = Math.min(size, items.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
}

function collectNames(payload, fields) {
    const names = [];
    const seen = new Set();
    const push = (value) => {
        const name = String(value || '').trim();
        const key = name.toUpperCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        names.push(name);
    };
    (payload?.top_traders || []).forEach((row) => push(row?.trader));
    (payload?.items || []).forEach((row) => fields.forEach((field) => push(row?.[field])));
    return names;
}

async function listTraders(key) {
    const end = new Date().toISOString().slice(0, 10);
    const start = addDays(end, -30);
    const query = `start=${start}&end=${end}&limit=200&top_limit=200`;
    const [orders, locates] = await Promise.all([
        shsGet(`/orders?${query}`, key),
        shsGet(`/locates?${query}`, key),
    ]);
    const seen = new Set();
    const traders = [];
    [...collectNames(orders, ['trader', 'login_name', 'real_user']), ...collectNames(locates, ['trader', 'real_user'])].forEach((name) => {
        const nick = name.toUpperCase();
        if (seen.has(nick)) return;
        seen.add(nick);
        traders.push(name);
    });
    traders.sort((a, b) => a.localeCompare(b, 'uk'));
    return traders;
}

async function loadRange(key, trader, start, end) {
    const days = eachDate(start, end);
    let truncated = false;
    const pages = await mapPool(days, 4, async (date) => {
        const query = `date=${date}&limit=${DAY_LIMIT}&top_limit=1`;
        const [orders, locates] = await Promise.all([
            shsGet(`/orders?${query}`, key),
            shsGet(`/locates?${query}`, key),
        ]);
        if ((orders?.items || []).length >= DAY_LIMIT || (locates?.items || []).length >= DAY_LIMIT) truncated = true;
        return {
            orders: (orders?.items || []).filter((row) => sameNick(row?.trader, trader) || sameNick(row?.login_name, trader) || sameNick(row?.real_user, trader)),
            locates: (locates?.items || []).filter((row) => sameNick(row?.trader, trader) || sameNick(row?.real_user, trader)),
        };
    });
    return {
        orders: pages.flatMap((page) => page.orders),
        locates: pages.flatMap((page) => page.locates),
        truncated,
    };
}

export async function handleShsTrades(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { message: 'Method not allowed' });
    try {
        const user = await verifySupabaseUser(req.headers.authorization || req.headers.Authorization);
        if (!user) return sendJson(res, 401, { message: 'Потрібен вхід у журнал' });
        const key = String(process.env.SHS_SERVICE_BOT_KEY || '').trim();
        if (!key) return sendJson(res, 503, { message: 'Ключ бота не налаштований на сайті' });

        const mode = String(req.query?.mode || 'data');
        if (mode === 'traders') {
            const traders = await listTraders(key);
            return sendJson(res, 200, { traders });
        }

        const trader = String(req.query?.trader || '').trim();
        const start = String(req.query?.start || '').trim();
        const end = String(req.query?.end || '').trim();
        if (!trader || trader.length > 64) return sendJson(res, 400, { message: 'Оберіть свій нік' });
        if (!isIsoDate(start) || !isIsoDate(end)) return sendJson(res, 400, { message: 'Невірна дата' });
        const count = inclusiveDays(start, end);
        if (!count || count > MAX_RANGE_DAYS) return sendJson(res, 400, { message: 'За один раз можна взяти не більше місяця' });

        const payload = await loadRange(key, trader, start, end);
        return sendJson(res, 200, payload);
    } catch (error) {
        console.error('[shs-trades]', error?.message || error);
        return sendJson(res, error?.status || 502, { message: 'Не вдалося забрати угоди з бота' });
    }
}
