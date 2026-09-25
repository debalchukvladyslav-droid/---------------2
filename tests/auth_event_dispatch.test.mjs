import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRestartForAccountSwitch } from '../js/auth_event_dispatch.js';

test('a later sign-in as another account restarts the journal', () => {
    assert.equal(shouldRestartForAccountSwitch('deku', 'deku_d'), true);
    assert.equal(shouldRestartForAccountSwitch('deku_d', 'deku_d'), false);
    assert.equal(shouldRestartForAccountSwitch('deku', ''), false);
    assert.equal(shouldRestartForAccountSwitch('', 'deku_d'), false);
});
