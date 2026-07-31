export const SHEET_MODE_MAIN = 'main';
export const SHEET_MODE_CUMULATIVE = 'cumulative';

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function getCumulativeArchiveSchedule(meta = {}, now = new Date()) {
    const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const currentMonth = monthKey(date);
    const synced = String(meta?.month || '') === currentMonth;
    const day = date.getDate();
    return {
        currentMonth,
        synced,
        inRecommendedWindow: day >= 1 && day <= 5,
        overdue: !synced && day > 5,
        day,
    };
}

export function normalizeSheetImportMode(value) {
    return value === SHEET_MODE_CUMULATIVE ? SHEET_MODE_CUMULATIVE : SHEET_MODE_MAIN;
}

export function duplicateSheetMappingConfig(source = {}, target = {}) {
    const src = source && typeof source === 'object' ? source : {};
    const dst = target && typeof target === 'object' ? target : {};
    return {
        ...dst,
        version: Math.max(Number(src.version) || 0, Number(dst.version) || 0, 6),
        savedAt: new Date().toISOString(),
        smartColumns: src.smartColumns && typeof src.smartColumns === 'object' ? { ...src.smartColumns } : {},
        smartAnchors: src.smartAnchors && typeof src.smartAnchors === 'object' ? { ...src.smartAnchors } : {},
        dataStartRow: Number(src.dataStartRow) || Number(dst.dataStartRow) || undefined,
        sheetHeaders: Array.isArray(src.sheetHeaders) ? [...src.sheetHeaders] : [],
    };
}
