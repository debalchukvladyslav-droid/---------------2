const PARTIAL_ATTR = 'data-partial';
let partialsPromise = null;

async function doLoadPartials(root = document) {
    const hosts = Array.from(root.querySelectorAll(`[${PARTIAL_ATTR}]`));
    if (!hosts.length) return;

    await Promise.all(hosts.map(async (host) => {
        const url = host.getAttribute(PARTIAL_ATTR);
        if (!url) return;

        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Partial ${url}: HTTP ${response.status}`);

        const html = await response.text();
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        host.replaceWith(template.content.cloneNode(true));
    }));
}

export function loadPartials(root = document) {
    if (root !== document) return doLoadPartials(root);
    if (!partialsPromise) partialsPromise = doLoadPartials(document);
    return partialsPromise;
}
