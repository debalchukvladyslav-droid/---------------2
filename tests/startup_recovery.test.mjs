import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { lazyActions } from '../js/lazy_actions.js';

test('partial retry reloads only failed fragments and uses stable root-relative URLs', async (t) => {
    const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, original));
    const hosts = ['good', 'retry'].map((name) => ({
        getAttribute: () => `partials/${name}.html`,
        replaceWith() { this.loaded = true; },
    }));
    globalThis.document = {
        querySelectorAll: () => hosts.filter((host) => !host.loaded),
        createElement: () => ({ content: { querySelectorAll: () => [], cloneNode: () => ({}) } }),
    };
    globalThis.window = { APP_VERSION: 'test' };
    const urls = [];
    let fail = true;
    globalThis.fetch = async (url) => {
        urls.push(url);
        return new Response('<div>ready</div>', { status: url.includes('retry') && fail ? 503 : 200 });
    };
    const { loadPartials } = await import(`../js/partials.js?retry=${Date.now()}`);
    await assert.rejects(loadPartials(), /503/);
    assert.equal(hosts[0].loaded, true);
    fail = false;
    await loadPartials();
    assert.ok(hosts.every((host) => host.loaded));
    assert.deepEqual(urls, ['/partials/good.html?v=test', '/partials/retry.html?v=test', '/partials/retry.html?v=test']);
});

test('a retry waits for other in-flight partial replacements before starting', async (t) => {
    const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, original));
    let finishSlow;
    const slow = new Promise((resolve) => { finishSlow = resolve; });
    const hosts = ['bad', 'slow'].map((name) => ({ getAttribute: () => `partials/${name}.html`, replaceWith() {} }));
    globalThis.document = { querySelectorAll: () => hosts, createElement: () => ({ content: { querySelectorAll: () => [], cloneNode: () => ({}) } }) };
    globalThis.window = {};
    globalThis.fetch = async (url) => url.includes('slow') ? slow : new Response('', { status: 503 });
    const { loadPartials } = await import(`../js/partials.js?inflight=${Date.now()}`);
    let finished = false;
    const first = loadPartials().catch(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    finishSlow(new Response('<div>ready</div>'));
    await first;
    assert.equal(finished, true);
});

test('offline fragments survive timestamp changes and cache misses return a response', async () => {
    const listeners = {};
    const saved = new Map();
    let online = true;
    const key = (request) => typeof request === 'string' ? request : request.url;
    vm.runInNewContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), {
        URL, Response, location: { origin: 'https://audit.test' },
        self: { addEventListener: (name, handler) => { listeners[name] = handler; } },
        fetch: async () => { if (!online) throw new TypeError('offline'); return new Response('<div>cached</div>'); },
        caches: {
            open: async () => ({ put: async (request, response) => saved.set(key(request), response) }),
            match: async (request, options) => {
                if (!options?.ignoreSearch) return saved.get(key(request))?.clone();
                const match = [...saved].find(([url]) => url.split('?')[0] === key(request).split('?')[0]);
                return match?.[1].clone();
            },
        },
    });
    async function request(path) {
        let response;
        const writes = [];
        listeners.fetch({ request: { url: `https://audit.test${path}`, method: 'GET', destination: '' },
            respondWith: (promise) => { response = promise; }, waitUntil: (promise) => writes.push(promise) });
        const result = await response;
        await Promise.all(writes);
        return result;
    }
    await request('/partials/auth.html?v=dev&t=1');
    await request('/partials/auth.html?v=dev&t=2');
    assert.equal(saved.size, 1);
    online = false;
    assert.equal(await (await request('/partials/auth.html?v=new&t=3')).text(), '<div>cached</div>');
    assert.equal((await request('/partials/missing.html')).status, 504);
    // Existing timestamp-keyed responses from the previous worker remain usable.
    saved.clear();
    saved.set('https://audit.test/partials/auth.html?v=old&t=1', new Response('legacy'));
    assert.equal(await (await request('/partials/auth.html?v=new&t=4')).text(), 'legacy');
});

test('screen actions load once on demand and recover from a failed module request', async () => {
    let calls = 0;
    const actions = lazyActions(async () => {
        calls++;
        if (calls === 1) throw new Error('offline');
        return { open: (value) => value + 1, close: () => 'closed' };
    }, ['open', 'close']);
    assert.equal(calls, 0);
    await assert.rejects(actions.open(1), /offline/);
    assert.deepEqual(await Promise.all([actions.open(2), actions.close()]), [3, 'closed']);
    assert.equal(calls, 2);
});

test('nested app routes resolve all entry scripts and styles at the site root', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const resources = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|ico))"/g)].map((match) => match[1]);
    assert.ok(resources.length > 20);
    for (const resource of resources) {
        if (resource.startsWith('https:')) continue;
        assert.equal(new URL(resource, 'https://audit.test/admin/aggressiveness-backtest').pathname, resource);
    }
});

test('the first controlled visit warms loaded scripts, including CDN modules, but never API data', async () => {
    const listeners = {}, saved = new Map(), fetched = [];
    const key = (request) => typeof request === 'string' ? request : request.url;
    let online = true;
    const cache = {
        match: async (request) => saved.get(key(request))?.clone(),
        put: async (request, response) => saved.set(key(request), response),
    };
    vm.runInNewContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), {
        URL, Response, location: { origin: 'https://audit.test' },
        self: { addEventListener: (name, fn) => { listeners[name] = fn; } },
        caches: { open: async () => cache, match: cache.match },
        fetch: async (url) => { if (!online) throw Error('offline'); fetched.push(url); return new Response('asset'); },
    });
    const urls = ['https://audit.test/js/main.js', 'https://audit.test/partials/auth.html?v=1',
        'https://cdn.jsdelivr.net/npm/example@1/+esm', 'https://audit.test/api/private?token=example',
        'https://other.test/private.js', 'https://audit.test/uploads/private.png'];
    let warm;
    listeners.message({ source: { url: 'https://audit.test/' }, data: { type: 'strum:cache-assets', urls }, waitUntil: (promise) => { warm = promise; } });
    await warm;
    assert.equal(fetched.length, 3);
    assert.ok(fetched.every((url) => !url.includes('private')));
    online = false;
    for (const url of [urls[0], urls[2]]) {
        let result;
        listeners.fetch({ request: { url, method: 'GET', destination: 'script' }, respondWith: (promise) => { result = promise; } });
        assert.equal(await (await result).text(), 'asset');
    }
});

test('PWA sends resources loaded before worker installation to the active worker', async () => {
    const messages = [];
    const source = (await readFile(new URL('../js/pwa.js', import.meta.url), 'utf8')).replaceAll('export function', 'function');
    vm.runInNewContext(`${source}\ninitPwa();`, {
        performance: { getEntriesByType: () => [{ name: 'https://audit.test/js/main.js' }, { name: 'https://audit.test/js/main.js' }] },
        navigator: { serviceWorker: { addEventListener() {}, register: async () => ({ update: async () => {}, active: { postMessage: (message) => messages.push(message) } }) } },
        location: { protocol: 'https:', hostname: 'audit.test' },
        document: { readyState: 'complete', documentElement: { classList: { toggle() {} } } },
        window: { matchMedia: () => ({ matches: false }) }, console,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages[0].type, 'strum:cache-assets');
    assert.deepEqual(Array.from(messages[0].urls), ['https://audit.test/js/main.js']);
});

test('a failed vendor script is removed and the next request retries successfully', async (t) => {
    const original = globalThis.document;
    t.after(() => { globalThis.document = original; });
    const scripts = [];
    globalThis.document = {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, remove() { this.removed = true; } }),
        head: { appendChild: (script) => scripts.push(script) },
    };
    const { loadScriptOnce } = await import(`../js/vendor_loader.js?retry=${Date.now()}`);
    const first = loadScriptOnce('/vendor/example.js');
    scripts[0].onerror();
    await assert.rejects(first, /example.js/);
    assert.equal(scripts[0].removed, true);
    const second = loadScriptOnce('/vendor/example.js');
    assert.equal(scripts.length, 2);
    scripts[1].onload();
    await second;
    await loadScriptOnce('/vendor/example.js');
    assert.equal(scripts.length, 2);
});
