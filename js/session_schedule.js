export const TRADING_TIME_ZONE = 'America/New_York';
const SERVER_TIME_CACHE_MS = 5 * 60 * 1000;
let serverOffsetMs = null;
let serverOffsetFetchedAt = 0;
let serverTimeRequest = null;

export async function getTrustedServerNow(options = {}) {
    const localNow = Date.now();
    if (!options.force && serverOffsetMs != null && localNow - serverOffsetFetchedAt < SERVER_TIME_CACHE_MS) {
        return new Date(localNow + serverOffsetMs);
    }
    if (!serverTimeRequest) {
        serverTimeRequest = (async () => {
            const requestStartedAt = Date.now();
            const response = await fetch('/api/server-time', { cache: 'no-store', headers: { accept: 'application/json' } });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !Number.isFinite(Number(payload.epochMs))) throw new Error('Server time unavailable');
            const requestFinishedAt = Date.now();
            const midpoint = requestStartedAt + (requestFinishedAt - requestStartedAt) / 2;
            serverOffsetMs = Number(payload.epochMs) - midpoint;
            serverOffsetFetchedAt = requestFinishedAt;
            return new Date(requestFinishedAt + serverOffsetMs);
        })().finally(() => { serverTimeRequest = null; });
    }
    try {
        return await serverTimeRequest;
    } catch (error) {
        console.warn('[Session review] server time failed; using local fallback', error?.message || error);
        return new Date();
    }
}

export function getZonedClockParts(value = new Date(), timeZone = TRADING_TIME_ZONE) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const read = (type) => Number(parts.find((part) => part.type === type)?.value);
    const hour = read('hour');
    const minute = read('minute');
    return Number.isFinite(hour) && Number.isFinite(minute) ? { hour, minute } : null;
}

export function isEndOfSessionReviewTime(value = new Date()) {
    const clock = getZonedClockParts(value);
    if (!clock) return false;
    const minutes = clock.hour * 60 + clock.minute;
    return minutes >= 9 * 60 + 30 && minutes <= 12 * 60;
}
