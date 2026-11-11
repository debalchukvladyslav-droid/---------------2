const PARTIAL_ATTR = 'data-partial';
let partialsPromise = null;

async function doLoadPartials(root = document) {
    const hosts = [
        ...(root?.matches?.(`[${PARTIAL_ATTR}]`) ? [root] : []),
        ...Array.from(root.querySelectorAll?.(`[${PARTIAL_ATTR}]`) || []),
    ];
    if (!hosts.length) return;

    const results = await Promise.allSettled(hosts.map(async (host) => {
        const url = host.getAttribute(PARTIAL_ATTR);
        if (!url) return;

        const version = `v=${encodeURIComponent(window.APP_VERSION || 'dev')}`;
        const path = url.startsWith('/') ? url : `/${url}`;
        const partialUrl = `${path}${path.includes('?') ? '&' : '?'}${version}`;
        const response = await fetch(partialUrl, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Partial ${url}: HTTP ${response.status}`);

        const html = await response.text();
        const template = document.createElement('template');
        template.innerHTML = html.trim();

        // CSP-safe partials: never execute scripts from fetched fragments.
        // Some dev servers inject inline live-reload scripts into HTML responses.
        template.content.querySelectorAll('script').forEach((node) => node.remove());
        template.content.querySelectorAll('*').forEach((el) => {
            for (const attr of Array.from(el.attributes)) {
                if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            }
        });
        host.replaceWith(template.content.cloneNode(true));
    }));
    // Finish every in-flight replacement before a retry inspects the remaining hosts.
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
}

export function loadPartials(root = document) {
    if (root !== document) return doLoadPartials(root);
    if (!partialsPromise) {
        partialsPromise = doLoadPartials(document).catch((error) => {
            partialsPromise = null;
            throw error;
        });
    }
    return partialsPromise;
}
