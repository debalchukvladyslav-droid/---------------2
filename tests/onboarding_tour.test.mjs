import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedTourTarget } from '../js/onboarding.js';

test('a layout frame ignores a tour target that already moved on', () => {
    const highlighted = { isConnected: true };
    const next = { isConnected: true };
    assert.equal(retainedTourTarget(highlighted, highlighted), highlighted);
    assert.equal(retainedTourTarget(null, highlighted), null);
    assert.equal(retainedTourTarget(next, highlighted), null);
    assert.equal(retainedTourTarget({ isConnected: false }, { isConnected: false }), null);
});
