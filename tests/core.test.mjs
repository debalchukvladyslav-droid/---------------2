import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
    createElement() {
        return {
            _text: '',
            set textContent(value) {
                this._text = String(value ?? '');
                this.innerHTML = this._text
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;');
            },
            get textContent() {
                return this._text;
            },
            innerHTML: '',
        };
    },
};

const { canAccessMentorReviewQueueState, isMentorViewingOtherJournalState } = await import('../js/access_control.js');
const { normalizeAppData, normalizeDayEntry } = await import('../js/data_utils.js');
const { ecnFeeColumnIndex, parseSheetDateCellToIso } = await import('../js/parser_utils.js');
const { sanitizeHTML, safeExternalUrl, sanitizeRichHTML } = await import('../js/sanitize.js');
const { summarizeJournalPnl } = await import('../js/stats_math.js');

test('parser utils find ECN fee columns across supported header names', () => {
    assert.equal(ecnFeeColumnIndex({ Symbol: 0, 'Ecn Fee': 4 }), 4);
    assert.equal(ecnFeeColumnIndex({ Symbol: 0, ECN: 7 }), 7);
    assert.equal(ecnFeeColumnIndex({ Symbol: 0 }), undefined);
});

test('sheet date parser treats slash Excel dates as month/day/year', () => {
    assert.equal(parseSheetDateCellToIso('4/1/2026'), '2026-04-01');
    assert.equal(parseSheetDateCellToIso('4/2/2026'), '2026-04-02');
    assert.equal(parseSheetDateCellToIso('4/6/2026'), '2026-04-06');
    assert.equal(parseSheetDateCellToIso('1.4.2026'), '2026-04-01');
});

test('stats math summarizes journal pnl safely', () => {
    const summary = summarizeJournalPnl({
        '2026-04-01': { pnl: 120 },
        '2026-04-02': { pnl: -40 },
        '2026-04-03': { pnl: '30.5' },
        '2026-04-04': { pnl: null },
        '2026-04-05': { pnl: 'bad' },
    });

    assert.deepEqual(summary, {
        trades: 3,
        wins: 2,
        losses: 1,
        totalPnl: 110.5,
        winRate: 66.67,
        profitFactor: 3.76,
    });
});

test('access control allows mentor/admin review access and detects view-only mentor context', () => {
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'trader', isMentorMode: false }), false);
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'mentor', isMentorMode: false }), true);
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'admin', isMentorMode: false }), true);
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'trader', isMentorMode: true }), true);

    assert.equal(isMentorViewingOtherJournalState({
        myRole: 'mentor',
        isMentorMode: true,
        userDocName: 'mentor_stats',
        currentViewedUser: 'trader_stats',
    }), true);
    assert.equal(isMentorViewingOtherJournalState({
        myRole: 'mentor',
        isMentorMode: true,
        userDocName: 'mentor_stats',
        currentViewedUser: 'mentor_stats',
    }), false);
});

test('journal normalization keeps valid days and sanitizes malformed fields', () => {
    const appData = normalizeAppData({
        journal: {
            '2026-04-01': {
                pnl: '42.25',
                errors: ['FOMO', 123],
                screenshots: { good: ['a.png'], bad: [false] },
                fondexx: { gross: '100', net: '80', comm: '5', locates: '2', tickers: ['AAPL', 10] },
            },
            'not-a-date': { pnl: 999 },
        },
    });

    assert.deepEqual(Object.keys(appData.journal), ['2026-04-01']);
    assert.equal(appData.journal['2026-04-01'].pnl, 42.25);
    assert.deepEqual(appData.journal['2026-04-01'].errors, ['FOMO']);
    assert.deepEqual(appData.journal['2026-04-01'].screenshots.good, ['a.png']);
    assert.deepEqual(appData.journal['2026-04-01'].screenshots.bad, []);
    assert.deepEqual(appData.journal['2026-04-01'].fondexx.tickers, ['AAPL']);
});

test('day entry normalization falls back for unsafe values', () => {
    const entry = normalizeDayEntry({
        pnl: '',
        notes: 123,
        sliders: null,
        review_requests: 'bad',
    });

    assert.equal(entry.pnl, null);
    assert.equal(entry.notes, '');
    assert.deepEqual(entry.sliders, {});
    assert.deepEqual(entry.review_requests, {});
});

test('sanitize helpers escape html and reject unsafe urls', () => {
    assert.equal(sanitizeHTML('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(safeExternalUrl('javascript:alert(1)'), '#');
    assert.equal(safeExternalUrl('https://example.com/path'), 'https://example.com/path');
    assert.equal(sanitizeRichHTML('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});
