export const SHEET_MODE_MAIN = 'main';
export const SHEET_MODE_CUMULATIVE = 'cumulative';

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
