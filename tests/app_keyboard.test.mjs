import test from 'node:test';
import assert from 'node:assert/strict';

test('auth Enter works before the app shell and never submits twice after boot', async (t) => {
    const original = { document: globalThis.document, window: globalThis.window };
    t.after(() => Object.assign(globalThis, original));
    const listeners = [];
    let logins = 0, resets = 0;
    globalThis.document = { addEventListener: (name, fn) => { if (name === 'keydown') listeners.push(fn); }, getElementById: () => null };
    globalThis.window = { handleAuth: () => logins++, sendResetCode: () => resets++ };
    const events = await import(`../js/app_events.js?auth=${Date.now()}`);
    events.initAuthKeyboardEvents();
    events.initAuthKeyboardEvents();
    const emit = (id) => {
        const event = { key: 'Enter', target: { id, tagName: 'INPUT' }, preventDefault() { this.defaultPrevented = true; } };
        listeners.forEach((fn) => fn(event));
    };
    emit('auth-pass');
    assert.equal(logins, 1);
    events.initGlobalAppEvents({ shiftDate() {}, closeSOSModal() {} });
    emit('auth-pass');
    emit('reset-email');
    assert.equal(logins, 2);
    assert.equal(resets, 1);
});

test('trade arrows move one trade without changing its selected day', async (t) => {
    const original = { document: globalThis.document, window: globalThis.window };
    t.after(() => Object.assign(globalThis, original));
    const listeners = [], actions = [];
    let tradesActive = true;
    globalThis.document = {
        addEventListener: (name, fn) => { if (name === 'keydown') listeners.push(fn); },
        getElementById: (id) => id === 'view-trades' ? { classList: { contains: () => tradesActive } } : null,
        querySelectorAll: () => [true, false].map((active, index) => ({ classList: { contains: () => active }, click: () => actions.push(`trade:${index}`) })),
    };
    globalThis.window = {};
    const events = await import(`../js/app_events.js?arrows=${Date.now()}`);
    const terminal = await import(`../js/terminal_shortcuts.js?arrows=${Date.now()}`);
    events.initGlobalAppEvents({ shiftDate: (delta) => actions.push(`day:${delta}`), closeSOSModal() {} });
    terminal.initTerminalShortcuts();
    terminal.initTerminalShortcuts();
    const emit = (target = { tagName: 'DIV', matches: () => false }) => {
        const event = { key: 'ArrowRight', target, preventDefault() { this.defaultPrevented = true; } };
        listeners.forEach((fn) => fn(event));
    };
    emit();
    assert.deepEqual(actions, ['trade:1']);
    tradesActive = false;
    emit();
    assert.deepEqual(actions, ['trade:1', 'day:1']);
    emit({ tagName: 'SPAN', isContentEditable: true, matches: () => false });
    assert.equal(actions.length, 2);
});
