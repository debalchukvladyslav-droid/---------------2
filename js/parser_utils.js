export function ecnFeeColumnIndex(headers) {
    const keys = ['Ecn Fee', 'ECN Fee', 'ECN', 'Ecn'];
    for (const key of keys) {
        if (headers?.[key] !== undefined) return headers[key];
    }
    return undefined;
}

function toIsoFromParts(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayIsoDate() {
    const now = new Date();
    return toIsoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isValidIsoDateString(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isFutureIsoDateString(iso) {
    return isValidIsoDateString(iso) && iso > todayIsoDate();
}

function calendarYmdValid(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * Date from Sheets/Excel cells.
 * Slash dates are treated as US Excel M/D/YYYY first: 4/1/2026 -> 2026-04-01.
 * Dot dates stay European D.M.YYYY: 1.4.2026 -> 2026-04-01.
 */
export function parseSheetDateCellToIso(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return isValidIsoDateString(s) && !isFutureIsoDateString(s) ? s : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const epoch = Date.UTC(1899, 11, 30);
        const d = new Date(epoch + Math.floor(value) * 86400000);
        const y = d.getUTCFullYear();
        const mo = d.getUTCMonth() + 1;
        const da = d.getUTCDate();
        if (y < 1990 || y > 2100) return null;
        const iso = toIsoFromParts(y, mo, da);
        return isValidIsoDateString(iso) && !isFutureIsoDateString(iso) ? iso : null;
    }

    const datePart = s.split(/\s+/)[0];
    const m = /^(\d{1,2})([./])(\d{1,2})[./](\d{4})$/.exec(datePart);
    if (!m) return null;

    const a = Number(m[1]);
    const separator = m[2];
    const b = Number(m[3]);
    const year = Number(m[4]);
    if (!Number.isFinite(year) || year < 1990 || year > 2100) return null;

    const preferred = separator === '/'
        ? (calendarYmdValid(year, a, b) ? toIsoFromParts(year, a, b) : null)
        : (calendarYmdValid(year, b, a) ? toIsoFromParts(year, b, a) : null);
    const fallback = separator === '/'
        ? (calendarYmdValid(year, b, a) ? toIsoFromParts(year, b, a) : null)
        : (calendarYmdValid(year, a, b) ? toIsoFromParts(year, a, b) : null);

    if (preferred && !isFutureIsoDateString(preferred)) return preferred;
    if (fallback && !isFutureIsoDateString(fallback)) return fallback;
    return null;
}
