/**
 * Values written back into the statistics sheet.
 * Numbers follow the entry-time criteria. Sheet-only fields (previous close,
 * VWAP, post-market and early volume) are derived from the same bars and are
 * not stored as a new criteria version.
 */

import { DEFAULT_VOLUME_SESSION, nyParts, zonedDateTimeToUtcMs } from './massive_criteria.js';

export const POST_VOLUME_SHARES = 1_500_000;
export const EARLY_VOLUME_SHARES = 1_000_000;

export const CRITERIA_COLUMNS = [
    { id: 'volPre', label: 'VolPre(Вхід)' },
    { id: 'shrFloat', label: 'SHRFloat' },
    { id: 'atr', label: 'ATR' },
    { id: 'avgVol', label: 'AVGVol' },
    { id: 'vol', label: 'Vol' },
    { id: 'volPlay', label: 'VolPlay' },
    { id: 'potential', label: 'Потенціал' },
    { id: 'activePost', label: 'Актив Пост' },
    { id: 'activeEarly', label: 'Актив Ранній' },
    { id: 'vwap', label: 'VWAP' },
    { id: 'time', label: 'TIME' },
    { id: 'dayPos', label: 'Day Pos' },
];

const CHECKBOX_FIELDS = new Set(['activePost', 'activeEarly']);

export function shiftIsoDate(iso, days) {
    const [year, month, day] = String(iso || '').split('-').map(Number);
    if (!year || !month || !day) return '';
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return next.toISOString().slice(0, 10);
}

export function isEligibleCriteriaDate(tradeDate, now = Date.now()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tradeDate || ''))) return false;
    const today = nyParts(now).date;
    const yesterday = shiftIsoDate(today, -1);
    return tradeDate < yesterday;
}

export function carrySheetDates(parsedDates = []) {
    let active = null;
    return parsedDates.map((date) => {
        if (date) active = date;
        return active;
    });
}

export function columnIndex(letter) {
    const text = String(letter || '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(text)) return -1;
    let index = 0;
    for (const char of text) index = index * 26 + char.charCodeAt(0) - 64;
    return index - 1;
}

export function columnLetter(index) {
    let value = Number(index) + 1;
    if (!Number.isInteger(value) || value < 1) return '';
    let result = '';
    while (value > 0) {
        value -= 1;
        result = String.fromCharCode(65 + (value % 26)) + result;
        value = Math.floor(value / 26);
    }
    return result;
}

function headerText(value) {
    return String(value ?? '')
        .trim()
        .toLocaleLowerCase('uk-UA')
        .replace(/[\s\n\r\t]+/g, ' ');
}

function columnHeaders(grid, column) {
    return grid.map((row) => headerText(row?.[column])).filter(Boolean);
}

function bestColumn(grid, score) {
    const width = Math.max(0, ...grid.map((row) => (Array.isArray(row) ? row.length : 0)));
    let winner = -1;
    let best = 0;
    for (let column = 0; column < width; column += 1) {
        const value = score(columnHeaders(grid, column), column);
        if (value > best) {
            best = value;
            winner = column;
        }
    }
    return winner >= 0 ? columnLetter(winner) : '';
}

function includesHeader(cells, expected) {
    return cells.includes(expected);
}

export function detectHeaderColumns(grid = []) {
    const rows = Array.isArray(grid) ? grid.slice(0, 12) : [];
    const neighbor = (column, pattern) => {
        for (let offset = -4; offset <= 4; offset += 1) {
            if (!offset) continue;
            if (columnHeaders(rows, column + offset).some((cell) => pattern.test(cell))) return true;
        }
        return false;
    };
    return {
        date: bestColumn(rows, (cells) => (includesHeader(cells, 'дата') ? 5 : 0)),
        ticker: bestColumn(rows, (cells) => (includesHeader(cells, 'ticker') ? 5 : 0)),
        entry: bestColumn(rows, (cells) => (cells.some((cell) => cell.includes('входу') && /ц[іi]на/.test(cell)) ? 5 : 0)),
        volPre: bestColumn(rows, (cells) => (cells.some((cell) => cell.startsWith('volpre')) ? 5 : 0)),
        shrFloat: bestColumn(rows, (cells) => (cells.some((cell) => cell.replace(/\s/g, '') === 'shrfloat') ? 5 : 0)),
        atr: bestColumn(rows, (cells) => (includesHeader(cells, 'atr') ? 5 : 0)),
        avgVol: bestColumn(rows, (cells) => (cells.some((cell) => cell.replace(/\s/g, '') === 'avgvol') ? 5 : 0)),
        vol: bestColumn(rows, (cells) => (includesHeader(cells, 'vol') ? 5 : 0)),
        volPlay: bestColumn(rows, (cells) => (cells.some((cell) => cell.replace(/\s/g, '') === 'volplay') ? 5 : 0)),
        potential: bestColumn(rows, (cells) => (includesHeader(cells, 'потенціал') && !cells.includes('кф') ? 5 : 0)),
        activePost: bestColumn(rows, (cells, column) => {
            if (!cells.some((cell) => cell.replace(/\s/g, '') === 'активпост')) return 0;
            return neighbor(column, /^vwap$|^time$|^day pos$/) ? 8 : 5;
        }),
        activeEarly: bestColumn(rows, (cells, column) => {
            if (!cells.some((cell) => cell.replace(/\s/g, '').startsWith('активран'))) return 0;
            return neighbor(column, /^vwap$|^time$|^day pos$/) ? 8 : 5;
        }),
        vwap: bestColumn(rows, (cells) => {
            if (!includesHeader(cells, 'vwap')) return 0;
            return cells.some((cell) => cell.includes('кф') || cell.includes('kf')) ? 1 : 6;
        }),
        time: bestColumn(rows, (cells) => (includesHeader(cells, 'time') ? 5 : 0)),
        dayPos: bestColumn(rows, (cells) => (cells.some((cell) => cell.replace(/\s/g, '') === 'daypos') ? 5 : 0)),
    };
}

export function toMillions(value, digits = 3) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Number((number / 1e6).toFixed(digits));
}

function roundTo(value, digits) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Number(number.toFixed(digits));
}

export function entryTimeBucket(entryMs) {
    if (!Number.isFinite(entryMs)) return null;
    const hour = nyParts(entryMs).hour;
    if (hour >= 6 && hour <= 9) return `${String(hour).padStart(2, '0')}:00`;
    if (hour >= 4 && hour <= 5) return '4 - 6';
    return null;
}

export function vwapSide(entryPrice, vwap) {
    const entry = Number(entryPrice);
    const level = Number(vwap);
    if (!Number.isFinite(entry) || !Number.isFinite(level) || level <= 0) return null;
    return entry < level ? 'Під' : 'Над';
}

export function dayPositionLabel(entryPrice, high, low) {
    const entry = Number(entryPrice);
    const top = Number(high);
    const bottom = Number(low);
    if (!Number.isFinite(entry) || !Number.isFinite(top) || !Number.isFinite(bottom)) return null;
    const range = top - bottom;
    if (range <= 0) return 'Balance';
    const position = (entry - bottom) / range;
    if (position < 1 / 3) return 'Low';
    if (position < 2 / 3) return 'Balance';
    return 'High';
}

export function activityChoice(postVolume, earlyVolume) {
    if (Number(postVolume) > POST_VOLUME_SHARES) return 'post';
    if (Number(earlyVolume) >= EARLY_VOLUME_SHARES) return 'early';
    return null;
}

function barInstant(bar) {
    const value = Number(bar?.t ?? bar?.time);
    return Number.isFinite(value) ? value : null;
}

function barVolume(bar) {
    const value = Number(bar?.v ?? bar?.volume);
    return Number.isFinite(value) ? value : null;
}

function barPrice(bar) {
    const close = Number(bar?.c ?? bar?.close);
    if (Number.isFinite(close)) return close;
    const high = Number(bar?.h ?? bar?.high);
    const low = Number(bar?.l ?? bar?.low);
    if (Number.isFinite(high) && Number.isFinite(low)) return (high + low) / 2;
    if (Number.isFinite(high)) return high;
    return Number.isFinite(low) ? low : null;
}

function formatPrice(value) {
    if (!Number.isFinite(value)) return null;
    return Number(value >= 1 ? value.toFixed(2) : value.toFixed(4));
}

export function previousSession(dailyBars = [], tradeDate) {
    let best = null;
    dailyBars.forEach((bar) => {
        const instant = barInstant(bar);
        if (instant == null) return;
        const date = nyParts(instant).date;
        if (!date || date >= tradeDate) return;
        const close = Number(bar?.c ?? bar?.close);
        if (!Number.isFinite(close)) return;
        if (!best || date > best.date) best = { date, close };
    });
    return best;
}

function sumVolume(minuteBars, startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    let seen = false;
    let total = 0;
    minuteBars.forEach((bar) => {
        const instant = barInstant(bar);
        const volume = barVolume(bar);
        if (instant == null || volume == null || instant < startMs || instant >= endMs) return;
        seen = true;
        total += volume;
    });
    return seen ? total : null;
}

export function deriveSheetMarket({
    dailyBars = [],
    minuteBars = [],
    tradeDate,
    entryMs,
} = {}) {
    const previous = previousSession(dailyBars, tradeDate);
    const sessionStart = zonedDateTimeToUtcMs(tradeDate, `${DEFAULT_VOLUME_SESSION}:00`);
    const earlyEnd = zonedDateTimeToUtcMs(tradeDate, '07:00:00');
    const postStart = previous ? zonedDateTimeToUtcMs(previous.date, '16:00:00') : null;
    const postEnd = previous ? zonedDateTimeToUtcMs(previous.date, '20:00:00') : null;
    let volumeSum = 0;
    let priceVolume = 0;
    let high = null;
    let low = null;
    minuteBars.forEach((bar) => {
        const instant = barInstant(bar);
        if (instant == null || instant < sessionStart || instant >= entryMs) return;
        const volume = barVolume(bar);
        const price = barPrice(bar);
        if (volume > 0 && price != null) {
            volumeSum += volume;
            priceVolume += price * volume;
        }
        const barHigh = Number(bar?.h ?? bar?.high);
        const barLow = Number(bar?.l ?? bar?.low);
        if (Number.isFinite(barHigh)) high = high == null ? barHigh : Math.max(high, barHigh);
        if (Number.isFinite(barLow)) low = low == null ? barLow : Math.min(low, barLow);
    });
    return {
        previousClose: previous ? previous.close : null,
        vwap: volumeSum > 0 ? priceVolume / volumeSum : null,
        high,
        low,
        postVolume: sumVolume(minuteBars, postStart, postEnd),
        earlyVolume: sumVolume(minuteBars, sessionStart, earlyEnd),
    };
}

export function composeCriteriaValues({
    atr14,
    avgVol14,
    dayVolume,
    volPlay14,
    floatShares,
    entryMs,
    entryPrice,
    previousClose,
    vwap,
    high,
    low,
    postVolume,
    earlyVolume,
} = {}) {
    const activity = activityChoice(postVolume, earlyVolume);
    return {
        volPre: toMillions(dayVolume),
        vol: toMillions(dayVolume),
        volPlay: roundTo(volPlay14, 1),
        atr: roundTo(atr14, 2),
        avgVol: toMillions(avgVol14),
        shrFloat: toMillions(floatShares),
        potential: formatPrice(Number(previousClose)),
        vwap: vwapSide(entryPrice, vwap),
        time: entryTimeBucket(entryMs),
        dayPos: dayPositionLabel(entryPrice, high, low),
        activePost: activity === 'post' ? true : null,
        activeEarly: activity === 'early' ? true : null,
    };
}

export function isBlankCell(value) {
    return value == null || String(value).trim() === '';
}

export function isCheckedCell(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return value === true || text === 'true' || text === '1';
}

function isUncheckedCheckbox(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return value === false || text === 'false' || text === '0';
}

const DROPDOWN_VALUES = {
    vwap: new Set(['Під', 'Над']),
    time: new Set(['06:00', '07:00', '08:00', '09:00', '4 - 6']),
    dayPos: new Set(['Low', 'High', 'Balance']),
};

export function cellCanAccept(value, formula, kind = 'value', field = '') {
    if (formula) return false;
    if (kind === 'checkbox') return !isCheckedCell(value) && (isBlankCell(value) || isUncheckedCheckbox(value));
    const allowed = DROPDOWN_VALUES[field];
    if (allowed) {
        const text = String(value ?? '').trim();
        return text === '' || !allowed.has(text);
    }
    return isBlankCell(value);
}

export function buildCellUpdates({ excelRow, columns = {}, row = [], formulaRow = [], values = {} } = {}) {
    if (!Number.isInteger(excelRow) || excelRow < 1) return [];
    return Object.entries(columns).flatMap(([field, letter]) => {
        const value = values?.[field];
        if (value == null || value === '') return [];
        const index = columnIndex(letter);
        if (index < 0) return [];
        const kind = CHECKBOX_FIELDS.has(field) ? 'checkbox' : 'value';
        if (!cellCanAccept(row?.[index], Boolean(formulaRow?.[index]), kind, field)) return [];
        return [{ range: `${String(letter).toUpperCase()}${excelRow}`, value }];
    });
}

export function selectExportRows(rows = [], { limitEnabled = false, limit = 0 } = {}) {
    const ready = rows.filter((row) => row?.eligible && row?.ticker && row?.date && Number(row.writableCount) > 0);
    if (!limitEnabled) return ready;
    const count = Math.max(0, Math.floor(Number(limit) || 0));
    return ready.slice(0, count);
}
