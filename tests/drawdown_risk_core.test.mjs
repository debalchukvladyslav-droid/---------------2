import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDrawdownRisk } from '../js/drawdown_risk_core.js';

function advice(days, extra = {}) {
    return assessDrawdownRisk({
        days,
        dayloss: -1000,
        previousDayloss: -1000,
        ...extra,
    });
}

test('10k drawdown on a 100k deposit is 10 percent, not 25', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 5000 },
        { date: '2026-09-02', pnl: -10000 },
    ], { deposit: 100000 });

    assert.equal(result.level, 'cut');
    assert.match(result.text, /10% депозиту/);
    assert.match(result.text, /удвічі/);
    assert.equal(result.accountRatio, 0.1);
});

test('25k drawdown on a 100k deposit is the pause line', () => {
    const result = advice([
        { date: '2026-09-01', pnl: -25000 },
    ], { deposit: 100000 });

    assert.equal(result.level, 'pause');
    assert.match(result.text, /25% депозиту/);
    assert.match(result.text, /Пауза/);
});

test('a green month that keeps most of its profit stays quiet', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 20000 },
        { date: '2026-09-02', pnl: -2000 },
    ]);

    assert.equal(result.level, 'calm');
    assert.equal(result.text, '');
});

test('giving back most of a green month asks to cut risk', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 20000 },
        { date: '2026-09-02', pnl: -15000 },
    ]);

    assert.equal(result.level, 'cut');
    assert.match(result.text, /більшу частину місяця/);
});

test('giving back part of a green month only softens risk', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 20000 },
        { date: '2026-09-02', pnl: -7000 },
    ]);

    assert.equal(result.level, 'soften');
    assert.match(result.text, /Віддаєш прибуток місяця/);
});

test('a red month while trading cuts risk in half', () => {
    const result = advice([
        { date: '2026-08-03', pnl: 4000 },
        { date: '2026-09-01', pnl: -1800 },
    ]);

    assert.equal(result.level, 'cut');
    assert.match(result.text, /Місяць у мінусі/);
});

test('two red months in a row is the hardest monthly warning', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -2200 },
        { date: '2026-09-02', pnl: -300 },
    ]);

    assert.equal(result.level, 'pause');
    assert.match(result.text, /Другий місяць у мінусі/);
});

test('a green month after a red one only asks to keep risk smaller', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -2200 },
        { date: '2026-09-02', pnl: 4000 },
        { date: '2026-09-03', pnl: -200 },
    ]);

    assert.equal(result.level, 'soften');
    assert.match(result.text, /Минулий місяць у мінусі/);
});

test('the deposit brake stays on after a small recovery', () => {
    const result = advice([
        { date: '2026-08-15', pnl: 50000 },
        { date: '2026-08-20', pnl: -12000 },
        { date: '2026-09-02', pnl: 4000 },
        { date: '2026-09-03', pnl: -200 },
    ], { deposit: 100000 });

    assert.equal(result.level, 'cut');
    assert.match(result.text, /депозиту/);
    assert.match(result.text, /удвічі/);
    assert.ok(result.accountRatio < 0.1);
    assert.ok(result.accountRatio >= 0.05);
});

test('risk returns toward normal only after the pullback falls a step', () => {
    const stillCut = advice([
        { date: '2026-08-01', pnl: -12000 },
        { date: '2026-09-02', pnl: 5000 },
    ], { deposit: 100000 });
    const softened = advice([
        { date: '2026-08-01', pnl: -12000 },
        { date: '2026-09-02', pnl: 8000 },
    ], { deposit: 100000 });

    assert.equal(stillCut.level, 'cut');
    assert.equal(softened.level, 'soften');
});

test('a deep brake does not release until the next lower step', () => {
    const held = advice([
        { date: '2026-09-01', pnl: -21000 },
        { date: '2026-09-02', pnl: 5000 },
    ], { deposit: 100000 });
    const released = advice([
        { date: '2026-09-01', pnl: -21000 },
        { date: '2026-09-02', pnl: 7000 },
    ], { deposit: 100000 });

    assert.equal(held.level, 'pause');
    assert.equal(released.level, 'quarter');
});

test('ten percent of the deposit overrides a comfortable green month', () => {
    const result = advice([
        { date: '2026-08-15', pnl: 50000 },
        { date: '2026-08-20', pnl: -10000 },
        { date: '2026-09-02', pnl: 2000 },
        { date: '2026-09-03', pnl: -200 },
    ], { deposit: 100000 });

    assert.equal(result.level, 'cut');
    assert.match(result.text, /депозиту/);
    assert.doesNotMatch(result.text, /прибуток місяця/);
});

test('two red months stay harsher than a small account pullback', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -2200 },
        { date: '2026-09-02', pnl: -800 },
    ], { deposit: 100000 });

    assert.equal(result.level, 'pause');
    assert.match(result.text, /Другий місяць/);
});

test('no days means no warning', () => {
    const result = advice([]);
    assert.equal(result.level, 'calm');
    assert.equal(result.text, '');
});
