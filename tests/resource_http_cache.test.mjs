import test from 'node:test';
import assert from 'node:assert/strict';
import clientConfig from '../api/service-bots/[endpoint].js';

function response() {
    return { headers: {}, statusCode: 0, body: null,
        setHeader(name,value) { this.headers[name.toLowerCase()] = value; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
}

test('public client config can be served from CDN while server time remains current', async () => {
    const config = response();
    await clientConfig({ method: 'GET', query: { endpoint: 'client-config' } }, config);
    assert.equal(config.statusCode, 200);
    assert.equal(config.headers['vercel-cdn-cache-control'], 'public, max-age=300');
    assert.match(config.body, /^window.TRADING_JOURNAL_CONFIG = /);
    const time = response();
    await clientConfig({ method: 'GET', query: { endpoint: 'client-config', mode: 'server-time' } }, time);
    assert.match(time.headers['cache-control'], /no-store/);
    assert.equal(time.headers['vercel-cdn-cache-control'], undefined);
    assert.ok(Math.abs(time.body.epochMs - Date.now()) < 1000);
});

test('server-time failures have a cooldown with an explicit manual retry', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response('', { status: 503 }); };
    const { getTrustedServerNow } = await import(`../js/session_schedule.js?budget-test=${Date.now()}`);
    assert.ok((await getTrustedServerNow()) instanceof Date);
    await getTrustedServerNow(); await getTrustedServerNow();
    assert.equal(requests, 1);
    globalThis.fetch = async () => { requests++; return Response.json({ epochMs: Date.now() + 3600000 }); };
    const fresh = await getTrustedServerNow({ force: true });
    assert.ok(fresh.getTime() > Date.now() + 3590000);
    await getTrustedServerNow();
    assert.equal(requests, 2);
});
