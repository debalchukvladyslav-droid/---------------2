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

function dateOrdinal(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return NaN;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

function candidateFromParts(year, month, day, mode) {
    const iso = calendarYmdValid(year, month, day) ? toIsoFromParts(year, month, day) : null;
    if (!iso || isFutureIsoDateString(iso)) return null;
    return { iso, mode };
}

function parseSheetDateCellCandidates(value, options = {}) {
    if (value == null || value === '') return [];
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return isValidIsoDateString(s) && !isFutureIsoDateString(s) ? [{ iso: s, mode: 'fixed' }] : [];
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const iso = parseSheetDateCellToIso(value);
        return iso ? [{ iso, mode: 'fixed' }] : [];
    }

    const datePart = s.split(/\s+/)[0];
    const m = /^(\d{1,2})[.,/-](\d{1,2})(?:[.,/-](\d{2}|\d{4}))?$/.exec(datePart);
    if (!m) return [];

    const a = Number(m[1]);
    const b = Number(m[2]);
    const fallbackYear = Number(options.year) || Number(todayIsoDate().slice(0, 4));
    const year = m[3] ? normalizeTwoOrFourDigitYear(m[3]) : fallbackYear;
    if (!Number.isFinite(year) || year < 1990 || year > 2100) return [];

    const candidates = [
        candidateFromParts(year, b, a, 'DMY'),
        candidateFromParts(year, a, b, 'MDY'),
    ].filter(Boolean);
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = candidate.iso;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function scoreDateSequence(isos) {
    const ordinals = isos.map(dateOrdinal).filter(Number.isFinite);
    if (!ordinals.length) return -Infinity;
    let score = ordinals.length * 10;
    for (let i = 1; i < ordinals.length; i++) {
        const diff = ordinals[i] - ordinals[i - 1];
        if (diff === 0) score += 2;
        else if (diff === 1) score += 12;
        else if (diff > 1 && diff <= 7) score += 6;
        else if (diff > 7 && diff <= 31) score += 1;
        else if (diff < 0 && diff >= -7) score -= 2;
        else score -= 6;
    }
    return score;
}

const SHEET_MONTH_MARKERS = new Map([
    ['січень', 1], ['лютий', 2], ['березень', 3], ['квітень', 4],
    ['травень', 5], ['червень', 6], ['липень', 7], ['серпень', 8],
    ['вересень', 9], ['жовтень', 10], ['листопад', 11], ['грудень', 12],
]);

function parseSheetMonthMarker(value, fallbackYear) {
    const normalized = String(value ?? '')
        .trim()
        .toLocaleLowerCase('uk-UA')
        .replace(/\s+/g, ' ');
    const match = /^([\p{L}]+)(?:\s+(\d{4}))?$/u.exec(normalized);
    if (!match) return null;
    const month = SHEET_MONTH_MARKERS.get(match[1]);
    if (!month) return null;
    const year = match[2] ? Number(match[2]) : fallbackYear;
    return Number.isFinite(year) ? { month, year } : null;
}

function contextualNextMonthDates(values, options = {}) {
    const fallbackYear = Number(options.year) || Number(todayIsoDate().slice(0, 4));
    let context = null;
    return values.map((value) => {
        const marker = parseSheetMonthMarker(value, fallbackYear);
        if (marker) {
            const targetMonth = marker.month === 12 ? 1 : marker.month + 1;
            const targetYear = marker.month === 12 ? marker.year + 1 : marker.year;
            context = { month: targetMonth, year: targetYear };
            return null;
        }
        if (!context) return null;
        const dayText = String(value ?? '').trim();
        if (!/^\d{1,2}$/.test(dayText)) return null;
        const day = Number(dayText);
        return calendarYmdValid(context.year, context.month, day)
            ? toIsoFromParts(context.year, context.month, day)
            : null;
    });
}

/**
 * Sequence-aware Sheet/Excel date parser.
 * Uses neighboring rows to decide whether ambiguous 2-part/3-part dates are
 * D/M/Y or M/D/Y. This lets 20.06/21.06 and 06.20/06.21 both become separate
 * June trading days when the column pattern makes that clear.
 */
export function parseSheetDateCellsToIsoSequence(values, options = {}) {
    const candidateRows = values.map((value) => parseSheetDateCellCandidates(value, options));
    const contextualDates = contextualNextMonthDates(values, options);
    const modes = ['DMY', 'MDY'];
    const modeScores = new Map();
    for (const mode of modes) {
        const isos = candidateRows
            .map((candidates) => candidates.find((candidate) => candidate.mode === mode || candidate.mode === 'fixed')?.iso || null)
            .filter(Boolean);
        modeScores.set(mode, scoreDateSequence(isos));
    }
    const preferredMode = (modeScores.get('MDY') > modeScores.get('DMY')) ? 'MDY' : 'DMY';

    return candidateRows.map((candidates, index) => {
        if (!candidates.length) return null;
        return candidates.find((candidate) => candidate.mode === 'fixed')?.iso
            || candidates.find((candidate) => candidate.mode === preferredMode)?.iso
            || candidates[0].iso;
    }).map((parsed, index) => parsed || contextualDates[index] || null);
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
