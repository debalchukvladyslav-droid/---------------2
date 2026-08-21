import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPolygonResult, readPolygonTimePrice, writePolygonResults, writePolygonTimePrices } from '../js/polygon_result_cache.js';

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

test('Polygon selected-time prices are cached independently for every minute', () => {
    writePolygonTimePrices([{ symbol: 'AAPL', date: '2026-08-19', targetMinute: 600, priceMinute: 600, priceAtTime: 210.5, priceTime: '2026-08-19T14:00:00Z' }]);
    assert.equal(readPolygonTimePrice({ symbol: 'aapl', date: '2026-08-19', targetMinute: 600 })?.priceAtTime, 210.5);
    assert.equal(readPolygonTimePrice({ symbol: 'AAPL', date: '2026-08-19', targetMinute: 601 }), null);
});

test('Polygon selected-time cache rejects a later candle or stop from an old calculation', () => {
    writePolygonTimePrices([{ symbol: 'NIVF', date: '2026-06-16', targetMinute: 570, priceMinute: 625, priceAtTime: 2.1, stopHit: true, stopMinute: 625, stopPrice: 2.2 }]);
    assert.equal(readPolygonTimePrice({ symbol: 'NIVF', date: '2026-06-16', targetMinute: 570, stopPrice: 2.2 }), null);
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
    assert.match(source, /sortedRows\.slice\(0, 3\)/);
    assert.match(source, /sortedRows\.slice\(-3\)/);
    assert.match(source, /bCapture - aCapture/);
    assert.match(source, /best-exit-expand/);
    assert.match(source, /scheduleSilentRefresh/);
    assert.match(source, /REFRESH_WHEN_WAITING_MS = 65000/);
    assert.match(source, /renderSummary\(container, summarizeBestExits\(rows\), after, false\)/);
    assert.match(source, /\[Polygon\] переглядається/);
    assert.match(source, /очікує в черзі або дані недоступні/);
    assert.match(tradesView, /await window\.switchMainTab\('trades'\)/);
    assert.match(tradesView, /findTradeIndexByIdentity/);
});

test('selected exit time never falls forward to a later candle and stale calculations are cancelled', async () => {
    const [source, edge] = await Promise.all([
        readFile(new URL('../js/best_exit_analysis.js', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/functions/market-best-exits/index.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(edge, /target_minute=eq\.\$\{targetMinute\}/);
    assert.doesNotMatch(edge, /for \(let minute = targetMinute; minute <= 720/);
    assert.match(source, /analysisAbortController\?\.abort\(\)/);
    assert.match(source, /JSON\.stringify\(\{ items, targetMinute \}\)/);
    assert.match(source, /signal,/);
});

test('Polygon full charts are archived in private Supabase Storage before calling Polygon again', async () => {
    const [edge, migration] = await Promise.all([
        readFile(new URL('../supabase/functions/market-best-exits/index.ts', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/migrations/20260821143000_polygon_storage_archive.sql', import.meta.url), 'utf8'),
    ]);
    assert.match(migration, /'polygon-cache'.*false/s);
    assert.doesNotMatch(migration, /create policy/i);
    assert.match(edge, /readPolygonArchive\(item\.symbol, item\.date\)/);
    assert.match(edge, /readDatabaseGraph\(item\.symbol, item\.date\)/);
    assert.match(edge, /if \(!marketResults\)/);
    assert.match(edge, /writePolygonArchive\(item\.symbol, item\.date, marketResults\)/);
    assert.match(edge, /source: \$\{marketSource\}/);
});

test('admin can pause Polygon globally and enqueue only Trades missing from the archive', async () => {
    const [edge, admin, view, archiveIndex] = await Promise.all([
        readFile(new URL('../supabase/functions/market-best-exits/index.ts', import.meta.url), 'utf8'),
        readFile(new URL('../js/admin.js', import.meta.url), 'utf8'),
        readFile(new URL('../partials/views/admin-panel.html', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/migrations/20260821151000_polygon_archive_admin_index.sql', import.meta.url), 'utf8'),
    ]);
    assert.match(edge, /body\.action === 'admin-pause'/);
    assert.match(edge, /body\.action === 'admin-enqueue-all'/);
    assert.match(edge, /const missing = \[\.\.\.unique\.entries\(\)\]\.filter/);
    assert.match(edge, /control\.paused \? null : await rest\('rpc\/claim_market_low_jobs'/);
    assert.match(admin, /Зупинити Polygon/);
    assert.match(admin, /Завантажити всі Trades/);
    assert.match(view, /admin-polygon-panel/);
    assert.match(archiveIndex, /revoke all.*public, anon, authenticated/is);
    assert.match(archiveIndex, /grant execute.*service_role/is);
});
