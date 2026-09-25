import test from 'node:test';
import assert from 'node:assert/strict';
import {
    acceptClientError,
    clientErrorFingerprint,
    formatClientErrorReport,
    isIgnorableClientError,
    normalizeClientError,
    safeClientPage,
} from '../lib/client_error_report.js';

test('error report hides tokens and keeps the action scenario', () => {
    const report = normalizeClientError({
        kind: 'console',
        message: 'Save failed Bearer eyJaaaaaaaa.bbbbbbbb.cccccccc for the day',
        stack: 'at saveEntry (https://journal.local/js/calendar.js:120:4)',
        source: 'https://journal.local/js/calendar.js',
        line: 120,
        column: 4,
        page: 'https://journal.local/calendar?access_token=secret&day=1#token',
        tab: 'calendar',
        happenedAt: '2026-09-25T10:41:00.000Z',
        scenario: [
            { at: '2026-09-25T10:40:00.000Z', label: '13:40:00', what: 'відкрив /calendar' },
            { at: '2026-09-25T10:40:08.000Z', label: '13:40:08', what: 'натиснув вкладка Календар, дія save-entry, «Зберегти»' },
        ],
    }, {
        userId: 'user-1',
        nick: 'Олена',
        email: 'olena@example.com',
        now: new Date('2026-09-25T10:41:00.000Z'),
    });

    assert.equal(report.page, '/calendar?day=1');
    assert.equal(report.location, '/js/calendar.js:120:4');
    assert.doesNotMatch(report.message, /eyJ/);
    assert.match(report.message, /\[приховано\]/);
    const text = formatClientErrorReport(report);
    assert.match(text, /Акаунт: Олена · olena@example.com/);
    assert.match(text, /ID акаунта: user-1/);
    assert.match(text, /Де на сайті: Календар, адреса \/calendar\?day=1/);
    assert.match(text, /1\. 13:40:00 відкрив \/calendar/);
    assert.match(text, /2\. 13:40:08 натиснув вкладка Календар, дія save-entry/);
    assert.match(text, /Місце в коді: \/js\/calendar\.js:120:4/);
    assert.doesNotMatch(text, /secret/);
});

test('the same failure keeps a stable fingerprint', () => {
    const first = clientErrorFingerprint('Cannot read notes', 'at render (js/calendar.js:10:2)');
    const second = clientErrorFingerprint('Cannot read notes', 'at render (js/calendar.js:88:9)');
    assert.equal(first, second);
});

test('browser noise is not reported', () => {
    assert.equal(isIgnorableClientError('Script error.'), true);
    assert.equal(isIgnorableClientError('ResizeObserver loop completed'), true);
    assert.equal(normalizeClientError({ message: 'Script error.', page: '/calendar' }), null);
    assert.equal(safeClientPage('/calendar#access_token=abc'), '/calendar');
});

test('admin console noise is dropped and a new user error is sent once', async () => {
    const notices = [];
    const deps = {
        recentCount: async () => 0,
        wasNotified: async () => notices.length > 0,
        insert: async () => ({ id: 'row-1' }),
        markNotified: async () => {},
        notify: async (report) => {
            notices.push(report.message);
            return true;
        },
    };
    const raw = {
        kind: 'error',
        message: 'Cannot save the day',
        page: '/calendar',
        scenario: [{ label: '13:41:00', what: 'натиснув дія save-entry' }],
    };
    const context = { isAdmin: false, nick: 'Ігор', now: new Date('2026-09-25T10:41:00.000Z') };

    const admin = await acceptClientError(raw, { ...context, isAdmin: true }, deps);
    assert.equal(admin.skipped, 'admin');
    assert.equal(notices.length, 0);

    const first = await acceptClientError(raw, context, deps);
    const second = await acceptClientError(raw, context, deps);
    assert.equal(first.notified, true);
    assert.equal(second.notified, false);
    assert.deepEqual(notices, ['Cannot save the day']);
});
