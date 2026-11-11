const DATA_SYNC_PROTOCOL = 2;
const CACHE = `strum-shell-v10-data-${DATA_SYNC_PROTOCOL}`;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/strum-icon.svg', '/css/1_tokens.css', '/css/2_base.css', '/css/10_mobile.css', '/css/24_phase6.css'];

function isCdnScript(url) {
    return url.origin === 'https://cdn.jsdelivr.net' && /(?:\.js|\/\+esm)$/.test(url.pathname);
}

function isWarmableAsset(url) {
    if (isCdnScript(url)) return true;
    return url.origin === location.origin && (
        /^\/(?:js|lib|css)\/.*\.(?:js|css)$/.test(url.pathname)
        || /^\/partials\/.*\.html$/.test(url.pathname)
        || ['/config.js', '/lw-charts.js'].includes(url.pathname)
    );
}

function assetCacheKey(url) {
    return url.pathname.startsWith('/partials/') ? `${url.origin}${url.pathname}` : url.href;
}

self.addEventListener('message', (event) => {
    if (event.data?.type !== 'strum:cache-assets' || !Array.isArray(event.data.urls)) return;
    if (!event.source?.url || new URL(event.source.url).origin !== location.origin) return;
    const urls = [...new Set(event.data.urls)].slice(0, 500).flatMap((value) => {
        try { const url = new URL(value); return isWarmableAsset(url) ? [url] : []; }
        catch { return []; }
    });
    event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(urls.map(async (url) => {
        const key = assetCacheKey(url);
        if (await cache.match(key)) return;
        const response = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
        if (response.ok) await cache.put(key, response);
    }))));
});

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
        .then(() => self.clients.claim())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((clients) => clients.forEach((client) => client.postMessage({ type: 'strum:data-protocol', version: DATA_SYNC_PROTOCOL }))));
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
    if (url.origin !== location.origin && !(request.destination === 'script' && isCdnScript(url))) return;

    if (request.mode === 'navigate') {
        event.respondWith(fetch(request, { cache: 'no-cache' }).then((response) => {
            if (!response.ok) return response;
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
            return response;
        }).catch(() => caches.match('/index.html')));
        return;
    }

    const isPartial = url.pathname.startsWith('/partials/');
    if (request.destination === 'script' || request.destination === 'style' || isPartial) {
        // Fragments are static. Ignore old timestamp/version query strings when
        // storing them so reopening offline uses the last successful response.
        const cacheKey = isPartial ? assetCacheKey(url) : request;
        event.respondWith(fetch(request, { cache: 'no-cache' }).then((response) => {
            if (response.ok) {
                const copy = response.clone();
                const write = caches.open(CACHE).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
                event.waitUntil(write);
            }
            return response;
        }).catch(async () => {
            const cached = await caches.match(cacheKey)
                || (isPartial ? await caches.match(request, { ignoreSearch: true }) : null);
            return cached || new Response('', { status: 504, statusText: 'Offline' });
        }));
        return;
    }

    event.respondWith(caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
            if (response.ok && ['image', 'manifest'].includes(request.destination)) {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
        }).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
    }));
});
