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

test('no days means no warning', () => {
    const result = advice([]);
    assert.equal(result.level, 'normal');
    assert.equal(result.riskMultiplier, 1);
    assert.equal(result.text, '');
});

test('a quiet green month stays at full risk', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 20000 },
        { date: '2026-09-02', pnl: -400 },
    ]);

    // Відкат 0.4 dayloss від піку — ще без суттєвої просадки.
    assert.equal(result.level, 'normal');
    assert.equal(result.riskMultiplier, 1);
    assert.equal(result.text, '');
});

test('giving back 2 dayloss from equity peak is defensive even if the month stays green', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 20000 },
        { date: '2026-09-02', pnl: -2000 },
    ]);

    assert.equal(result.level, 'defensive');
    assert.equal(result.riskMultiplier, 0.25);
    assert.ok(result.monthPnl > 0);
    assert.ok(result.equityR <= -2);
});

test('month at -0.5 dayloss is caution / 75%', () => {
    const result = advice([
        { date: '2026-09-01', pnl: -500 },
    ]);

    assert.equal(result.level, 'caution');
    assert.equal(result.riskMultiplier, 0.75);
    assert.match(result.text, /Ризик 75%/);
});

test('month at -1 dayloss is reduce / 50%', () => {
    const result = advice([
        { date: '2026-09-01', pnl: -1000 },
    ]);

    assert.equal(result.level, 'reduce');
    assert.equal(result.riskMultiplier, 0.5);
    assert.match(result.text, /Ризик 50%/);
});

test('month at -2 dayloss is defensive / 25%', () => {
    const result = advice([
        { date: '2026-09-01', pnl: -2000 },
    ]);

    assert.equal(result.level, 'defensive');
    assert.equal(result.riskMultiplier, 0.25);
    assert.match(result.text, /Ризик 25%/);
});

test('month at -3 dayloss is pause / 0%', () => {
    const result = advice([
        { date: '2026-09-01', pnl: -3000 },
    ]);

    assert.equal(result.level, 'pause');
    assert.equal(result.riskMultiplier, 0);
    assert.match(result.text, /Ризик 0%/);
});

test('two red months with a nearly flat second month are reduce, not pause', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -1200 },
        { date: '2026-09-02', pnl: -100 },
    ]);

    assert.equal(result.level, 'reduce');
    assert.equal(result.riskMultiplier, 0.5);
    assert.match(result.text, /Ризик 50%/);
    assert.doesNotMatch(result.text, /Пауза/);
    assert.ok(result.prevMonthR <= -1);
    assert.ok(result.monthR > -0.75);
});

test('two meaningfully weak months reach defensive', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -1200 },
        { date: '2026-09-02', pnl: -800 },
    ]);

    assert.equal(result.level, 'defensive');
    assert.equal(result.riskMultiplier, 0.25);
    assert.match(result.text, /Ризик 25%/);
});

test('deep previous month plus deep current month can pause via streak', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -2200 },
        { date: '2026-09-02', pnl: -1600 },
    ]);

    assert.equal(result.level, 'pause');
    assert.equal(result.riskMultiplier, 0);
});

test('equity drawdown of 3 dayloss triggers pause even in a green month path', () => {
    const result = advice([
        { date: '2026-08-01', pnl: 8000 },
        { date: '2026-09-01', pnl: 2000 },
        { date: '2026-09-02', pnl: -3000 },
    ]);

    // Peak 10000 → equity 7000 → pullback 3000 = 3 dayloss
    assert.equal(result.level, 'pause');
    assert.ok(result.equityR <= -3);
    assert.match(result.text, /dayloss/);
});

test('equity drawdown of 1 dayloss is reduce', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 5000 },
        { date: '2026-09-02', pnl: -1000 },
    ]);

    assert.equal(result.level, 'reduce');
    assert.equal(result.riskMultiplier, 0.5);
});

test('risk returns in steps from the local trough, not in one jump', () => {
    const stillDefensive = advice([
        { date: '2026-09-01', pnl: -2500 },
        { date: '2026-09-02', pnl: 500 },
    ]);
    const toReduce = advice([
        { date: '2026-09-01', pnl: -2500 },
        { date: '2026-09-02', pnl: 1000 },
    ]);
    const toCaution = advice([
        { date: '2026-09-01', pnl: -2500 },
        { date: '2026-09-02', pnl: 2000 },
    ]);
    const toNormal = advice([
        { date: '2026-09-01', pnl: -2500 },
        { date: '2026-09-02', pnl: 3000 },
    ]);

    assert.equal(stillDefensive.level, 'defensive');
    assert.equal(toReduce.level, 'reduce');
    assert.equal(toCaution.level, 'caution');
    assert.equal(toNormal.level, 'normal');
});

test('a green month after a red one does not keep pause from the streak alone', () => {
    const result = advice([
        { date: '2026-08-04', pnl: -2200 },
        { date: '2026-09-02', pnl: 4000 },
        { date: '2026-09-03', pnl: -200 },
    ]);

    assert.ok(result.level === 'normal' || result.level === 'caution');
    assert.ok(result.riskMultiplier >= 0.75);
    assert.doesNotMatch(result.text, /Другий місяць у мінусі/);
});

test('strictest of equity, month and streak wins', () => {
    const result = advice([
        { date: '2026-08-01', pnl: 2000 },
        { date: '2026-09-01', pnl: -600 },
    ]);

    // Місяць −0.6 DL → caution; equity від піку 2000→1400 = 0.6 DL → caution.
    assert.equal(result.level, 'caution');
    assert.equal(result.riskMultiplier, 0.75);
    assert.ok(result.equityR <= -0.5);
    assert.ok(result.monthR <= -0.5);
});

test('deposit ratio is reported but dayloss depth drives the level', () => {
    const result = advice([
        { date: '2026-09-01', pnl: 5000 },
        { date: '2026-09-02', pnl: -1000 },
    ], { deposit: 100000 });

    assert.equal(result.level, 'reduce');
    assert.equal(result.accountRatio, 0.01);
});
