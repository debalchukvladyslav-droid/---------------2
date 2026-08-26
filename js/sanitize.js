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

/** Render the small Markdown subset used by AI answers, after escaping all source HTML. */
export function renderMarkdown(value) {
    const inline = (source) => sanitizeHTML(source)
        .replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^\n_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^\n*]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^\n_]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');

    const output = [];
    let listOpen = false;
    String(value ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((rawLine) => {
        const list = rawLine.match(/^\s*[-*]\s+(.+)$/);
        if (list) {
            if (!listOpen) { output.push('<ul>'); listOpen = true; }
            output.push(`<li>${inline(list[1])}</li>`);
            return;
        }
        if (listOpen) { output.push('</ul>'); listOpen = false; }
        const heading = rawLine.match(/^\s*(#{2,4})\s+(.+)$/);
        if (heading) output.push(`<${heading[1].length === 2 ? 'h3' : 'h4'}>${inline(heading[2])}</${heading[1].length === 2 ? 'h3' : 'h4'}>`);
        else if (rawLine.trim()) output.push(`${inline(rawLine)}<br>`);
        else output.push('<br>');
    });
    if (listOpen) output.push('</ul>');
    return sanitizeRichHTML(output.join('').replace(/<br>$/, ''));
}
