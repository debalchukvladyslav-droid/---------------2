import test from 'node:test';
import assert from 'node:assert/strict';
import {
    advanceReplay,
    collectReplaySessions,
    createReplay,
    cursorAtSessionOpen,
    enterAtMarket,
    jumpToSessionOpen,
    pickReplaySession,
    setEntryPrice,
    setStopPrice,
    summarizeAttempts,
} from '../js/learn_replay_core.js';

function bar(time, open, high, low, close) {
    return { time, open, high, low, close };
}

test('collects one session per ticker-day and keeps journal entries', () => {
    const sessions = collectReplaySessions({
        '2026-03-12': {
            trades: [
                { symbol: 'aaa', type: 'Short', entry: 10, exit: 9, opened: '09:31', net: 100 },
                { symbol: 'AAA', type: 'Short', entry: 11, exit: 12, opened: '10:05', net: -50 },
                { symbol: 'bad symbol', entry: 5 },
            ],
        },
        later: { trades: [{ symbol: 'BBB', entry: 1 }] },
    }, 'Оля');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].symbol, 'AAA');
    assert.equal(sessions[0].owner, 'Оля');
    assert.equal(sessions[0].originals.length, 2);
    assert.equal(sessions[0].originals[0].type, 'short');
});

test('picks a session from the supplied random source', () => {
    const sessions = [
        { symbol: 'AAA', date: '2026-03-12', owner: 'a', originals: [] },
        { symbol: 'BBB', date: '2026-03-13', owner: 'b', originals: [] },
    ];
    assert.equal(pickReplaySession(sessions, () => 0.99).symbol, 'BBB');
    assert.equal(pickReplaySession([], () => 0), null);
});

test('entry click then stop builds a 1:3.7 target for long and short', () => {
    const replay = createReplay([bar(1, 10, 11, 9, 10), bar(2, 10, 11, 9, 10)], { warmup: 1 });
    const armed = setEntryPrice({ ...replay, phase: 'entry' }, 10);
    const long = setStopPrice(armed, 9);
    assert.equal(long.active.side, 'long');
    assert.equal(long.active.take, 13.7);
    const short = setStopPrice(setEntryPrice({ ...replay, phase: 'entry' }, 10), 11);
    assert.equal(short.active.side, 'short');
    assert.equal(short.active.take, 6.3);
    assert.equal(setStopPrice(armed, 10), armed);
});

test('market entry uses the close of the current candle', () => {
    const replay = createReplay([bar(1, 10, 12, 9, 10.5), bar(2, 10, 11, 9, 10)], { warmup: 1 });
    const next = enterAtMarket(replay);
    assert.equal(next.pending.entry, 10.5);
    assert.equal(next.phase, 'stop');
});

test('a later candle resolves take and stop, and a double touch counts as a stop', () => {
    const bars = [
        bar(1, 10, 10.2, 9.8, 10),
        bar(2, 10, 14, 9.9, 13),
        bar(3, 10, 10, 8, 9),
    ];
    const base = createReplay(bars, { warmup: 1 });
    const takeTrade = setStopPrice(setEntryPrice({ ...base, phase: 'entry' }, 10), 9);
    const taken = advanceReplay({ ...takeTrade, status: 'playing' }, 1);
    assert.equal(taken.trades[0].result, 'take');
    assert.equal(taken.trades[0].r, 3.7);
    assert.equal(taken.phase, 'flat');

    const both = setStopPrice(setEntryPrice({ ...createReplay([
        bar(1, 10, 10, 10, 10),
        bar(2, 10, 14, 8, 11),
    ], { warmup: 1 }), phase: 'entry' }, 10), 9);
    const stopped = advanceReplay({ ...both, status: 'playing' }, 5);
    assert.equal(stopped.trades[0].result, 'stop');
    assert.equal(stopped.trades.length, 1);
});

test('the entry candle itself does not close the position', () => {
    const replay = setStopPrice(setEntryPrice({
        ...createReplay([
            bar(1, 10, 14, 8, 10),
            bar(2, 10, 10.2, 9.9, 10),
            bar(3, 10, 10.2, 9.9, 10),
        ], { warmup: 1 }),
        phase: 'entry',
    }, 10), 9);
    const stepped = advanceReplay({ ...replay, status: 'playing' }, 1);
    assert.equal(stepped.cursor, 2);
    assert.equal(stepped.trades.length, 0);
    assert.equal(stepped.active.side, 'long');
});

test('jump to the open resolves orders on skipped candles and pauses again', () => {
    const open = Math.floor(Date.UTC(2026, 0, 5, 14, 30) / 1000);
    const bars = [
        bar(open - 120, 10, 10, 10, 10),
        bar(open - 60, 10, 14, 8, 10),
        bar(open, 10, 10, 10, 10),
        bar(open + 60, 10, 10, 10, 10),
    ];
    assert.equal(cursorAtSessionOpen(bars), 3);
    const replay = setStopPrice(setEntryPrice({
        ...createReplay(bars, { warmup: 1 }),
        phase: 'entry',
    }, 10), 9);
    const jumped = jumpToSessionOpen(replay);
    assert.equal(jumped.cursor, 3);
    assert.equal(jumped.status, 'paused');
    assert.equal(jumped.trades[0].result, 'stop');
});

test('an unfinished position is marked to the last close', () => {
    const replay = setStopPrice(setEntryPrice({
        ...createReplay([bar(1, 10, 10, 10, 10), bar(2, 10, 10.4, 10, 10.2)], { warmup: 1 }),
        phase: 'entry',
    }, 10), 9);
    const done = advanceReplay({ ...replay, status: 'playing' }, 5);
    assert.equal(done.status, 'done');
    assert.equal(done.trades[0].result, 'open');
    assert.ok(Math.abs(done.trades[0].r - 0.2) < 1e-9);
    const summary = summarizeAttempts(done.trades);
    assert.equal(summary.opens, 1);
    assert.equal(summary.attempts, 1);
});
