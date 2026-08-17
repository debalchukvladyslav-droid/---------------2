import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadiness, deriveSessionPhase } from '../js/premarket_command_center_core.js';

test('session phase follows the NY pre-market workflow boundaries', () => {
    assert.equal(deriveSessionPhase({ weekday: 'Mon', hour: 3, minute: 59 }).key, 'prep');
    assert.equal(deriveSessionPhase({ weekday: 'Mon', hour: 4, minute: 0 }).key, 'premarket');
    assert.equal(deriveSessionPhase({ weekday: 'Mon', hour: 9, minute: 30 }).key, 'focus');
    assert.equal(deriveSessionPhase({ weekday: 'Mon', hour: 10, minute: 0 }).key, 'regular');
    assert.equal(deriveSessionPhase({ weekday: 'Sat', hour: 8, minute: 0 }).key, 'weekend');
});

test('readiness requires preparation as well as self-rating', () => {
    const empty = buildReadiness({ sessionReadiness: 10 });
    assert.equal(empty.score, 40);
    assert.equal(empty.tone, 'blocked');
    const ready = buildReadiness({ sessionGoal: 'Only A+', sessionPlan: 'Wait for sweep', sessionSetups: ['Pump fade'], sessionReadiness: 8 });
    assert.equal(ready.score, 92);
    assert.equal(ready.tone, 'ready');
});

test('readiness removes blank setup entries and reports missing plan', () => {
    const result = buildReadiness({ sessionGoal: 'Protect capital', sessionSetups: ['', null, 'ORB'], sessionReadiness: 5 });
    assert.deepEqual(result.setups, ['ORB']);
    assert.match(result.hint, /план/);
});
