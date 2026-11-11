import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getWeekStartIso, getWeekRange, resolveWeeklyComment } from '../js/cumulative_weekly.js';
import { getEffectiveDayPnl } from '../js/trade_filters.js';
import { parseDecimalInput } from '../js/utils.js';

async function browserSource(name) {
    return (await readFile(new URL(`../js/${name}`, import.meta.url), 'utf8'))
        .replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('calendar weeks include Friday across Kyiv winter, summer and DST boundaries', async () => {
    const source = await browserSource('calendar.js');
    const originalZone = process.env.TZ;
    try {
        process.env.TZ = 'Europe/Kyiv';
        const state = { appData: { journal: {} } };
        const api = vm.runInNewContext(`${source}\n({getMonday, sumWeekTradingStats})`, {
            Date, state, getWeekStartIso, getWeekRange, resolveWeeklyComment, getEffectiveDayPnl, parseDecimalInput,
        });
        for (const monday of ['2026-11-09', '2026-07-06', '2026-03-23', '2026-10-19']) {
            const dates = getWeekRange(monday).dates;
            state.appData.journal = Object.fromEntries(dates.map((date) => [date, { pnl: 100 }]));
            const [y, m, d] = monday.split('-').map(Number);
            const key = api.getMonday(new Date(y, m - 1, d));
            assert.equal(key, monday);
            const summary = api.sumWeekTradingStats(key);
            assert.equal(summary.sumPnl, 500);
            assert.equal(summary.nPnl, 5);
        }
    } finally {
        if (originalZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalZone;
    }
});

test('legacy Sunday comments remain editable without rewriting saved notes', () => {
    const comments = { '2026-11-08': 'old weekly review' };
    assert.deepEqual(resolveWeeklyComment(comments, '2026-11-09'), { key: '2026-11-08', text: 'old weekly review' });
    assert.deepEqual(comments, { '2026-11-08': 'old weekly review' });
    comments['2026-11-09'] = 'Monday review';
    assert.equal(resolveWeeklyComment(comments, '2026-11-09').text, 'Monday review');
    comments['2026-11-09'] = '';
    assert.equal(resolveWeeklyComment(comments, '2026-11-09').text, '');
});

test('dashboard profit factor shows infinity for gains without any losses', async () => {
    const source = await browserSource('calendar.js');
    const factor = {};
    const api = vm.runInNewContext(`${source}\n({updateDashboardWidgets})`, {
        state: { appData: { journal: { '2026-11-09': { pnl: 100 } } } },
        window: {},
        document: { getElementById: (id) => id === 'pro-pf' ? factor : null },
        getEffectiveDayPnl, visibleTradeRows: () => [], updateDashMiniEquityChart() {},
    });
    api.updateDashboardWidgets(2026, 10);
    assert.equal(factor.textContent, '∞');
});

test('day save confirms only persisted changes and keeps later edits dirty', async () => {
    const source = (await browserSource('calendar.js')).replaceAll("import('./storage.js')", 'Promise.resolve(storage)');
    const fields = Object.fromEntries(['trade-pnl', 'trade-gross', 'trade-comm', 'trade-locates', 'trade-kf', 'trade-notes'].map((id) => [id, { value: id === 'trade-notes' ? 'draft' : '10' }]));
    const events = [];
    let pending = deferred();
    const api = vm.runInNewContext(`${source}\n({saveEntry, edit:()=>{_dayEditorDirty=true;_dayEditorRevision++;}, dirty:()=>_dayEditorDirty})`, {
        state: { selectedDateStr: '2026-11-09', USER_DOC_NAME: 'owner', CURRENT_VIEWED_USER: 'owner', appData: { journal: {} } },
        document: { querySelectorAll: () => [], getElementById: (id) => fields[id] || null },
        window: { dispatchEvent: (event) => events.push(event.type) },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        storage: { saveJournalData: () => pending.promise },
        parseDecimalInput, markJournalDayDirty() {}, setElementLoading() {}, showGlobalLoader() {}, hideGlobalLoader() {},
        console: { error() {} },
    });
    api.edit();
    const failed = api.saveEntry({ silent: true });
    pending.resolve(Promise.reject(new Error('Storage full')));
    assert.equal(await failed, false);
    assert.equal(api.dirty(), true);
    assert.equal(events.includes('journal:day-saved'), false);
    pending = deferred();
    const saving = api.saveEntry({ silent: true });
    api.edit();
    pending.resolve();
    assert.equal(await saving, true);
    assert.equal(api.dirty(), true);
    assert.equal(events.includes('journal:day-saved'), false);
    pending = deferred();
    const retried = api.saveEntry({ silent: true });
    pending.resolve();
    assert.equal(await retried, true);
    assert.equal(api.dirty(), false);
    assert.ok(events.includes('journal:day-saved'));
});

test('Ctrl+S and save-button clicks never clear the unsaved warning before success', async () => {
    const source = await browserSource('app_enhancements.js');
    const documentEvents = {}, windowEvents = {}, sidebarEvents = {}, buttonEvents = {};
    class Input {}
    const messages = [];
    const button = { dataset: {}, addEventListener: (name, fn) => { buttonEvents[name] = fn; } };
    const api = vm.runInNewContext(`${source}\n({trackDayFormChanges, addKeyboardShortcuts, dirty:()=>dayFormDirty})`, {
        lazyActions: () => ({}), HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
        document: {
            readyState: 'loading',
            addEventListener: (name, fn) => { documentEvents[name] = fn; },
            getElementById: (id) => id === 'form-sidebar' ? { addEventListener: (name, fn) => { sidebarEvents[name] = fn; } } : button,
        },
        window: { addEventListener: (name, fn) => { windowEvents[name] = fn; }, setTimeout() {}, saveEntry: async () => false },
        showToast: (message) => messages.push(message),
    });
    api.trackDayFormChanges();
    api.addKeyboardShortcuts();
    sidebarEvents.input({ target: Object.assign(new Input(), { type: 'text' }) });
    buttonEvents.click();
    assert.equal(api.dirty(), true);
    await documentEvents.keydown({ ctrlKey: true, key: 's', preventDefault() {} });
    assert.equal(api.dirty(), true);
    assert.deepEqual(messages, []);
    windowEvents['journal:day-saved']();
    assert.equal(api.dirty(), false);
});

async function navigationEditor(saveJournalData) {
    const source = (await browserSource('calendar.js')).replaceAll("import('./storage.js')", 'Promise.resolve(storage)');
    const fields = Object.fromEntries(['trade-pnl', 'trade-gross', 'trade-comm', 'trade-locates', 'trade-kf', 'trade-notes', 'trade-date'].map((id) => [id, { value: id === 'trade-notes' ? 'unsaved note' : '10' }]));
    const state = { selectedDateStr: '2026-11-09', USER_DOC_NAME: 'owner', CURRENT_VIEWED_USER: 'owner', appData: { journal: { '2026-11-10': { __detailsLoaded: true } } } };
    const messages = [], fills = [];
    const api = vm.runInNewContext(`${source}\nfillSelectedDateUI = date => fills.push(date);\n({selectDate, edit:()=>{_dayEditorDirty=true;_dayEditorRevision++;}})`, {
        state, fills, document: { querySelectorAll: () => [], getElementById: (id) => fields[id] || null },
        window: { dispatchEvent() {} }, CustomEvent: class {}, storage: { saveJournalData },
        parseDecimalInput, markJournalDayDirty() {}, setElementLoading() {}, showGlobalLoader() {}, hideGlobalLoader() {},
        showToast: (message) => messages.push(message), console: { error() {} },
    });
    api.edit();
    return { api, fields, state, messages, fills };
}

test('failed autosave keeps the selected day and form, including clicking that same day', async () => {
    const editor = await navigationEditor(async () => { throw new Error('quota exceeded'); });
    for (const date of ['2026-11-10', '2026-11-09']) {
        assert.equal(await editor.api.selectDate(date), false);
        assert.equal(editor.state.selectedDateStr, '2026-11-09');
        assert.equal(editor.fields['trade-notes'].value, 'unsaved note');
    }
    assert.equal(editor.fills.length, 0);
    assert.equal(editor.messages.length, 2);
});

test('changing days waits for edits entered during an in-flight autosave', async () => {
    const first = deferred(), second = deferred();
    let saves = 0;
    const editor = await navigationEditor(() => ++saves === 1 ? first.promise : second.promise);
    const navigation = editor.api.selectDate('2026-11-10');
    await new Promise((resolve) => setImmediate(resolve));
    editor.fields['trade-notes'].value = 'newer note';
    editor.api.edit();
    first.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saves, 2);
    assert.equal(editor.state.selectedDateStr, '2026-11-09');
    second.resolve();
    await navigation;
    assert.equal(editor.state.selectedDateStr, '2026-11-10');
    assert.equal(editor.state.appData.journal['2026-11-09'].notes, 'newer note');
});

test('failed autosave blocks a profile switch without leaving its switch lock stuck', async () => {
    const source = await browserSource('teams.js');
    const state = { USER_DOC_NAME: 'owner_stats', CURRENT_VIEWED_USER: 'owner_stats' };
    const messages = [];
    const api = vm.runInNewContext(`${source}\n({switchUser})`, {
        state, window: { autoSaveCurrentDay: async () => { throw new Error('quota'); } },
        showToast: (message) => messages.push(message),
    });
    assert.equal(await api.switchUser('other'), false);
    assert.equal(await api.switchUser('another'), false);
    assert.equal(state.CURRENT_VIEWED_USER, 'owner_stats');
    assert.deepEqual(messages, ['quota', 'quota']);
});

class Element {
    children = []; style = {}; dataset = {}; attrs = {}; className = '';
    constructor(id = '') { this.id = id; }
    classList = {
        contains: (name) => this.className.split(' ').includes(name),
        add: (name) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
        remove: (name) => { this.className = this.className.split(' ').filter((item) => item !== name).join(' '); },
        toggle: (name, on) => { const next = on ?? !this.classList.contains(name); this.classList[next ? 'add' : 'remove'](name); },
    };
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    append(...children) { children.forEach((child) => { child.parent = this; this.children.push(child); }); }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    querySelector(selector) { return this.children.find((child) => child.classList.contains(selector.replace(':scope > ', '').replace(/^\./, ''))) || null; }
    contains() { return false; }
    dispatchEvent() {}
}

test('a failed tab removes its loader, offers retry, and recovers without reload', async () => {
    const source = await browserSource('ui.js');
    const views = { dash: new Element('view-dash'), table: new Element('view-table') };
    views.dash.className = 'view-content active'; views.table.className = 'view-content';
    let fail = true;
    const messages = [];
    const window = { addEventListener() {}, initSheetTableView: async () => { if (fail) throw new Error('offline'); } };
    const api = vm.runInNewContext(`${source}\n({switchMainTab})`, {
        state: {}, HTMLElement: Element, CustomEvent: class {}, console: { error() {}, warn() {} },
        document: {
            body: new Element(), addEventListener() {}, createElement: () => new Element(),
            getElementById: (id) => Object.values(views).find((view) => view.id === id) || null,
            querySelectorAll: (selector) => selector === '.view-content' ? Object.values(views) : [],
            querySelector: (selector) => selector === '.view-content.active' ? Object.values(views).find((view) => view.classList.contains('active')) : null,
        },
        window, showToast: (message) => messages.push(message),
        renderDashQuote() {}, disposeDashMiniEquityChart() {},
        requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => fn(), performance: { now: () => 1000 },
    });
    await api.switchMainTab('table', { updateRoute: false });
    assert.equal(views.table.classList.contains('app-view-loading'), false);
    const error = views.table.querySelector('.app-view-error');
    assert.ok(error);
    assert.equal(error.children[1].dataset.action, 'view-retry');
    fail = false;
    await api.switchMainTab('table', { refresh: true, updateRoute: false });
    assert.equal(views.table.querySelector('.app-view-error'), null);
    assert.equal(views.table.classList.contains('active'), true);
    window.autoSaveCurrentDay = async () => { throw new Error('quota'); };
    assert.equal(await api.switchMainTab('dash', { updateRoute: false }), false);
    assert.equal(views.table.classList.contains('active'), true);
    assert.deepEqual(messages, ['quota']);
});
