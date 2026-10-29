export const SILENT_DRIVE_SYNC_TTL_MS = 5 * 60_000;

export function isQuietDriveSyncError(error) {
    const status = Number(error?.status) || 0;
    return ['SOURCE_CONNECTION_REQUIRED', 'AUTH_REQUIRED'].includes(error?.code) || status === 401 || status === 403 || status === 404;
}

export function driveSyncErrorMessage(error) {
    return Number(error?.status) === 401 || error?.code === 'AUTH_REQUIRED'
        ? 'Сесія закінчилась. Увійдіть у свій акаунт повторно.'
        : 'Google Drive: поширте папку на service account email';
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
