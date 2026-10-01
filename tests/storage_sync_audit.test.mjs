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
        ensureTradeIds: (trades) => Array.isArray(trades) ? trades : [],
        normalizeDayEntry: (entry) => ({ ...(entry || {}) }),
        dayReviewMetrics: () => ({ dayScores: {}, dayGrade: '', dayTags: [] }),
        ...overrides,
    });
    vm.runInContext(`${source}\nglobalThis.audit = { saveSettings, loadSettings, saveJournalData, markJournalDayDirty };`, context);
    return { state, handlers, commits, api: context.audit };
}

test('settings commit offline without a getUser network request', async () => {
    const { api, commits } = harness();
    await api.saveSettings();
    assert.equal(commits.length, 1);
    assert.equal(commits[0][0], 'owner');
    assert.equal(commits[0][1][0].value.theme, 'local');
});

test('a known local account does not wait on getSession', async () => {
    let called = false;
    const { api, commits } = harness({
        supabase: { auth: { getSession: async () => { called = true; return new Promise(() => {}); } } },
    });
    await api.saveSettings();
    assert.equal(called, false);
    assert.equal(commits.length, 1);
    assert.equal(commits[0][0], 'owner');
});

test('a failed auth refresh still saves with the signed-in account', async () => {
    const error = new TypeError('Failed to fetch');
    error.name = 'AuthRetryableFetchError';
    const { api, commits } = harness({
        supabase: { auth: { getSession: async () => { throw error; }, getUser: async () => { throw error; } } },
    });
    await api.saveSettings();
    assert.equal(commits.length, 1);
    assert.equal(commits[0][0], 'owner');
    assert.equal(commits[0][1][0].value.theme, 'local');
});

test('an unloaded settings collection is kept instead of being saved as empty', async () => {
    const previous = { tickers: { AAPL: 1 }, theme: 'dark' };
    const { api, commits, state } = harness({ readCachedValue: async () => ({ value: previous }) });
    state.appData.settings = { theme: 'local' };
    await api.saveSettings();
    assert.equal(commits.length, 1);
    assert.equal(commits[0][1][0].value.theme, 'local');
    assert.deepEqual(commits[0][1][0].value.tickers, { AAPL: 1 });
});

test('startup defaults do not count as clearing cached collections', async () => {
    const previous = {
        tickers: { AAPL: 1 },
        screenMeta: { shot: { tag: 'a' } },
        unassignedImages: ['img'],
        monthlyDayloss: { '2026-10': -500 },
        theme: 'dark',
    };
    const { api, commits, state } = harness({ readCachedValue: async () => ({ value: previous }) });
    state.appData.settings = { theme: 'local', monthlyDayloss: {} };
    state.appData.tickers = {};
    state.appData.screenMeta = {};
    state.appData.unassignedImages = [];
    await api.saveSettings();
    assert.equal(commits.length, 1);
    const saved = commits[0][1][0].value;
    assert.equal(saved.theme, 'local');
    assert.deepEqual(saved.tickers, previous.tickers);
    assert.deepEqual(saved.screenMeta, previous.screenMeta);
    assert.deepEqual(saved.unassignedImages, previous.unassignedImages);
    assert.deepEqual(saved.monthlyDayloss, previous.monthlyDayloss);
    assert.deepEqual(state.appData.tickers, previous.tickers);
    assert.deepEqual(state.appData.settings.monthlyDayloss, previous.monthlyDayloss);
});

test('settings guard blocks an explicit clear of several populated collections', async () => {
    const previous = { tickers: { A: 1 }, screenMeta: { shot: {} }, cumulativeSheetRows: { row: {} } };
    const { api, commits, state } = harness({ readCachedValue: async () => ({ value: previous }) });
    state.appData.tickers = { A: 1 };
    state.appData.screenMeta = { shot: {} };
    state.appData.cumulativeSheetRows = { row: {} };
    await api.saveSettings();
    state.appData.tickers = {};
    state.appData.screenMeta = {};
    state.appData.cumulativeSheetRows = {};
    await assert.rejects(api.saveSettings(), { code: 'DATA_LOSS_GUARD' });
    assert.equal(commits.length, 1);
});

test('a startup save keeps cached trades when several open days have none', async () => {
    const cached = {
        '2026-09-01': [{ id: 't1', symbol: 'AAA' }],
        '2026-09-02': [{ id: 't2', symbol: 'BBB' }],
        '2026-09-03': [{ id: 't3', symbol: 'CCC' }],
    };
    const { api, commits, state } = harness({
        readCachedDay: async (_userId, dateStr) => ({ row: { daily_metrics: { trades: cached[dateStr] || [] } } }),
    });
    Object.keys(cached).forEach((dateStr) => {
        state.appData.journal[dateStr] = { pnl: 1, trades: [], __detailsLoaded: true };
        api.markJournalDayDirty(dateStr);
    });
    await api.saveJournalData({ immediate: true });
    assert.equal(commits.length, 1);
    const saved = Object.fromEntries(commits[0][1].map((change) => [change.entityId, change.value.daily_metrics.trades]));
    assert.deepEqual(saved['2026-09-01'], cached['2026-09-01']);
    assert.deepEqual(saved['2026-09-02'], cached['2026-09-02']);
    assert.deepEqual(saved['2026-09-03'], cached['2026-09-03']);
    assert.deepEqual(state.appData.journal['2026-09-01'].trades, cached['2026-09-01']);
});

test('one emptied day can still be saved without its trades', async () => {
    const { api, commits, state } = harness({
        readCachedDay: async () => ({ row: { daily_metrics: { trades: [{ id: 't1' }] } } }),
    });
    state.appData.journal['2026-09-01'] = { pnl: 1, trades: [], __detailsLoaded: true };
    api.markJournalDayDirty('2026-09-01');
    await api.saveJournalData({ immediate: true });
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0][1][0].value.daily_metrics.trades, []);
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
