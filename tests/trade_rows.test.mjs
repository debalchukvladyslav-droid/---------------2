import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ensureTradeIds, journalRowKeepingTrades, journalTradesNeedProjection, journalWithoutTrades, mergePatch, mergeTradeRows, tradeChangeOperations,
} from '../js/data_sync_core.js';

test('one changed trade does not rewrite the day trade list', () => {
    const before = { notes: 'a', daily_metrics: { trades: [{ id: 't1', symbol: 'A', net: 1, version: 3 }, { id: 't2', symbol: 'B', net: 2, version: 1 }] } };
    const next = { notes: 'a', daily_metrics: { trades: [{ id: 't1', symbol: 'A', net: 5, version: 3 }, { id: 't2', symbol: 'B', net: 2, version: 1 }] } };
    assert.deepEqual(mergePatch(journalWithoutTrades(before), journalWithoutTrades(next)), {});
    const ops = tradeChangeOperations('2026-09-25', before.daily_metrics.trades, next.daily_metrics.trades);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].entityId, '2026-09-25:t1');
    assert.equal(ops[0].baseVersion, 3);
    assert.deepEqual(ops[0].patch, { net: 5 });
    assert.equal('version' in ops[0].patch, false);
});

test('removing one trade is a delete of that row', () => {
    const ops = tradeChangeOperations('2026-09-25', [{ id: 't1', symbol: 'A', version: 2 }], []);
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0].patch, { deleted: true });
    assert.equal(ops[0].baseVersion, 2);
});

test('legacy trades without ids stay one projection until the server assigns ids', () => {
    assert.equal(journalTradesNeedProjection([{ symbol: 'A' }]), true);
    assert.equal(journalTradesNeedProjection([{ id: 't1', symbol: 'A' }]), false);
    assert.equal(journalTradesNeedProjection([]), false);
    const [trade] = ensureTradeIds([{ symbol: 'A' }], () => 'generated');
    assert.equal(trade.id, 'generated');
    assert.equal(trade.symbol, 'A');
});

test('a journal pull without trades keeps the trades already on the device', () => {
    const kept = journalRowKeepingTrades(
        { notes: 'updated', daily_metrics: { trades: [], sessionGoal: 'plan' } },
        { notes: 'old', daily_metrics: { trades: [{ id: 't1', symbol: 'NVDA' }] } },
    );
    assert.equal(kept.notes, 'updated');
    assert.equal(kept.daily_metrics.sessionGoal, 'plan');
    assert.equal(kept.daily_metrics.trades[0].symbol, 'NVDA');
});

test('server trade rows replace the embedded list for that day', () => {
    const rows = mergeTradeRows(
        [{ trade_date: '2026-09-25', daily_metrics: { trades: [{ symbol: 'OLD' }], notes: 'x' } }],
        [{ id: 't1', trade_date: '2026-09-25', version: 4, payload: { symbol: 'NVDA', net: 12 } }],
    );
    assert.equal(rows[0].daily_metrics.trades.length, 1);
    assert.equal(rows[0].daily_metrics.trades[0].symbol, 'NVDA');
    assert.equal(rows[0].daily_metrics.trades[0].version, 4);
    assert.equal(rows[0].daily_metrics.notes, 'x');
});
