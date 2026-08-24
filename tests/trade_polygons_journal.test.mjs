import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateYahooMetrics, parseFinvizFloat } from '../api/trade-polygons.js';

test('Yahoo daily rows calculate target-inclusive Avg Vol, VolPlay and ATR 14', () => {
    const timestamp = [];
    const high = [];
    const low = [];
    const close = [];
    const volume = [];
    for (let index = 0; index < 15; index++) {
        timestamp.push(Date.UTC(2026, 7, 3 + index, 16) / 1000);
        high.push(11 + index);
        low.push(9 + index);
        close.push(10 + index);
        volume.push(1000 + index * 100);
    }
    const metrics = calculateYahooMetrics({ chart: { result: [{
        timestamp,
        indicators: { quote: [{ high, low, close, volume }] },
    }] } }, '2026-08-17');
    assert.deepEqual(metrics, { atr: 2, avg_vol: 1750, vol: 2400, vol_play: 1.3714 });
});

test('Finviz Shs Float is parsed from its snapshot table', () => {
    assert.deepEqual(
        parseFinvizFloat('<table><tr><td>Shs Float</td><td><b>8.50M</b></td></tr></table>'),
        { shs_float: 8_500_000, shs_float_display: '8.50M' },
    );
});

test('website fetch is manual and RPC writes criteria into journal trade', async () => {
    const [api, migration, storage, view] = await Promise.all([
        readFile(new URL('../api/trade-polygons.js', import.meta.url), 'utf8'),
        readFile(new URL('../supabase/migrations/20260824173000_trade_polygon_journal_metrics.sql', import.meta.url), 'utf8'),
        readFile(new URL('../js/storage.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/trades_view2.js', import.meta.url), 'utf8'),
    ]);
    assert.match(api, /verifySupabaseUser/);
    assert.match(api, /query1\.finance\.yahoo\.com/);
    assert.match(api, /finviz\.com\/quote\.ashx/);
    assert.doesNotMatch(api, /TRADE_POLYGONS_API_KEY/);
    assert.match(migration, /tradePolygons/);
    assert.match(migration, /marketCriteria/);
    assert.match(migration, /REVOKE ALL.*PUBLIC, anon, authenticated/is);
    assert.match(storage, /tradePolygons/);
    assert.match(view, /Критерії паперу/);
    assert.match(view, /fetch\('\/api\/trade-polygons'/);
});
