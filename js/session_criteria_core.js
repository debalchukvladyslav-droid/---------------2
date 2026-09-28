function parseIsoDate(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
}

function shiftMonths(date, months) {
    const shifted = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate();
    shifted.setDate(Math.min(date.getDate(), lastDay));
    return shifted;
}

export function sessionCriteriaDateMatches(anchorDateStr, months = 2) {
    const anchor = parseIsoDate(anchorDateStr);
    if (!anchor) return () => false;
    const start = shiftMonths(anchor, -Math.abs(Number(months) || 0));
    return (dateStr) => {
        const date = parseIsoDate(dateStr);
        return !!date && date >= start && date <= anchor;
    };
}

export function pickSessionCriteriaHints(rows = [], count = 2) {
    const limit = Math.max(0, Number(count) || 0);
    const sorted = [...rows]
        .filter((row) => String(row?.criterion ?? '').trim())
        .sort((a, b) => (Number(b.kf) || 0) - (Number(a.kf) || 0));
    if (!limit || !sorted.length) return { strong: [], avoid: [] };
    const strong = sorted.slice(0, limit);
    const avoid = sorted.slice(Math.max(sorted.length - limit, strong.length));
    return { strong, avoid };
}
