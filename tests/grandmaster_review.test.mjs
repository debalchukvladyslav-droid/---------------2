import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newYorkDate } from '../lib/grandmaster_review.js';

test('New York trading date is timezone-safe around UTC rollover', () => {
    assert.equal(newYorkDate(new Date('2026-08-18T02:00:00Z')), '2026-08-17');
});

test('end-of-day cron is authenticated, runs Grandmaster and preserves the AI worker', async () => {
    const cron = await readFile(new URL('../api/cron/sync-google-sheets.js', import.meta.url), 'utf8');
    const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.match(cron, /runGrandmasterDailyReviews/); assert.match(cron, /processNextLearningJob/); assert.match(cron, /Bearer \$\{cronSecret\}/);
    assert.deepEqual(vercel.crons.find((item) => item.path === '/api/cron/end-of-day'), { path: '/api/cron/end-of-day', schedule: '0 15 * * *' });
    assert.ok(vercel.crons.length <= 2); assert.ok(vercel.rewrites.some((item) => item.source === '/api/cron/end-of-day' && /task=end-of-day/.test(item.destination)));
});

test('daily review migration is owner-readable and server-write-only', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20260817193617_rag_grandmaster_memory.sql', import.meta.url), 'utf8');
    assert.match(sql, /create table if not exists public\.daily_reviews/i); assert.match(sql, /enable row level security/i); assert.match(sql, /revoke all on table public\.daily_reviews from public, anon, authenticated/i); assert.match(sql, /grant select on table public\.daily_reviews to authenticated/i); assert.match(sql, /auth\.uid\(\).*user_id/is); assert.match(sql, /match_trade_embeddings/is);
});
