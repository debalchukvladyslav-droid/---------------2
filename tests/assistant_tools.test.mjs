import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers, dispatchTool, ASSISTANT_TOOL_DEFINITIONS } from '../lib/assistant/tools/registry.js';

function createMockDb(rows = []) {
    const calls = [];
    return {
        calls,
        async getTradeById(userId, id) {
            calls.push(['getTradeById', userId, id]);
            return rows.find((row) => row.id === id && row.user_id === userId) || null;
        },
        async getTrades(userId, filters = {}) {
            calls.push(['getTrades', userId, filters]);
            const matched = rows.filter((row) => {
                if (row.user_id !== userId) return false;
                if (filters.from && row.trade_date < filters.from) return false;
                if (filters.to && row.trade_date > filters.to) return false;
                if (filters.ticker && String(row.ticker).toUpperCase() !== String(filters.ticker).toUpperCase()) return false;
                return true;
            });
            const offset = Math.max(0, Number(filters.offset) || 0);
            const limit = Math.min(100, Math.max(1, Number(filters.limit) || 100));
            return matched.slice(offset, offset + limit);
        },
        async getDay(userId, date) {
            calls.push(['getDay', userId, date]);
            if (userId !== 'user-a') return null;
            return {
                trade_date: date,
                pnl: 120,
                notes: 'ok',
                daily_metrics: { errors: ['chase'], trades: [] },
            };
        },
        async getDays() { return []; },
        async getProfileSettings() { return { settings: { defaultDayloss: -140, deposit: 10000 } }; },
        async getCriteriaSnapshot() { return []; },
        async getRecentCoachInsight() { return null; },
    };
}

test('registry exposes eight tools', () => {
    assert.equal(ASSISTANT_TOOL_DEFINITIONS.length, 8);
});

test('tools are scoped to user id and bound trade list length', async () => {
    const rows = [
        { id: 't1', user_id: 'user-a', trade_date: '2026-09-20', ticker: 'AIMD', side: 'short', pnl: 10, setup: 'pump', payload: { opened: '07:10', stop: 5 } },
        { id: 't2', user_id: 'user-b', trade_date: '2026-09-20', ticker: 'AIMD', side: 'short', pnl: 999, setup: 'pump', payload: { opened: '07:10', stop: 5 } },
    ];
    const db = createMockDb(rows);
    const handlers = createToolHandlers({ db, userId: 'user-a' });
    const mine = await dispatchTool(handlers, 'get_trade', { tradeId: 't1' }, {});
    const other = await dispatchTool(handlers, 'get_trade', { tradeId: 't2' }, {});
    assert.equal(mine.found, true);
    assert.equal(other.found, false);

    const many = Array.from({ length: 150 }, (_, i) => ({
        id: `x${i}`,
        user_id: 'user-a',
        trade_date: '2026-09-01',
        ticker: 'AAA',
        side: 'short',
        pnl: 1,
        setup: 'orb',
        payload: { opened: '05:00', stop: 2 },
    }));
    const db2 = createMockDb(many);
    const handlers2 = createToolHandlers({ db: db2, userId: 'user-a' });
    const listed = await dispatchTool(handlers2, 'get_trades', { from: '2026-09-01', to: '2026-09-30', limit: 100 }, {});
    assert.ok(listed.count <= 40);
});

test('get_day uses page context date', async () => {
    const handlers = createToolHandlers({ db: createMockDb([]), userId: 'user-a' });
    const day = await dispatchTool(handlers, 'get_day', {}, { pageContext: { date: '2026-10-02' } });
    assert.equal(day.found, true);
    assert.equal(day.date, '2026-10-02');
    assert.equal(day.ui_hint.type, 'open_day');
});

test('unknown tool returns error object', async () => {
    const handlers = createToolHandlers({ db: createMockDb([]), userId: 'user-a' });
    const result = await dispatchTool(handlers, 'delete_everything', {}, {});
    assert.match(result.error, /unknown_tool/);
});

test('get_trade prefers ticker over unstable index', async () => {
    const rows = [
        { id: 'a', user_id: 'user-a', trade_date: '2026-09-20', ticker: 'AAA', side: 'short', pnl: 1, setup: 'orb', payload: { opened: '05:00', stop: 2 } },
        { id: 'b', user_id: 'user-a', trade_date: '2026-09-20', ticker: 'AIMD', side: 'short', pnl: 2, setup: 'pump', payload: { opened: '06:00', stop: 2 } },
    ];
    const handlers = createToolHandlers({ db: createMockDb(rows), userId: 'user-a' });
    const result = await dispatchTool(handlers, 'get_trade', {}, {
        pageContext: { date: '2026-09-20', tradeKey: { date: '2026-09-20', ticker: 'AIMD', tradeIndex: 0 } },
    });
    assert.equal(result.found, true);
    assert.equal(result.trade.ticker, 'AIMD');
});

test('performance stats paginate beyond 100 trades', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
        id: `p${i}`,
        user_id: 'user-a',
        trade_date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
        ticker: 'AAA',
        side: 'short',
        pnl: i % 2 ? 10 : -5,
        setup: 'orb',
        payload: { opened: '05:00', stop: 2 },
    }));
    const db = createMockDb(many);
    const handlers = createToolHandlers({ db, userId: 'user-a' });
    const stats = await dispatchTool(handlers, 'get_performance_stats', {
        from: '2026-09-01',
        to: '2026-09-30',
    }, {});
    assert.equal(stats.overall.trades, 150);
    assert.ok(db.calls.filter((call) => call[0] === 'getTrades').length >= 2);
});
