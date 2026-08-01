const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Не вдалося прочитати скріншот.'));
        reader.readAsDataURL(blob);
    });
}

function loadBitmap(blob) {
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(blob);
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Формат скріншота не підтримується.')); };
        image.src = url;
    });
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error('Не вдалося стиснути скріншот.')),
        type,
        quality,
    ));
}

export async function prepareImageInlineData(blob, options = {}) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error('Скріншот порожній або недоступний.');
    const maxDimension = options.maxDimension || MAX_IMAGE_DIMENSION;
    const maxBytes = options.maxBytes || MAX_IMAGE_BYTES;
    let output = blob;
    const bitmap = await loadBitmap(blob);
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    if (!width || !height) throw new Error('Не вдалося визначити розмір скріншота.');

    if (blob.size > maxBytes || width > maxDimension || height > maxDimension) {
        const scale = Math.min(1, maxDimension / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let quality = 0.9;
        output = await canvasToBlob(canvas, 'image/jpeg', quality);
        while (output.size > maxBytes && quality > 0.45) {
            quality -= 0.1;
            output = await canvasToBlob(canvas, 'image/jpeg', quality);
        }
    }
    bitmap.close?.();
    if (output.size > maxBytes) throw new Error('Скріншот завеликий для AI навіть після стискання.');
    const dataUrl = await blobToDataUrl(output);
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('Не вдалося підготувати скріншот для AI.');
    return { mimeType: output.type || 'image/jpeg', data: dataUrl.slice(comma + 1) };
}

export async function fetchImageInlineData(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Не вдалося завантажити скріншот (${response.status}).`);
    return prepareImageInlineData(await response.blob());
}
