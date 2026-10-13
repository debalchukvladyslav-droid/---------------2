import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadBootProfile } from '../js/boot_profile.js';

const profile = { nick: 'test', role: 'trader', settings: { account_approved: true } };
const expired = { message: 'JWT expired', code: 'PGRST301' };
const refreshed = { data: { session: { user: { id: 'owner' }, access_token: 'fresh' } } };
const defaults = { readCached: async () => null, cache: async () => {} };

test('boot refreshes an expired JWT and retries the profile read once', async () => {
    let reads = 0;
    let refreshes = 0;
    const result = await loadBootProfile('owner', {
        ...defaults,
        read: async () => ++reads === 1 ? { error: expired } : { data: profile },
        refreshSession: async () => { refreshes++; return refreshed; },
    });
    assert.equal(result.data.nick, 'test');
    assert.equal(reads, 2);
    assert.equal(refreshes, 1);
});

test('boot does not read another account or loop when refresh fails', async () => {
    for (const refreshResult of [
        { data: { session: { user: { id: 'other' } } } },
        { error: { message: 'Refresh token not found', status: 400 } },
    ]) {
        let reads = 0;
        await assert.rejects(loadBootProfile('owner', {
            ...defaults,
            read: async () => { reads++; return { error: expired }; },
            refreshSession: async () => refreshResult,
        }));
        assert.equal(reads, 1);
    }
});

test('boot propagates a repeated 401 and never retries forbidden access', async () => {
    for (const [error, count] of [[expired, 2], [{ status: 403, message: 'Forbidden' }, 1]]) {
        let reads = 0;
        await assert.rejects(loadBootProfile('owner', {
            ...defaults,
            read: async () => { reads++; return { error }; },
            refreshSession: async () => refreshed,
        }));
        assert.equal(reads, count);
    }
});

const source = (await readFile(new URL('../js/authenticated_fetch.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]+\n/gm, '').replace(/^export\s+/gm, '');
function fetchHarness({ nextSession = refreshed, status = 401 } = {}) {
    const requests = [];
    let refreshes = 0;
    const context = vm.createContext({
        supabase: { auth: {
            getSession: async () => ({ data: { session: { access_token: 'expired', user: { id: 'owner' } } } }),
            refreshSession: async () => { refreshes++; return nextSession; },
        } },
        fetch: async (_url, options) => { requests.push(options); return { status: requests.length === 1 ? status : 200 }; },
    });
    vm.runInContext(`${source}\nglobalThis.api = fetchWithSession;`, context);
    return { fetch: context.api, requests, refreshes: () => refreshes };
}

test('authenticated requests retry with the refreshed token and preserve request options', async () => {
    const h = fetchHarness();
    const response = await h.fetch('/api/drive-service', { method: 'POST', body: 'payload', headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 200);
    assert.equal(h.refreshes(), 1);
    assert.equal(h.requests[1].headers.Authorization, 'Bearer fresh');
    assert.equal(h.requests[1].headers['Content-Type'], 'application/json');
    assert.equal(h.requests[1].body, 'payload');
});

test('authenticated requests never retry as a different account or refresh a 403', async () => {
    for (const options of [{ nextSession: { data: { session: { access_token: 'other', user: { id: 'other' } } } } }, { status: 403 }]) {
        const h = fetchHarness(options);
        const response = await h.fetch('/api/drive-service');
        assert.equal(response.status, options.status || 401);
        assert.equal(h.requests.length, 1);
    }
});
