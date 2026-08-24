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
    assert.equal(atr.buckets[0].label, 'до 0.30');
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
