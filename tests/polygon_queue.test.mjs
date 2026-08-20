import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPolygonResult, writePolygonResults } from '../js/polygon_result_cache.js';

test('Polygon results survive reload and are keyed by ticker, date and entry minute', () => {
    const values = new Map();
    globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    writePolygonResults([{ symbol: 'aapl', date: '2026-08-19', entryMinute: 585, low: 211.42, lowTime: '2026-08-19T14:03:00Z' }]);
    const restored = readPolygonResult({ symbol: 'AAPL', date: '2026-08-19', entryMinute: 585 });
    assert.equal(restored.symbol, 'AAPL');
    assert.equal(restored.date, '2026-08-19');
    assert.equal(restored.entryMinute, 585);
    assert.equal(restored.low, 211.42);
    assert.equal(restored.lowTime, '2026-08-19T14:03:00Z');
    assert.equal(typeof restored.savedAt, 'number');
    assert.equal(readPolygonResult({ symbol: 'AAPL', date: '2026-08-19', entryMinute: 586 }), null);
    delete globalThis.localStorage;
});

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
    assert.match(worker, /readPolygonResult\(item\)/);
    assert.match(worker, /writePolygonResults\(rows\)/);
    assert.match(worker, /console\.table/);
    assert.match(worker, /\[Polygon\] переглядається/);
    assert.match(edge, /claim_market_low_jobs/);
    assert.match(edge, /console\.log\(`\[Polygon queue\]/);
});

test('best-exit tickers open their exact journal trade and Polygon logs every ticker', async () => {
    const [source, tradesView] = await Promise.all([
        readFile(new URL('../js/best_exit_analysis.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/trades_view2.js', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /data-best-exit-date/);
    assert.match(source, /data-best-exit-index/);
    assert.match(source, /window\.openTradesAtDayIndex/);
    assert.match(source, /\[Polygon\] переглядається/);
    assert.match(source, /очікує в черзі або дані недоступні/);
    assert.match(tradesView, /await window\.switchMainTab\('trades'\)/);
    assert.match(tradesView, /findTradeIndexByIdentity/);
});
