import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolygonStore, isClosedRange } from '../supabase/functions/_shared/polygon_store.js';

function memoryRest() {
    const spans = [];
    const bars = [];
    return {
        spans,
        bars,
        async rest(path, init = {}) {
            if (path.startsWith('polygon_range_fetches?') && (!init.method || init.method === 'GET')) {
                const from = Number(path.match(/range_start=lte\.(-?\d+)/)?.[1]);
                const to = Number(path.match(/range_end=gte\.(-?\d+)/)?.[1]);
                const symbol = decodeURIComponent(path.match(/symbol=eq\.([^&]+)/)?.[1] || '');
                const granularity = path.match(/granularity=eq\.([^&]+)/)?.[1];
                const hit = spans.find((span) => span.symbol === symbol && span.granularity === granularity && span.range_start <= from && span.range_end >= to);
                return { ok: true, json: async () => (hit ? [{ bar_count: hit.bar_count }] : []) };
            }
            if (path.startsWith('rpc/polygon_bars_between')) {
                const body = JSON.parse(init.body);
                const rows = bars
                    .filter((bar) => bar.symbol === body.p_symbol && bar.granularity === body.p_granularity && bar.bar_ms >= body.p_from && bar.bar_ms <= body.p_to)
                    .sort((a, b) => a.bar_ms - b.bar_ms)
                    .map((bar) => ({ t: bar.bar_ms, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume }));
                return { ok: true, json: async () => rows };
            }
            if (path.startsWith('polygon_bars?')) {
                bars.push(...JSON.parse(init.body));
                return { ok: true, json: async () => [] };
            }
            if (path.startsWith('polygon_range_fetches?')) {
                spans.push(JSON.parse(init.body));
                return { ok: true, json: async () => [] };
            }
            return { ok: false, status: 404, json: async () => [] };
        },
    };
}

test('a closed Polygon range is stored once and a narrower request does not need Polygon', async () => {
    const db = memoryRest();
    const store = createPolygonStore({ rest: db.rest });
    const bars = [
        { t: 1_000, o: 10, h: 11, l: 9, c: 10.5, v: 100 },
        { t: 2_000, o: 10.5, h: 12, l: 10, c: 11, v: 80 },
        { t: 2_500, o: 11, h: 11.2, l: 10.8, c: 11.1, v: 40 },
    ];
    const saved = await store.write({
        symbol: 'aapl', granularity: 'minute', rangeStart: 1_000, rangeEnd: 3_000, results: bars, complete: true, now: 5_000,
    });
    assert.equal(saved.stored, true);
    assert.equal(db.bars.length, 3);
    const again = await store.read('AAPL', 'minute', 1_000, 2_000);
    assert.equal(again.hit, true);
    assert.deepEqual(again.results.map((bar) => bar.t), [1_000, 2_000]);
    const outside = await store.read('AAPL', 'minute', 1_000, 4_000);
    assert.equal(outside.hit, false);
});

test('an unfinished session and an incomplete download are not stored', async () => {
    const db = memoryRest();
    const store = createPolygonStore({ rest: db.rest });
    const bar = [{ t: 1_000, o: 1, h: 1, l: 1, c: 1, v: 1 }];
    const open = await store.write({
        symbol: 'AAPL', granularity: 'minute', rangeStart: 1_000, rangeEnd: 9_000, results: bar, complete: true, now: 5_000,
    });
    const partial = await store.write({
        symbol: 'AAPL', granularity: 'minute', rangeStart: 1_000, rangeEnd: 2_000, results: bar, complete: false, now: 5_000,
    });
    assert.equal(open.stored, false);
    assert.equal(partial.stored, false);
    assert.equal(db.spans.length, 0);
    assert.equal(isClosedRange({ granularity: 'day', toDate: '2026-09-24', now: Date.parse('2026-09-25T12:00:00Z') }), true);
    assert.equal(isClosedRange({ granularity: 'day', toDate: '2026-09-25', now: Date.parse('2026-09-25T12:00:00Z') }), false);
});

test('a closed day with no trades is remembered so Polygon is not asked again', async () => {
    const db = memoryRest();
    const store = createPolygonStore({ rest: db.rest });
    const saved = await store.write({
        symbol: 'XYZ', granularity: 'minute', rangeStart: 1_000, rangeEnd: 2_000, results: [], complete: true, now: 5_000,
    });
    assert.equal(saved.stored, true);
    assert.equal(saved.barCount, 0);
    const read = await store.read('XYZ', 'minute', 1_000, 2_000);
    assert.equal(read.hit, true);
    assert.deepEqual(read.results, []);
});
