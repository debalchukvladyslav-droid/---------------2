import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketCriteriaGroups } from '../js/market_criteria_analysis.js';

test('market criteria are bucketed independently from Polygon and ranked by Gross PnL', () => {
    const journal = {
        '2026-08-01': { trades: [
            { symbol: 'AAA', gross: 100, marketCriteria: { atr: .2, shs_float: 4e6, avg_vol: 2e6, vol: 3e6, vol_play: 1.5 } },
            { symbol: 'BBB', gross: -40, marketCriteria: { atr: .4, shs_float: 8e6, avg_vol: 4e6, vol: 7e6, vol_play: 3.5 } },
            { symbol: 'CCC', gross: 50, marketCriteria: { atr: .2, shs_float: 4e6, avg_vol: 2e6, vol: 3e6, vol_play: 1.5 } },
        ] },
    };
    const groups = buildMarketCriteriaGroups(journal, new Set(['2026-08-01']));
    const atr = groups.find((group) => group.key === 'atr');
    assert.equal(atr.buckets[0].label, '<0.3');
    assert.equal(atr.buckets[0].trades, 2);
    assert.equal(atr.buckets[0].pnl, 150);
    assert.equal(atr.buckets[0].profitFactor, Infinity);
    assert.equal(atr.buckets[1].pnl, -40);
});

test('criteria analysis ignores trades without metrics or Gross result', () => {
    const groups = buildMarketCriteriaGroups({ '2026-08-01': { trades: [
        { symbol: 'AAA', gross: 25 },
        { symbol: 'BBB', marketCriteria: { atr: .4 } },
    ] } });
    assert.deepEqual(groups, []);
});

test('exact boundaries move into the next configured criteria range', () => {
    const groups = buildMarketCriteriaGroups({ '2026-08-01': { trades: [{
        symbol: 'EDGE', gross: 10,
        marketCriteria: { atr: .3, shs_float: 1e6, avg_vol: .7e6, vol: .5e6, vol_play: 1 },
    }] } });
    assert.equal(groups.find((group) => group.key === 'atr').buckets[0].label, '0.3–0.5');
    assert.equal(groups.find((group) => group.key === 'shs_float').buckets[0].label, '1–2M');
    assert.equal(groups.find((group) => group.key === 'avg_vol').buckets[0].label, '0.7–1.5M');
    assert.equal(groups.find((group) => group.key === 'vol').buckets[0].label, '0.5–1M');
    assert.equal(groups.find((group) => group.key === 'vol_play').buckets[0].label, '1–3x');
});
