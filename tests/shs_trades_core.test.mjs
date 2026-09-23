import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShsDays, buildShsDayMap, dayHasPriorityOverSheet, normalizeShsTicker } from '../js/shs_trades_core.js';
import { mergeGoogleSheetTradesIntoJournal } from '../js/sheet_journal_merge.js';

function order(partial) {
    return {
        status: 'filled',
        is_demo: false,
        ticker: 'BENF.NQ',
        login_name: 'OLEKPONO',
        side: 'short',
        position_effect: 'open',
        filled_size: 100,
        avg_filled_price: 5,
        first_fill_at: '2026-09-23T14:30:00Z',
        ...partial,
    };
}

test('ticker drops the exchange ending', () => {
    assert.equal(normalizeShsTicker('benf.nq'), 'BENF');
});

test('several entries before a close are one added position', () => {
    const days = buildShsDayMap([
        order({ filled_size: 100, avg_filled_price: 5, first_fill_at: '2026-09-23T14:30:00Z' }),
        order({ filled_size: 100, avg_filled_price: 7, first_fill_at: '2026-09-23T14:35:00Z' }),
        order({ position_effect: 'close', side: 'buy', filled_size: 200, avg_filled_price: 4, first_fill_at: '2026-09-23T15:00:00Z' }),
    ], [], 'olekpono');
    const trade = days['2026-09-23'].trades[0];
    assert.equal(days['2026-09-23'].trades.length, 1);
    assert.equal(trade.symbol, 'BENF');
    assert.equal(trade.type, 'Short');
    assert.equal(trade.qty, 200);
    assert.equal(trade.entry, 6);
    assert.equal(trade.exit, 4);
    assert.equal(trade.gross, 400);
    assert.equal(trade.comm, 0);
    assert.equal(trade.opened, '10:30:00');
    assert.equal(trade.closed, '11:00:00');
});

test('a new entry after the position is closed is a second trade', () => {
    const days = buildShsDayMap([
        order({ filled_size: 100, avg_filled_price: 5, first_fill_at: '2026-09-23T14:30:00Z' }),
        order({ position_effect: 'close', side: 'buy', filled_size: 100, avg_filled_price: 4, first_fill_at: '2026-09-23T14:40:00Z' }),
        order({ filled_size: 50, avg_filled_price: 8, first_fill_at: '2026-09-23T15:10:00Z' }),
        order({ position_effect: 'close', side: 'buy', filled_size: 50, avg_filled_price: 9, first_fill_at: '2026-09-23T15:20:00Z' }),
    ], [], 'OLEKPONO');
    assert.equal(days['2026-09-23'].trades.length, 2);
    assert.equal(days['2026-09-23'].trades[1].entry, 8);
    assert.equal(days['2026-09-23'].trades[1].gross, -50);
});

test('a cancelled order that already filled still closes the position', () => {
    const days = buildShsDayMap([
        order({ position_effect: 'open', side: 'short', filled_size: 4756, avg_filled_price: 1.4206, first_fill_at: '2026-09-11T12:11:45.094000+00:00', status: 'filled' }),
        order({ position_effect: 'reduce', side: 'buy', filled_size: 500, avg_filled_price: 1.27, first_fill_at: '2026-09-11T12:43:32.230000+00:00', status: 'cancelled' }),
        order({ position_effect: 'reduce', side: 'buy', filled_size: 2145, avg_filled_price: 1.28, first_fill_at: '2026-09-11T12:46:38.984000+00:00', status: 'filled' }),
        order({ position_effect: 'reduce', side: 'buy', filled_size: 2111, avg_filled_price: 1.3, first_fill_at: '2026-09-11T12:49:33.556000+00:00', status: 'filled' }),
        order({ position_effect: 'close', side: 'buy', filled_size: null, avg_filled_price: null, first_fill_at: null, status: 'cancelled' }),
        order({ position_effect: 'open', side: 'short', filled_size: null, avg_filled_price: null, status: 'submitted', first_fill_at: null }),
    ], [], 'OLEKPONO');
    const trade = days['2026-09-11'].trades[0];
    assert.equal(days['2026-09-11'].trades.length, 1);
    assert.equal(trade.qty, 4756);
    assert.equal(trade.type, 'Short');
    assert.equal(trade.gross, 631.47);
});

test('locate price is the dollar total and declined rows are not added', () => {
    const days = buildShsDayMap([], [
        { trader: 'OLEKPONO', status: 'accepted', ticker: 'MYSE', size: 1000, price: 1.33, date: '2026-09-23' },
        { trader: 'OLEKPONO', status: 'accepted', ticker: 'KIDZ', size: 800, price: 1.06, date: '2026-09-23' },
        { trader: 'OLEKPONO', status: 'declined', ticker: 'ARTL', size: 500, price: 9, date: '2026-09-23' },
        { trader: 'OTHER', status: 'accepted', ticker: 'AAA', size: 100, price: 4, date: '2026-09-23' },
    ], 'OLEKPONO');
    assert.equal(days['2026-09-23'].locates, 2.39);
    assert.equal(days['2026-09-23'].gross, 0);
});

test('PPRO day is left untouched and the bot does not add commission', () => {
    const journal = {
        '2026-09-23': { pproSource: 'ppro-total-report', pnl: 10, trades: [{ symbol: 'KEEP' }] },
    };
    const days = buildShsDayMap([
        order({ filled_size: 10, avg_filled_price: 2, first_fill_at: '2026-09-23T14:30:00Z' }),
        order({ position_effect: 'close', side: 'buy', filled_size: 10, avg_filled_price: 1, first_fill_at: '2026-09-23T14:40:00Z' }),
    ], [{ trader: 'OLEKPONO', status: 'accepted', price: 1.5, date: '2026-09-23', ticker: 'BENF' }], 'OLEKPONO');
    const result = applyShsDays(journal, days, () => { throw new Error('should not create'); });
    assert.deepEqual(result.skippedPpro, ['2026-09-23']);
    assert.equal(journal['2026-09-23'].pnl, 10);
    assert.equal(journal['2026-09-23'].trades[0].symbol, 'KEEP');
});

test('bot day stores locate cost and zero commission', () => {
    const journal = {};
    const days = buildShsDayMap([
        order({ filled_size: 10, avg_filled_price: 3, first_fill_at: '2026-09-23T14:30:00Z' }),
        order({ position_effect: 'close', side: 'buy', filled_size: 10, avg_filled_price: 2, first_fill_at: '2026-09-23T14:45:00Z' }),
    ], [{ trader: 'OLEKPONO', status: 'accepted', price: 1.33, date: '2026-09-23', ticker: 'BENF.NQ' }], 'OLEKPONO');
    applyShsDays(journal, days, () => ({ trades: [], ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] } }));
    const day = journal['2026-09-23'];
    assert.equal(day.fondexxSource, 'shs-bot');
    assert.equal(day.fondexx.comm, 0);
    assert.equal(day.fondexx.locates, 1.33);
    assert.equal(day.gross_pnl, 10);
    assert.equal(day.pnl, 8.67);
    assert.equal(day.commissions, 0);
    assert.equal(day.locates, 1.33);
    assert.equal(dayHasPriorityOverSheet(day), true);
});

test('excel money does not replace a bot day', () => {
    const journal = {
        '2026-09-23': {
            fondexxSource: 'shs-bot',
            fondexx: { gross: 100, net: 100, comm: 0, locates: 2, tickers: ['AAA'] },
            ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            pproSource: '',
            gross_pnl: 100,
            pnl: 98,
            commissions: 0,
            locates: 2,
            trades: [{ symbol: 'AAA', source: 'shs-bot', opened: '10:30:00' }],
        },
    };
    mergeGoogleSheetTradesIntoJournal(journal, {
        '2026-09-23': [{ symbol: 'AAA', opened: '10:30:00', sheet: { sheetNet: 999, source: 'google' } }],
    }, 'sheet-1', {
        syncDayTotals() {},
        markTouched() {},
        warnInvalidDate() {},
    });
    assert.equal(journal['2026-09-23'].gross_pnl, 100);
});
