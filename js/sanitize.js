export function sanitizeHTML(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

export function safeExternalUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '#';
    } catch {
        return '#';
    }
}

export function sanitizeRichHTML(html, allowedTags = ['strong', 'em', 'br', 'b', 'i', 'ul', 'li', 'h3', 'h4']) {
    if (typeof DOMParser === 'undefined') return sanitizeHTML(html);

    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const allowed = document.createElement('div');
    allowed.append(...doc.body.childNodes);

    allowed.querySelectorAll('*').forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (!allowedTags.includes(tag)) {
            el.replaceWith(...el.childNodes);
            return;
        }

        [...el.attributes].forEach((attr) => el.removeAttribute(attr.name));
    });

    return allowed.innerHTML;
}
