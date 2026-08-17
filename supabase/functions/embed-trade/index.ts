import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { enumerateTrades } from '../_shared/trade-embedding.js';

const session = new Supabase.ai.Session('gte-small');
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

async function sha256(value: string) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authorization = req.headers.get('Authorization');
    if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Edge environment is incomplete' }, 500);
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401);

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: authorization, apikey: anonKey } });
    if (!userResponse.ok) return json({ error: 'Invalid session' }, 401);
    const user = await userResponse.json();

    let body: { journal_day_ids?: unknown };
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const ids = Array.isArray(body?.journal_day_ids)
        ? [...new Set(body.journal_day_ids.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 20)
        : [];
    if (!ids.length) return json({ error: 'journal_day_ids is required' }, 400);

    const dayQuery = new URL(`${supabaseUrl}/rest/v1/journal_days`);
    dayQuery.searchParams.set('id', `in.(${ids.join(',')})`);
    dayQuery.searchParams.set('user_id', `eq.${user.id}`);
    dayQuery.searchParams.set('select', 'id,user_id,trade_date,notes,daily_metrics');
    const daysResponse = await fetch(dayQuery, { headers: { Authorization: authorization, apikey: anonKey } });
    if (!daysResponse.ok) return json({ error: 'Unable to read journal days' }, 502);
    const days = await daysResponse.json();
    if (!Array.isArray(days) || days.length !== ids.length) return json({ error: 'Journal day not found' }, 404);

    const adminHeaders = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
    let embeddedTrades = 0;
    for (const row of days) {
        const day = { ...(row.daily_metrics || {}), notes: row.notes || '' };
        const records = [];
        for (const item of enumerateTrades(day, row.trade_date)) {
            const tradeKey = await sha256(item.identity);
            const contentHash = await sha256(item.text);
            const rawEmbedding = await session.run(item.text, { mean_pool: true, normalize: true });
            const embedding = Array.from(rawEmbedding as ArrayLike<number>);
            if (embedding.length !== 384) throw new Error(`Unexpected embedding dimensions: ${embedding.length}`);
            records.push({ journal_day_id: row.id, user_id: user.id, trade_key: tradeKey, trade_text: item.text, content_hash: contentHash, embedding, embedding_model: 'Supabase/gte-small', embedded_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        }
        if (records.length) {
            const upsert = await fetch(`${supabaseUrl}/rest/v1/trade_embeddings?on_conflict=journal_day_id,trade_key`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(records) });
            if (!upsert.ok) throw new Error(`Embedding upsert failed: ${await upsert.text()}`);
            embeddedTrades += records.length;
        }
        const staleUrl = new URL(`${supabaseUrl}/rest/v1/trade_embeddings`);
        staleUrl.searchParams.set('journal_day_id', `eq.${row.id}`);
        if (records.length) staleUrl.searchParams.set('trade_key', `not.in.(${records.map((record) => record.trade_key).join(',')})`);
        const stale = await fetch(staleUrl, { method: 'DELETE', headers: adminHeaders });
        if (!stale.ok) throw new Error(`Stale embedding cleanup failed: ${await stale.text()}`);
    }
    return json({ processed_days: days.length, embedded_trades: embeddedTrades });
});
