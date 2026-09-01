const CATEGORY_TYPES = {
    blue: new Set(['синя', 'рпсиня']),
    green: new Set(['зелена', 'рпзелена']),
    purple: new Set(['фіолетова', 'рпфіолетова']),
    visual: new Set(['візуально', 'рпвізуально']),
};

function normalizeTradeType(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/i/g, 'і')
        .replace(/[^a-zа-яіїєґ0-9]+/gi, '');
}

function isNotTakenType(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return normalized.includes('не брав') || normalized.includes('не брала');
}

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

export function resolveMonthlyDayloss(limits = {}, monthKey = '') {
    const exact = parseCumulativeNumber(limits?.[monthKey]);
    if (exact !== null && exact !== 0) return Math.abs(exact);

    const previousKey = Object.keys(limits || {})
        .filter((key) => /^\d{4}-\d{2}$/.test(key) && key < monthKey)
        .sort()
        .reverse()
        .find((key) => {
            const value = parseCumulativeNumber(limits[key]);
            return value !== null && value !== 0;
        });
    if (!previousKey) return null;
    return Math.abs(parseCumulativeNumber(limits[previousKey]));
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

export function calculateCumulativeWeek({ weekStart, journal = {}, rowsByDay = {}, dayloss = null, includeDemo = true } = {}) {
    const range = getWeekRange(weekStart);
    const dateSet = new Set(range.dates);
    const totals = {
        tableProfit: 0,
        metroResult: 0,
        pvResult: 0,
        notTakenResult: 0,
        notTakenKf: 0,
        notTakenKfCount: 0,
        blue: 0,
        green: 0,
        purple: 0,
        visual: 0,
        blueKf: 0,
        greenKf: 0,
        purpleKf: 0,
        visualKf: 0,
        blueKfCount: 0,
        greenKfCount: 0,
        purpleKfCount: 0,
        visualKfCount: 0,
        rowCount: 0,
    };

    range.dates.forEach((dateStr) => {
        const day = journal?.[dateStr] || {};
        if (!includeDemo && day.demoTrading === true) return;
        const hasSummary = day.fondexxSource === 'summary-by-date';
        const hasPpro = day.pproSource === 'ppro-total-report';
        if (hasSummary || hasPpro) {
            const calendarPnl = parseCumulativeNumber(day.pnl);
            if (calendarPnl !== null) {
                totals.metroResult += calendarPnl;
            } else {
                const fondexxNet = hasSummary ? (parseCumulativeNumber(day.fondexx?.net) || 0) : 0;
                const fondexxLocates = hasSummary ? (parseCumulativeNumber(day.fondexx?.locates) || 0) : 0;
                const pproNet = hasPpro ? (parseCumulativeNumber(day.ppro?.net) || 0) : 0;
                totals.metroResult += fondexxNet - fondexxLocates + pproNet;
            }
        }
    });

    Object.entries(rowsByDay || {}).forEach(([dateStr, rows]) => {
        if (!dateSet.has(dateStr) || !Array.isArray(rows)) return;
        if (!includeDemo && journal?.[dateStr]?.demoTrading === true) return;
        rows.forEach((row) => {
            const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
            const pnl = parseCumulativeNumber(sheet.sheetNet ?? row?.net);
            const pv = parseCumulativeNumber(sheet.pv);
            const kf = parseCumulativeNumber(sheet.profitRisk ?? row?.kf);
            const rawType = String(sheet.tradeType ?? row?.type ?? '');
            const type = normalizeTradeType(rawType);
            totals.rowCount += 1;
            if (pnl !== null) totals.tableProfit += pnl;
            if (pv !== null) totals.pvResult += pv;
            if (isNotTakenType(rawType)) {
                if (pv !== null) totals.notTakenResult += pv;
                if (kf !== null) {
                    totals.notTakenKf += kf;
                    totals.notTakenKfCount += 1;
                }
            }
            Object.entries(CATEGORY_TYPES).forEach(([key, types]) => {
                if (!types.has(type)) return;
                if (pnl !== null) totals[key] += pnl;
                if (kf !== null) {
                    totals[`${key}Kf`] += kf;
                    totals[`${key}KfCount`] += 1;
                }
            });
        });
    });

    Object.keys(totals).forEach((key) => {
        if (key !== 'rowCount' && !key.endsWith('Count')) totals[key] = round(totals[key]);
    });
    const limit = Math.abs(parseCumulativeNumber(dayloss) || 0);
    totals.effectiveness = limit ? round(totals.metroResult / (limit * 2.3), 4) : null;
    return { ...range, ...totals, dayloss: limit || null };
}
