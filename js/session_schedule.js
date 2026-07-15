export const TRADING_TIME_ZONE = 'America/New_York';

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
    return minutes >= 9 * 60 + 30;
}
