import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateYahooMetrics, parseFinvizFloat } from '../api/trade-polygons.js';

test('Yahoo criteria use only the completed session before the trade date', () => {
    const timestamp = [];
    const high = [];
    const low = [];
    const close = [];
    const volume = [];
    for (let index = 0; index < 16; index++) {
        timestamp.push(Date.UTC(2026, 7, 3 + index, 16) / 1000);
        high.push(11 + index);
        low.push(9 + index);
        close.push(10 + index);
        volume.push(1000 + index * 100);
    }
    const metrics = calculateYahooMetrics({ chart: { result: [{
        timestamp,
        indicators: { quote: [{ high, low, close, volume }] },
    }] } }, '2026-08-18');
    assert.deepEqual(metrics, {
        atr: 2, avg_vol: 1750, vol: 2400, vol_play: 1.3714,
        as_of_date: '2026-08-17', basis: 'previous-session',
    });
});

test('Finviz Shs Float is parsed from its snapshot table', () => {
    assert.deepEqual(
        parseFinvizFloat('<table><tr><td>Shs Float</td><td><b>8.50M</b></td></tr></table>'),
        { shs_float: 8_500_000, shs_float_display: '8.50M', shs_float_raw: '8.50M' },
    );
    assert.deepEqual(
        parseFinvizFloat('<td class="snapshot-td2"><div class="snapshot-td-label">Shs Float</div></td><td class="snapshot-td2"><div class="snapshot-td-content"><b>7.97M</b></div></td>'),
        { shs_float: 7_970_000, shs_float_display: '7.97M', shs_float_raw: '7.97M' },
    );
});

test('website fetch is manual and RPC writes criteria into journal trade', async () => {
    const [api, migration, fixMigration, storage, view] = await Promise.all([
        readFile(new URL('../api/trade-polygons.js', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/migrations/20260824173000_trade_polygon_journal_metrics.sql', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/migrations/20260824174500_fix_trade_polygon_journal_without_updated_at.sql', import.meta.url), 'utf8'),
        readFile(new URL('../js/storage.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/trades_view2.js', import.meta.url), 'utf8'),
    ]);
    assert.match(api, /verifySupabaseUser/);
    assert.match(api, /query1\.finance\.yahoo\.com/);
    assert.match(api, /finviz\.com\/quote\.ashx/);
    assert.match(api, /Promise\.allSettled/);
    assert.match(api, /partial:/);
    assert.doesNotMatch(api, /TRADE_POLYGONS_API_KEY/);
    assert.match(migration, /tradePolygons/);
    assert.match(migration, /marketCriteria/);
    assert.match(migration, /REVOKE ALL.*PUBLIC, anon, authenticated/is);
    assert.doesNotMatch(fixMigration, /SET daily_metrics[\s\S]*updated_at\s*=/i);
    assert.match(fixMigration, /GRANT EXECUTE.*service_role/i);
    assert.match(storage, /tradePolygons/);
    assert.match(view, /Критерії паперу/);
    assert.match(view, /fetch\('\/api\/trade-polygons'/);
    assert.match(view, /value === null \|\| value === undefined \|\| value === ''/);
    assert.match(view, /shs_float_display \|\| polygonCriteria\.shs_float_raw/);
    assert.match(view, /hasMetric\(polygonCriteria\.atr\)/);
});

test('admin bulk criteria loader is separate from Polygon and skips existing pairs', async () => {
    const admin = await readFile(new URL('../js/admin.js', import.meta.url), 'utf8');
    assert.match(admin, /Завантажити всі критерії/);
    assert.match(admin, /criteriaPairsFromJournal/);
    assert.match(admin, /filter\(\(pair\) => !pair\.loaded\)/);
    assert.match(admin, /fetch\('\/api\/trade-polygons'/);
    assert.match(admin, /data-testing-criteria-host/);
    assert.doesNotMatch(admin.match(/function renderMarketCriteriaAdminPanel[\s\S]*?\n}\n/)?.[0] || '', /market-best-exits|polygon-aggs/);
});
