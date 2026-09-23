import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../js/storage.js', import.meta.url), 'utf8'))
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export\s+/gm, '');
function harness(overrides = {}) {
    let handlers;
    const commits = [];
    const state = { myUserId: 'owner', USER_DOC_NAME: 'owner_stats', CURRENT_VIEWED_USER: 'owner_stats', appData: { settings: { theme: 'local' }, journal: {} } };
    const context = vm.createContext({ console, setTimeout, clearTimeout, queueMicrotask, structuredClone,
        navigator: { onLine: true },
        state, cloneData: structuredClone, setDataSyncHandlers: value => { handlers = value; },
        syncError: (message, code) => Object.assign(new Error(message), { code }),
        supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'owner' } } } }), getUser: async () => { throw new Error('Network unavailable'); } } },
        ensureDataSyncMetadata: async () => {}, commitLocalChanges: async (...args) => { commits.push(args); return { pending: 1 }; },
        readCachedValue: async () => null, readCachedDay: async () => null, readDirtyJournalRows: async () => [],
        publishSyncState() {}, notifyDataSync() {}, clearStatsCache() {},
        ...overrides,
    });
    vm.runInContext(`${source}\nglobalThis.audit = { saveSettings, loadSettings, markJournalDayDirty };`, context);
    return { state, handlers, commits, api: context.audit };
}

test('settings commit offline without a getUser network request', async () => {
    const { api, commits } = harness();
    await api.saveSettings();
    assert.equal(commits.length, 1);
    assert.equal(commits[0][0], 'owner');
    assert.equal(commits[0][1][0].value.theme, 'local');
});

test('settings guard blocks a partial runtime from clearing several populated collections', async () => {
    const previous = { tickers: { A: 1 }, screenMeta: { shot: {} }, cumulativeSheetRows: { row: {} } };
    const { api, commits } = harness({ readCachedValue: async () => ({ value: previous }) });
    await assert.rejects(api.saveSettings(), { code: 'DATA_LOSS_GUARD' });
    assert.equal(commits.length, 0);
});

test('a summary-only journal day cannot be marked dirty', () => {
    const { api, state } = harness();
    state.appData.journal['2026-09-22'] = { pnl: 10, trades: [], __detailsLoaded: false };
    assert.equal(api.markJournalDayDirty('2026-09-22'), false);
});

test('incoming sync cannot overwrite an in-flight settings edit or dirty journal day', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const { api, state, handlers } = harness({ ensureDataSyncMetadata: () => barrier });
    const pending = api.saveSettings();
    state.appData.journal['2026-09-22'] = { notes: 'not yet committed' };
    api.markJournalDayDirty('2026-09-22');
    await handlers.onChange('owner', [
        { domain: 'settings', record: { value: { theme: 'remote' } } },
        { domain: 'journal', entityId: '2026-09-22', deleted: true },
    ]);
    assert.equal(state.appData.settings.theme, 'local');
    assert.equal(state.appData.journal['2026-09-22'].notes, 'not yet committed');
    release(); await pending;
});

test('late settings load is discarded after an account switch', async () => {
    let release;
    const response = new Promise(resolve => { release = resolve; });
    const { api, state } = harness({ supabase: { auth: { getSession: () => response } } });
    const loading = api.loadSettings();
    state.myUserId = 'other'; state.appData.settings = { theme: 'other-local' };
    release({ data: { session: { user: { id: 'owner' } } } });
    await loading;
    assert.equal(state.appData.settings.theme, 'other-local');
});

test('cached settings load even when navigator reports online during network loss', async () => {
    const { api, state } = harness({
        readCachedValue: async () => ({ value: { theme: 'offline-restored' } }),
        console: { error() {}, warn() {}, log() {} },
    });
    await api.loadSettings();
    assert.equal(state.appData.settings.theme, 'offline-restored');
});
