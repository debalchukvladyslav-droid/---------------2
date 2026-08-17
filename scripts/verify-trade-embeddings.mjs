import fs from 'node:fs';
import { runGrandmasterDailyReviews } from '../lib/grandmaster_review.js';
import { supabaseRest } from '../lib/google_sheet_sync.js';

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
let multimodalId;
try {
    const multimodal = await request('/rest/v1/trade_multimodal_inputs?select=id', { method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify({ user_id: session.user.id, trade_key: 'integration:MOCK:0', audio_transcript: 'I chased the first breakdown before liquidity confirmation', vision_analysis: JSON.stringify({ setup: 'pump-and-dump', summary: 'Failed support break after a thin-volume spike', volumeEvidence: 'Weak selling volume on break' }), ai_confidence_score: 91 }) });
    multimodalId = multimodal[0].id;
    const inserted = await request('/rest/v1/journal_days?select=id', {
        method: 'POST', headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: session.user.id, trade_date: testDate, notes: 'Temporary embedding integration check', daily_metrics: {
            errors: ['entered before liquidity confirmation'], tickers: { MOCK: { rvol: 540, atr: 1.35 } },
            trades: [{ symbol: 'MOCK', type: 'SHORT', opened: '04:35', closed: '05:12', entry: 7.8, stop: 8.25, exit: 7.2, qty: 100, net: 60, setup: 'pump-and-dump', analysisResult: { multimodalInputId: multimodalId } }],
        } }),
    });
    dayId = inserted[0].id;
    await request(`/rest/v1/trade_multimodal_inputs?id=eq.${multimodalId}`, { method: 'PATCH', headers, body: JSON.stringify({ journal_day_id: dayId }) });
    const result = await request('/functions/v1/embed-trade', { method: 'POST', headers, body: JSON.stringify({ journal_day_ids: [dayId] }) });
    if (result.processed_days !== 1 || result.embedded_trades !== 1) throw new Error(`Unexpected function result: ${JSON.stringify(result)}`);
    await request('/functions/v1/embed-trade', { method: 'POST', headers, body: JSON.stringify({ journal_day_ids: [dayId] }) });
    const rows = await request(`/rest/v1/trade_embeddings?journal_day_id=eq.${dayId}&select=id,embedding,embedding_model,trade_text`, { headers });
    const vector = String(rows[0]?.embedding || '').replace(/^\[|\]$/g, '').split(',').filter(Boolean);
    if (rows.length !== 1 || vector.length !== 384 || rows[0].embedding_model !== 'Supabase/gte-small+multimodal' || !/chased the first breakdown/i.test(rows[0].trade_text) || !/Failed support break/i.test(rows[0].trade_text)) {
        throw new Error(`Embedding verification failed: rows=${rows.length}, dimensions=${vector.length}`);
    }
    const query = await request('/functions/v1/embed-trade', { method: 'POST', headers, body: JSON.stringify({ query_text: 'Why did chasing the failed pump breakdown hurt this short?' }) });
    const matches = await request('/rest/v1/rpc/match_trade_embeddings', { method: 'POST', headers, body: JSON.stringify({ query_embedding: query.embedding, match_count: 20 }) });
    if (query.embedding?.length !== 384 || matches[0]?.id !== rows[0].id) throw new Error('Real pgvector similarity retrieval failed');
    let grandmaster = null;
    if (process.argv.includes('--grandmaster')) {
        grandmaster = await runGrandmasterDailyReviews({ tradeDate: testDate });
        const reviews = await request(`/rest/v1/daily_reviews?trade_date=eq.${testDate}&select=id,status,debrief,evidence`, { headers });
        if (grandmaster.reviewed !== 1 || reviews.length !== 1 || !reviews[0].evidence?.historical_trade_ids?.length) throw new Error(`Grandmaster persistence failed: ${JSON.stringify({ grandmaster, reviews })}`);
        await supabaseRest(`daily_reviews?user_id=eq.${session.user.id}&trade_date=eq.${testDate}`, { method: 'DELETE' });
    }
    console.log(JSON.stringify({ ok: true, processed_days: 1, embedded_trades: 1, dimensions: 384, multimodal_text: true, pgvector_match: true, grandmaster_persisted: grandmaster ? true : undefined, duplicate_rows: 0 }));
} finally {
    if (dayId) await request(`/rest/v1/journal_days?id=eq.${dayId}`, { method: 'DELETE', headers });
    else if (multimodalId) await request(`/rest/v1/trade_multimodal_inputs?id=eq.${multimodalId}`, { method: 'DELETE', headers });
}
