import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { isSupabaseProjectRestricted, SUPABASE_RESTRICTED_MESSAGE } from '../js/supabase_errors.js';
import { loadBootProfile } from '../js/boot_profile.js';

const restriction = { message: 'Service for this project is restricted due to the following violations: exceed_db_size_quota, exceed_egress_quota, exceed_storage_size_quota.' };
const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
const helpers = { isSupabaseProjectRestricted, SUPABASE_RESTRICTED_MESSAGE };

async function loadBrowserModule(name, context, exports) {
    const source = (await readFile(new URL(`../js/${name}.js`, import.meta.url), 'utf8'))
        .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
    vm.runInContext(`${source}\nglobalThis.api = { ${exports} };`, context);
    return context.api;
}

test('recognizes project restrictions even when PostgREST omits the HTTP status', () => {
    for (const error of [restriction, { status: 402 }, { statusCode: '402' }, { code: 'exceed_egress_quota' }]) {
        assert.equal(isSupabaseProjectRestricted(error), true);
    }
    for (const error of [null, { status: 401, message: 'Invalid login credentials' }, { status: 504 }, { code: 'PGRST202' }]) {
        assert.equal(isSupabaseProjectRestricted(error), false);
    }
});

async function authHarness(error, login = 'vlad') {
    const calls = [];
    const errorElement = { innerText: '', style: {} };
    const elements = { 'auth-nick': { value: login }, 'auth-pass': { value: 'test-password' }, 'auth-error': errorElement };
    const context = vm.createContext({
        ...helpers, console: quietConsole, state: { isRegisterMode: false },
        document: { getElementById: id => elements[id] || null },
        supabase: {
            rpc: async name => { calls.push(name); return { error }; },
            from: table => {
                calls.push(table);
                return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: 'vlad@example.com' } }) }) }) };
            },
            auth: { signInWithPassword: async () => { calls.push('signIn'); return { error }; } },
        },
    });
    const api = await loadBrowserModule('auth', context, 'handleAuth');
    return { api, calls, errorElement };
}

test('nickname login stops after a restricted RPC and explains the outage', async () => {
    const h = await authHarness(restriction);
    await h.api.handleAuth();
    assert.deepEqual(h.calls, ['login_email_for_nick']);
    assert.equal(h.errorElement.innerText, SUPABASE_RESTRICTED_MESSAGE);
    assert.equal(h.errorElement.style.display, 'block');
    // A later manual retry is allowed, rather than leaving the form locked.
    await h.api.handleAuth();
    assert.deepEqual(h.calls, ['login_email_for_nick', 'login_email_for_nick']);
});

test('email login also reports a restriction rather than invalid credentials', async () => {
    const h = await authHarness({ status: 402, message: 'Payment Required' }, 'vlad@example.com');
    await h.api.handleAuth();
    assert.deepEqual(h.calls, ['signIn']);
    assert.equal(h.errorElement.innerText, SUPABASE_RESTRICTED_MESSAGE);
});

test('a missing nickname RPC still uses the existing compatibility fallback', async () => {
    const h = await authHarness({ code: 'PGRST202', message: 'Function not found' });
    await h.api.handleAuth();
    assert.deepEqual(h.calls, ['login_email_for_nick', 'profiles', 'signIn']);
});

test('a server outage does not trigger a second lookup or masquerade as invalid credentials', async () => {
    const h = await authHarness({ status: 504, message: 'Gateway timeout' });
    await h.api.handleAuth();
    assert.deepEqual(h.calls,['login_email_for_nick']);
    assert.match(h.errorElement.innerText,/тимчасово недоступний/);
});

test('guest team loading shows the restriction without retrying or rejecting', async () => {
    const calls = [];
    const messages = [];
    const context = vm.createContext({
        ...helpers, console: quietConsole, state: { USER_DOC_NAME: '' },
        document: { getElementById: () => null },
        localStorage: { getItem: () => null },
        showError: message => messages.push(message),
        supabase: {
            auth: { getSession: async () => ({ data: { session: null } }) },
            rpc: async name => { calls.push(name); return { error: restriction }; },
        },
    });
    const api = await loadBrowserModule('teams', context, 'loadTeams');
    await api.loadTeams();
    assert.deepEqual(calls, ['public_team_names']);
    assert.deepEqual(messages, [SUPABASE_RESTRICTED_MESSAGE]);
});

test('profile boot preserves restriction errors and never refreshes a token for them', async () => {
    let reads = 0;
    let refreshes = 0;
    await assert.rejects(loadBootProfile('owner', {
        read: async () => { reads++; return { error: restriction }; },
        refreshSession: async () => { refreshes++; },
        readCached: async () => null, cache: async () => {},
    }), error => error === restriction);
    assert.equal(reads, 1);
    assert.equal(refreshes, 0);
});
