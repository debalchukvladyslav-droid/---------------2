function looksLikeBase64(value) {
    return typeof value === 'string'
        && value.length > 400
        && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

export function summarizeAIPayload(payload) {
    let textChars = 0;
    let imageCount = 0;
    let encodedImageChars = 0;
    const visit = (value, key = '') => {
        if (value == null) return;
        if (typeof value === 'string') {
            if (key === 'data' && looksLikeBase64(value)) {
                imageCount++;
                encodedImageChars += value.length;
            } else {
                textChars += value.length;
            }
            return;
        }
        if (Array.isArray(value)) return value.forEach((item) => visit(item));
        if (typeof value === 'object') Object.entries(value).forEach(([childKey, item]) => visit(item, childKey));
    };
    visit(payload);
    return {
        redacted: true,
        text_chars: textChars,
        image_count: imageCount,
        encoded_image_chars: encodedImageChars,
        content_count: Array.isArray(payload?.contents) ? payload.contents.length : 0,
        has_system_instruction: Boolean(payload?.systemInstruction),
    };
}
