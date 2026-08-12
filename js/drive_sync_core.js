export const SILENT_DRIVE_SYNC_TTL_MS = 60_000;

export function shouldSkipSilentDriveSync({ silent, lastSuccessfulSyncAt, now = Date.now() } = {}) {
    if (!silent) return false;
    const lastRun = Number(lastSuccessfulSyncAt) || 0;
    const currentTime = Number(now);
    return Number.isFinite(currentTime)
        && lastRun > 0
        && currentTime - lastRun >= 0
        && currentTime - lastRun < SILENT_DRIVE_SYNC_TTL_MS;
}
