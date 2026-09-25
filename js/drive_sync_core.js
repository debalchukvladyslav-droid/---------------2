export const SILENT_DRIVE_SYNC_TTL_MS = 60_000;

export function isQuietDriveSyncError(error) {
    const status = Number(error?.status) || 0;
    return error?.code === 'SOURCE_CONNECTION_REQUIRED' || status === 403 || status === 404;
}

export function shouldSkipSilentDriveSync({ silent, lastSuccessfulSyncAt, now = Date.now() } = {}) {
    if (!silent) return false;
    const lastRun = Number(lastSuccessfulSyncAt) || 0;
    const currentTime = Number(now);
    return Number.isFinite(currentTime)
        && lastRun > 0
        && currentTime - lastRun >= 0
        && currentTime - lastRun < SILENT_DRIVE_SYNC_TTL_MS;
}
