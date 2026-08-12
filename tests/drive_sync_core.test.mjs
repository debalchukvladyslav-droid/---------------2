import test from 'node:test';
import assert from 'node:assert/strict';
import { SILENT_DRIVE_SYNC_TTL_MS, shouldSkipSilentDriveSync } from '../js/drive_sync_core.js';

test('silent Drive sync skips work while a recent result is fresh', () => {
    const now = 1_000_000;
    assert.equal(shouldSkipSilentDriveSync({ silent: true, lastSuccessfulSyncAt: now - 1, now }), true);
    assert.equal(shouldSkipSilentDriveSync({
        silent: true,
        lastSuccessfulSyncAt: now - SILENT_DRIVE_SYNC_TTL_MS,
        now,
    }), false);
});

test('manual Drive sync always bypasses the silent cooldown', () => {
    const now = 1_000_000;
    assert.equal(shouldSkipSilentDriveSync({ silent: false, lastSuccessfulSyncAt: now, now }), false);
    assert.equal(shouldSkipSilentDriveSync({ silent: true, lastSuccessfulSyncAt: 0, now }), false);
});
