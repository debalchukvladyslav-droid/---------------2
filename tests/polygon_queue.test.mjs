import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Polygon queue is global, private and atomically capped at five calls per minute', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20260820122821_polygon_market_low_queue.sql', import.meta.url), 'utf8');
    assert.match(migration, /primary key \(symbol, trade_date\)/i);
    assert.match(migration, /enable row level security/i);
    assert.match(migration, /revoke all.*anon, authenticated/i);
    assert.match(migration, /pg_advisory_xact_lock/i);
    assert.match(migration, /least\(5, max_jobs\)/i);
    assert.match(migration, /attempted_at >= now\(\) - interval '1 minute'/i);
});

test('trade loading and Trades import start a cached Polygon backfill', async () => {
    const [storage, parsers, worker, edge] = await Promise.all([
        readFile(new URL('../js/storage.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/parsers.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/polygon_low_backfill.js', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/functions/market-best-exits/index.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(storage, /startPolygonLowBackfill\(state\.appData\.journal/);
    assert.match(parsers, /startPolygonLowBackfill\(state\.appData\.journal, 'trades-import'\)/);
    assert.match(worker, /INTERVAL_MS = 65000/);
    assert.match(worker, /REQUEST_LIMIT = 5/);
    assert.match(worker, /console\.table/);
    assert.match(edge, /claim_market_low_jobs/);
    assert.match(edge, /console\.log\(`\[Polygon queue\]/);
});
