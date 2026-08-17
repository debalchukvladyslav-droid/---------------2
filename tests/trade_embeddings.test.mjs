import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalTradeText, enumerateTrades, tradeIdentity } from '../supabase/functions/_shared/trade-embedding.js';

test('trade memory text captures premarket short evidence without inventing metrics', () => {
    const text = canonicalTradeText({
        tradeDate: '2026-08-17',
        trade: { symbol: 'xyz', type: 'SHORT', opened: '04:31', entry: 8.42, stop: 8.91, net: -120, setup: 'pump-and-dump', rvol: 520, atr: 1.26 },
        day: { errors: ['early entry'], notes: 'Liquidity was thin.' },
    });
    assert.match(text, /New York pre-market 04:00-09:30 ET/);
    assert.match(text, /Ticker: XYZ/);
    assert.match(text, /Setup: pump-and-dump/);
    assert.match(text, /RVOL: 520/);
    assert.match(text, /ATR: 1.26/);
    assert.match(text, /Mistakes: early entry/);
    assert.doesNotMatch(text, /undefined|null/);
});

test('trade identity is stable and duplicate trades receive distinct occurrences', () => {
    const trade = { symbol: 'ABCD', opened: '05:10', entry: 4.2, type: 'SHORT' };
    assert.equal(tradeIdentity(trade, '2026-08-17'), tradeIdentity({ ...trade }, '2026-08-17'));
    const rows = enumerateTrades({ trades: [trade, { ...trade }] }, '2026-08-17');
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].identity, rows[1].identity);
});

test('trade embedding schema is owner-readable and server-write-only', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20260817190332_trade_embeddings_memory.sql', import.meta.url), 'utf8');
    assert.match(sql, /embedding extensions\.vector\(384\) not null/i);
    assert.match(sql, /references public\.journal_days\(id\) on delete cascade/i);
    assert.match(sql, /using hnsw \(embedding extensions\.vector_cosine_ops\)/i);
    assert.match(sql, /revoke all on table public\.trade_embeddings from public, anon, authenticated/i);
    assert.match(sql, /grant select on table public\.trade_embeddings to authenticated/i);
    assert.match(sql, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
    assert.doesNotMatch(sql, /grant (insert|update|delete)/i);
});

test('embed-trade verifies JWT and builds text and vectors on the server', async () => {
    const source = await readFile(new URL('../supabase/functions/embed-trade/index.ts', import.meta.url), 'utf8');
    assert.match(source, /\/auth\/v1\/user/);
    assert.match(source, /user_id.*eq\.\$\{user\.id\}/s);
    assert.match(source, /enumerateTrades\(day, row\.trade_date\)/);
    assert.match(source, /new Supabase\.ai\.Session\('gte-small'\)/);
    assert.match(source, /embedding\.length !== 384/);
    assert.doesNotMatch(source, /body\.(trade_text|embedding|user_id)/);
});
