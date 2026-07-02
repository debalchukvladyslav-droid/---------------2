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

function normalizeTwoOrFourDigitYear(raw) {
    const text = String(raw || '').trim();
    if (/^\d{2}$/.test(text)) return 2000 + Number(text);
    if (/^\d{4}$/.test(text)) return Number(text);
    return NaN;
}

/**
 * Date from Sheets/Excel cells.
 * Text dates are read as D/M/Y for common trader sheets:
 * 15,05,26 / 15.05.26 / 15/05/26 / 15-05-2026 -> 2026-05-15.
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
    const m = /^(\d{1,2})[.,/-](\d{1,2})[.,/-](\d{2}|\d{4})$/.exec(datePart);
    if (!m) return null;

    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = normalizeTwoOrFourDigitYear(m[3]);
    if (!Number.isFinite(year) || year < 1990 || year > 2100) return null;

    const iso = calendarYmdValid(year, month, day) ? toIsoFromParts(year, month, day) : null;
    if (iso && !isFutureIsoDateString(iso)) return iso;
    return null;
}

export function parsePPROReportDate(value) {
    const s = String(value || '').trim().split(/\s+/)[0];
    if (isValidIsoDateString(s)) return s;

    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (!m) return null;

    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const iso = toIsoFromParts(year, month, day);
    return isValidIsoDateString(iso) ? iso : null;
}

function parseMoney(value) {
    const cleaned = String(value ?? '').replace(/\s/g, '').replace(/[$,]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

function findHeaderIndex(headers, names) {
    const wanted = names.map((name) => String(name).trim().toLowerCase());
    return headers.findIndex((header) => wanted.includes(String(header || '').trim().toLowerCase()));
}

export function parsePPROTotalReportRows(rows, options = {}) {
    const todayIso = options.todayIso || todayIsoDate();
    const headerRow = rows.findIndex((row) => row.some((cell) => String(cell).trim().toLowerCase() === 'date'));
    if (headerRow < 0) throw new Error('Date column not found');

    const headers = rows[headerRow].map((header) => String(header || '').trim());
    const dateIdx = findHeaderIndex(headers, ['Date']);
    const totalIdx = findHeaderIndex(headers, ['Trading Total']);
    if (dateIdx < 0 || totalIdx < 0) throw new Error('Date and Trading Total columns are required');

    const daily = new Map();
    for (const row of rows.slice(headerRow + 1)) {
        const dateStr = parsePPROReportDate(row[dateIdx]);
        if (!dateStr || dateStr > todayIso) continue;

        const net = parseMoney(row[totalIdx]);
        const current = daily.get(dateStr) || 0;
        daily.set(dateStr, current + net);
    }

    return [...daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dateStr, net]) => ({
            dateStr,
            gross: Number(net.toFixed(2)),
            net: Number(net.toFixed(2)),
            comm: 0,
            locates: 0,
            tickers: [],
        }));
}
