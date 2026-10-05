import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPerformanceStats,
    analyzeSetupPerformance,
    findSimilarTradeRecords,
    groupByTimeBucket,
    performanceAfterFirstLoss,
    normalizeTradeRecord,
} from '../lib/assistant/analysis/performance_engine.js';

function trade(partial) {
    return {
        trade_date: '2026-09-20',
        ticker: 'AIMD',
        side: 'short',
        setup: 'pump-and-dump',
        pnl: 100,
        entry_price: 5,
        exit_price: 4.5,
        payload: { opened: '07:15', stop: 5.4 },
        ...partial,
    };
}

test('performance engine groups by time bucket and setup', () => {
    const stats = buildPerformanceStats([
        trade({ payload: { opened: '05:10', stop: 5.4 }, pnl: 200 }),
        trade({ payload: { opened: '07:20', stop: 5.4 }, pnl: 50 }),
        trade({ payload: { opened: '08:40', stop: 5.4 }, pnl: -120 }),
        trade({ payload: { opened: '08:50', stop: 5.4 }, pnl: -80, setup: 'orb' }),
    ]);
    assert.equal(stats.overall.trades, 4);
    assert.ok(stats.byTimeBucket['04:00-06:00'].trades >= 1);
    assert.ok(stats.byTimeBucket['08:00-09:30'].totalPnl < 0);
    assert.ok(stats.bySetup.some((row) => row.setup === 'pump-and-dump'));
});

test('after first loss summary uses next trade same day', () => {
    const result = performanceAfterFirstLoss([
        normalizeTradeRecord(trade({ payload: { opened: '05:00', stop: 5.4 }, pnl: -50 })),
        normalizeTradeRecord(trade({ payload: { opened: '05:10', stop: 5.4 }, pnl: -90 })),
        normalizeTradeRecord(trade({ trade_date: '2026-09-21', payload: { opened: '05:00', stop: 5.4 }, pnl: 40 })),
        normalizeTradeRecord(trade({ trade_date: '2026-09-21', payload: { opened: '06:00', stop: 5.4 }, pnl: -10 })),
        normalizeTradeRecord(trade({ trade_date: '2026-09-21', payload: { opened: '06:30', stop: 5.4 }, pnl: 20 })),
    ]);
    assert.equal(result.afterFirstLoss.trades, 2);
});

test('analyze_setup marks small samples as observations', () => {
    const analysis = analyzeSetupPerformance([
        trade({ setup: 'liquidity sweep', pnl: 10 }),
        trade({ setup: 'liquidity sweep', pnl: -5 }),
    ], 'liquidity');
    assert.equal(analysis.sampleNote, 'observation_only_n_lt_10');
    assert.equal(analysis.overall.trades, 2);
});

test('find similar trades scores setup and ticker', () => {
    const result = findSimilarTradeRecords([
        trade({ id: '1', ticker: 'AIMD', setup: 'pump-and-dump', pnl: 10 }),
        trade({ id: '2', ticker: 'AIMD', setup: 'pump-and-dump', pnl: -20, trade_date: '2026-09-10' }),
        trade({ id: '3', ticker: 'TSLA', setup: 'orb', pnl: 5 }),
    ], trade({ id: '1' }), { limit: 5 });
    assert.equal(result.matches[0].ticker, 'AIMD');
    assert.ok(result.matches.every((row) => row.id !== '1'));
});

test('groupByTimeBucket ignores not_taken trades', () => {
    const buckets = groupByTimeBucket([
        normalizeTradeRecord(trade({ payload: { opened: '05:00', stop: 5.4, tradeType: 'не брав' }, pnl: 999 })),
        normalizeTradeRecord(trade({ payload: { opened: '05:30', stop: 5.4 }, pnl: 40 })),
    ]);
    assert.equal(buckets['04:00-06:00'].trades, 1);
});
