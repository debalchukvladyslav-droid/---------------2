import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const env = Object.fromEntries(fs.readFileSync(new URL('.env.e2e.local', root), 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^(['"])(.*)\1$/, '$2')]; }));
const configText = fs.readFileSync(new URL('config.js', root), 'utf8');
const configValue = (name) => configText.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)`))?.[1] || '';
const base = configValue('supabaseUrl').replace(/\/$/, '');
const anon = configValue('supabaseAnonKey');
const testDate = '2030-12-29';

async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${payload?.error || payload?.message || response.status}`);
    return payload;
}

const publicHeaders = { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' };
const email = await request('/rest/v1/rpc/login_email_for_nick', { method: 'POST', headers: publicHeaders, body: JSON.stringify({ target_nick: env.E2E_TEST_USERNAME }) });
const session = await request('/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: env.E2E_TEST_PASSWORD }) });
const headers = { apikey: anon, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
const existing = await request(`/rest/v1/journal_days?trade_date=eq.${testDate}&select=id`, { headers });
if (existing.length) throw new Error(`Safety stop: test date ${testDate} is already occupied`);

let dayId;
try {
    const inserted = await request('/rest/v1/journal_days?select=id', {
        method: 'POST', headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: session.user.id, trade_date: testDate, notes: 'Temporary embedding integration check', daily_metrics: {
            errors: ['entered before liquidity confirmation'], tickers: { MOCK: { rvol: 540, atr: 1.35 } },
            trades: [{ symbol: 'MOCK', type: 'SHORT', opened: '04:35', closed: '05:12', entry: 7.8, stop: 8.25, exit: 7.2, qty: 100, net: 60, setup: 'pump-and-dump' }],
        } }),
    });
    dayId = inserted[0].id;
    const result = await request('/functions/v1/embed-trade', { method: 'POST', headers, body: JSON.stringify({ journal_day_ids: [dayId] }) });
    if (result.processed_days !== 1 || result.embedded_trades !== 1) throw new Error(`Unexpected function result: ${JSON.stringify(result)}`);
    await request('/functions/v1/embed-trade', { method: 'POST', headers, body: JSON.stringify({ journal_day_ids: [dayId] }) });
    const rows = await request(`/rest/v1/trade_embeddings?journal_day_id=eq.${dayId}&select=id,embedding,embedding_model,trade_text`, { headers });
    const vector = String(rows[0]?.embedding || '').replace(/^\[|\]$/g, '').split(',').filter(Boolean);
    if (rows.length !== 1 || vector.length !== 384 || rows[0].embedding_model !== 'Supabase/gte-small') {
        throw new Error(`Embedding verification failed: rows=${rows.length}, dimensions=${vector.length}`);
    }
    console.log(JSON.stringify({ ok: true, processed_days: 1, embedded_trades: 1, dimensions: 384, duplicate_rows: 0 }));
} finally {
    if (dayId) await request(`/rest/v1/journal_days?id=eq.${dayId}`, { method: 'DELETE', headers });
}
