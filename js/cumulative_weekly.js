const CATEGORY_TYPES = {
    exceptions: new Set(['виключення', 'шортНС', 'РПвиключ']),
    purple: new Set(['фіолетова', 'виключення-фіолетова', 'РПфіолетова']),
    visual: new Set(['виключення візуально', 'візуально', 'РПвізуально']),
};

export function parseCumulativeNumber(value) {
    if (value == null || value === '') return null;
    const cleaned = String(value)
        .trim()
        .replace(/\s/g, '')
        .replace(',', '.')
        .replace(/[$₴€£Rr]/g, '')
        .replace(/[^0-9.+-]/g, '');
    if (!cleaned || ['+', '-', '.', '+.', '-.'].includes(cleaned)) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
}

function isoDate(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function parseIso(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function getWeekStartIso(value = new Date()) {
    const date = value instanceof Date
        ? new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
        : parseIso(value);
    if (!date) return '';
    const weekday = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
    return isoDate(date);
}

export function getWeekRange(weekStart) {
    const monday = parseIso(getWeekStartIso(weekStart));
    if (!monday) return { start: '', end: '', dates: [] };
    const dates = Array.from({ length: 5 }, (_, index) => {
        const date = new Date(monday);
        date.setUTCDate(date.getUTCDate() + index);
        return isoDate(date);
    });
    return { start: dates[0], end: dates[4], dates };
}

export function collectWeekStarts(journal = {}, rowsByDay = {}, currentDate = new Date()) {
    const starts = new Set([getWeekStartIso(currentDate)]);
    [...Object.keys(journal || {}), ...Object.keys(rowsByDay || {})].forEach((dateStr) => {
        const start = getWeekStartIso(dateStr);
        if (start) starts.add(start);
    });
    return [...starts].filter(Boolean).sort().reverse();
}

function round(value, digits = 2) {
    return Number((Number(value) || 0).toFixed(digits));
}

export function calculateCumulativeWeek({ weekStart, journal = {}, rowsByDay = {}, dayloss = null } = {}) {
    const range = getWeekRange(weekStart);
    const dateSet = new Set(range.dates);
    const totals = {
        tableProfit: 0,
        metroResult: 0,
        pvResult: 0,
        notTakenResult: 0,
        exceptions: 0,
        purple: 0,
        visual: 0,
        rowCount: 0,
    };

    range.dates.forEach((dateStr) => {
        const day = journal?.[dateStr] || {};
        if (day.fondexxSource === 'summary-by-date') {
            totals.metroResult += parseCumulativeNumber(day.fondexx?.net) || 0;
        }
        if (day.pproSource === 'ppro-total-report') {
            totals.metroResult += parseCumulativeNumber(day.ppro?.net) || 0;
        }
    });

    Object.entries(rowsByDay || {}).forEach(([dateStr, rows]) => {
        if (!dateSet.has(dateStr) || !Array.isArray(rows)) return;
        rows.forEach((row) => {
            const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
            const pnl = parseCumulativeNumber(sheet.sheetNet ?? row?.net);
            const pv = parseCumulativeNumber(sheet.pv);
            const type = String(sheet.tradeType ?? row?.type ?? '');
            totals.rowCount += 1;
            if (pnl !== null) totals.tableProfit += pnl;
            if (pv !== null) totals.pvResult += pv;
            if (type === 'не брав' && pv !== null) totals.notTakenResult += pv;
            Object.entries(CATEGORY_TYPES).forEach(([key, types]) => {
                if (types.has(type) && pnl !== null) totals[key] += pnl;
            });
        });
    });

    Object.keys(totals).forEach((key) => {
        if (key !== 'rowCount') totals[key] = round(totals[key]);
    });
    const limit = Math.abs(parseCumulativeNumber(dayloss) || 0);
    totals.effectiveness = limit ? round(totals.metroResult / limit, 4) : null;
    return { ...range, ...totals, dayloss: limit || null };
}

