export const INVALID_IMAGE_FORMAT_MESSAGE = 'Невірний формат, перевірте файли';

export function isJpegOrPng(file) {
    return Boolean(file && (file.type === 'image/jpeg' || file.type === 'image/png'));
}
