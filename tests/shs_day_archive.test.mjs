import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    archiveFileName,
    archiveQuery,
    archiveSlot,
    nyClock,
    summarizeArchive,
} from '../lib/shs_day_archive.js';

test('noon and 15:50 New York are the only archive slots, including both DST offsets', () => {
    assert.equal(archiveSlot(new Date('2026-10-01T16:00:00Z')), '1200');
    assert.equal(nyClock(new Date('2026-10-01T16:00:00Z')).date, '2026-10-01');
    assert.equal(archiveSlot(new Date('2026-10-01T17:00:00Z')), '');
    assert.equal(archiveSlot(new Date('2026-10-01T19:50:00Z')), '1550');
    assert.equal(archiveSlot(new Date('2026-10-01T20:05:00Z')), '1550');
    assert.equal(archiveSlot(new Date('2026-10-01T20:50:00Z')), '');
    assert.equal(archiveSlot(new Date('2026-01-15T16:00:00Z')), '');
    assert.equal(archiveSlot(new Date('2026-01-15T17:00:00Z')), '1200');
    assert.equal(archiveSlot(new Date('2026-01-15T19:50:00Z')), '');
    assert.equal(archiveSlot(new Date('2026-01-15T20:50:00Z')), '1550');
});

test('the archive asks the desk feed for every served endpoint without a trader filter', () => {
    assert.equal(archiveQuery('orders', '2026-10-01'), 'orders?date=2026-10-01&limit=200&top_limit=80');
    assert.equal(archiveQuery('locates', '2026-10-01'), 'locates?date=2026-10-01&limit=200&top_limit=80');
    assert.equal(archiveFileName('2026-10-01', '1550'), 'shs-desk-2026-10-01-1550.json');
    const summary = summarizeArchive({
        orders: { ok: true, body: { items: [{ id: 1 }], summary: { total: 240 } } },
        locates: { ok: true, body: { items: [{ id: 1 }, { id: 2 }], summary: { total: 2 } } },
        snapshot: { ok: false, status: 500 },
    });
    assert.equal(summary.orders.short, true);
    assert.equal(summary.orders.items, 1);
    assert.equal(summary.locates.short, false);
    assert.equal(summary.snapshot.ok, false);
    assert.equal(summary.tickers.ok, false);
});

test('desk archive stays off the two Vercel cron jobs and wakes the existing function', async () => {
    const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    const cron = await readFile(new URL('../api/cron/sync-google-sheets.js', import.meta.url), 'utf8');
    const sql = await readFile(new URL('../supabase/migrations/20261001140000_shs_desk_archive.sql', import.meta.url), 'utf8');
    assert.equal(vercel.crons.length, 2);
    assert.equal(vercel.crons.some((item) => /shs-archive/.test(item.path)), false);
    assert.match(cron, /=== 'shs-archive'/);
    assert.match(cron, /claim_shs_archive_wake/);
    assert.match(cron, /runShsDayArchive/);
    assert.match(sql, /shs-desk-archive-noon-edt/);
    assert.match(sql, /0 16 \* \* 1-5/);
    assert.match(sql, /50 19 \* \* 1-5/);
    assert.match(sql, /50 20 \* \* 1-5/);
    assert.match(sql, /task=shs-archive/);
    assert.match(sql, /revoke all on table public.shs_desk_archives from public, anon, authenticated/);
});
