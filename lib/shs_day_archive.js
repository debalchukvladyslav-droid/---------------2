const TAPE_LIMIT = 200;
const TOP_LIMIT = 80;

export const SHS_ARCHIVE_ENDPOINTS = ['orders', 'locates', 'snapshot', 'summary', 'tickers'];
export const SHS_ARCHIVE_SLOTS = ['1200', '1550', '0900'];

function clockIn(timeZone, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now).map((part) => [part.type, part.value]));
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
    };
}

export function nyClock(now = new Date()) {
    return clockIn('America/New_York', now);
}

export function kyivClock(now = new Date()) {
    return clockIn('Europe/Kyiv', now);
}

function addDays(dateStr, delta) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

export function archiveSlot(now = new Date()) {
    const ny = nyClock(now);
    if (ny.hour === 12 && ny.minute <= 14) return '1200';
    if ((ny.hour === 15 && ny.minute >= 50) || (ny.hour === 16 && ny.minute <= 14)) return '1550';
    const kyiv = kyivClock(now);
    if (kyiv.hour === 9 && kyiv.minute <= 14) return '0900';
    return '';
}

export function archiveTradeDate(now, slot) {
    if (slot === '0900') return addDays(kyivClock(now).date, -1);
    return nyClock(now).date;
}

export function archiveQuery(endpoint, date) {
    return `${endpoint}?date=${date}&limit=${TAPE_LIMIT}&top_limit=${TOP_LIMIT}`;
}

export function archiveFileName(date, slot) {
    return `shs-desk-${date}-${slot}.json`;
}

export function summarizeEndpoint(entry) {
    if (!entry?.ok) return { ok: false, status: Number(entry?.status) || 0 };
    const items = Array.isArray(entry.body?.items) ? entry.body.items.length : null;
    const total = Number(entry.body?.summary?.total);
    const knownTotal = Number.isFinite(total) ? total : null;
    return {
        ok: true,
        items,
        total: knownTotal,
        short: knownTotal != null && items != null && knownTotal > items,
    };
}

export function summarizeArchive(endpoints = {}) {
    return Object.fromEntries(SHS_ARCHIVE_ENDPOINTS.map((name) => [name, summarizeEndpoint(endpoints[name])]));
}
