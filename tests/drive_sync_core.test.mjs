import test from 'node:test';
import assert from 'node:assert/strict';
import { SILENT_DRIVE_SYNC_TTL_MS, isQuietDriveSyncError, shouldSkipSilentDriveSync } from '../js/drive_sync_core.js';

test('silent Drive sync skips work while a recent result is fresh', () => {
    const now = 1_000_000;
    assert.equal(shouldSkipSilentDriveSync({ silent: true, lastSuccessfulSyncAt: now - 1, now }), true);
    assert.equal(shouldSkipSilentDriveSync({
        silent: true,
        lastSuccessfulSyncAt: now - SILENT_DRIVE_SYNC_TTL_MS,
        now,
    }), false);
});

test('a missing Drive connection is a setup state, not a crash', () => {
    assert.equal(isQuietDriveSyncError({ status: 403, code: 'SOURCE_CONNECTION_REQUIRED' }), true);
    assert.equal(isQuietDriveSyncError({ status: 404 }), true);
    assert.equal(isQuietDriveSyncError({ status: 500 }), false);
    assert.equal(isQuietDriveSyncError(new Error('network')), false);
});

test('manual Drive sync always bypasses the silent cooldown', () => {
    const now = 1_000_000;
    assert.equal(shouldSkipSilentDriveSync({ silent: false, lastSuccessfulSyncAt: now, now }), false);
    assert.equal(shouldSkipSilentDriveSync({ silent: true, lastSuccessfulSyncAt: 0, now }), false);
});
