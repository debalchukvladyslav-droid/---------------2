export const MIN_OCR_SOURCE_WIDTH = 120;
export const MIN_OCR_SOURCE_HEIGHT = 64;

export function isOCRSourceUsable(width, height) {
    const safeWidth = Number(width);
    const safeHeight = Number(height);
    return Number.isFinite(safeWidth)
        && Number.isFinite(safeHeight)
        && safeWidth >= MIN_OCR_SOURCE_WIDTH
        && safeHeight >= MIN_OCR_SOURCE_HEIGHT;
}
