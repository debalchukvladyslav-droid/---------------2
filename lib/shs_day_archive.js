const TAPE_LIMIT = 200;
const TOP_LIMIT = 80;

export const SHS_ARCHIVE_ENDPOINTS = ['orders', 'locates', 'snapshot', 'summary', 'tickers'];

export function nyClock(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
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

export function archiveSlot(now = new Date()) {
    const { hour, minute } = nyClock(now);
    if (hour === 12 && minute <= 14) return '1200';
    if ((hour === 15 && minute >= 50) || (hour === 16 && minute <= 14)) return '1550';
    return '';
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
