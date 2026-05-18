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
const { buildAutoTradeTypesData, normalizeAppData, normalizeDayEntry } = await import('../js/data_utils.js');
const { ecnFeeColumnIndex, parseSheetDateCellToIso } = await import('../js/parser_utils.js');
const { sanitizeHTML, safeExternalUrl, sanitizeRichHTML } = await import('../js/sanitize.js');
const { enrichTradeWithSheet, findSheetMatchIndex, parseSheetGridToTrades } = await import('../js/sheet_sync_core.js');
const { summarizeJournalPnl } = await import('../js/stats_math.js');
const { getEffectiveDayPnl, isPureGoogleSheetTrade, visibleTradeRows } = await import('../js/trade_filters.js');
const { parseDecimalInput } = await import('../js/utils.js');

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
                pnl: '42,25',
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

test('decimal parser accepts comma and dot inputs', () => {
    assert.equal(parseDecimalInput('12.5'), 12.5);
    assert.equal(parseDecimalInput('12,5'), 12.5);
    assert.equal(parseDecimalInput(' +1 234,50 '), 1234.5);
    assert.equal(parseDecimalInput(''), null);
    assert.equal(parseDecimalInput('12,5,7'), null);
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

test('auto trade type metrics group imported trades by default categories', () => {
    const auto = buildAutoTradeTypesData([
        { net: 10, type: 'шорт', sheet: { profitRisk: '1.5' } },
        { net: -4, sheet: { tradeType: 'шортНС', profitRisk: '-0,4R' } },
        { net: 6, sheet: { tradeType: 'РПвиключення', profitRisk: '0.6' } },
        { net: 3, sheet: { tradeType: 'виключення-фіолетова', profitRisk: '0.3' } },
        { net: 2, sheet: { tradeType: 'РПвізуально', profitRisk: '0.2' } },
    ]);

    assert.deepEqual(auto, {
        'Шорт': { pnl: 10, kf: 1.5 },
        'Виключення': { pnl: 2, kf: 0.2 },
        'Фіолетова': { pnl: 3, kf: 0.3 },
        'Візуально': { pnl: 2, kf: 0.2 },
    });
});

test('sanitize helpers escape html and reject unsafe urls', () => {
    assert.equal(sanitizeHTML('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(safeExternalUrl('javascript:alert(1)'), '#');
    assert.equal(safeExternalUrl('https://example.com/path'), 'https://example.com/path');
    assert.equal(sanitizeRichHTML('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('trade filters hide pure Google Sheet rows but keep matched trades', () => {
    const realTrade = { symbol: 'AAPL', net: 10 };
    const sheetOnly = { symbol: 'TSLA', net: 5, sheet: { source: 'google', spreadsheetId: 's1' } };
    const matched = { symbol: 'NVDA', net: 7, sheet: { source: 'google', spreadsheetId: 's1', matchedBy: 'symbol-time' } };

    assert.equal(isPureGoogleSheetTrade(sheetOnly), true);
    assert.equal(isPureGoogleSheetTrade(sheetOnly, 'other-sheet'), false);
    assert.equal(isPureGoogleSheetTrade(matched), false);
    assert.deepEqual(visibleTradeRows([realTrade, sheetOnly, matched]).map((row) => row.index), [0, 2]);
});

test('sheet-only pnl is ignored for day-level stats', () => {
    const sheetOnlyDay = {
        pnl: 25,
        fondexx: { gross: 30, net: 25, comm: 5, locates: 0 },
        ppro: { gross: 0, net: 0, comm: 0, locates: 0 },
        trades: [
            { gross: 30, net: 25, comm: 5, sheet: { source: 'google', spreadsheetId: 's1' } },
        ],
    };
    const matchedDay = {
        ...sheetOnlyDay,
        trades: [
            { gross: 30, net: 25, comm: 5, sheet: { source: 'google', spreadsheetId: 's1', matchedBy: 'symbol-time' } },
        ],
    };

    assert.equal(getEffectiveDayPnl(sheetOnlyDay), null);
    assert.equal(getEffectiveDayPnl(matchedDay), 25);
});

test('google sheet rows enrich existing Trades instead of becoming sheet-only trades', () => {
    const parsed = parseSheetGridToTrades(
        [
            ['4/1/2026', 'AAPL', 'Шорт', '120,50', '1,2R', 'PV ok'],
            ['', 'TSLA', 'Шорт', '-25', '-0,3R', 'late'],
        ],
        {
            date: 'A',
            symbol: 'B',
            tradeType: 'C',
            profit: 'D',
            profitRisk: 'E',
            pv: 'F',
        },
        'sheet-1',
        6,
    );

    const incoming = parsed.outByDay['2026-04-01'][0];
    const existing = [
        { symbol: 'AAPL', net: 121, opened: '2026-04-01 09:47:00', type: 'Fondexx', entry: 10, exit: 11, qty: 100 },
    ];

    const matchIndex = findSheetMatchIndex(existing, incoming, new Set());
    const merged = enrichTradeWithSheet(existing[matchIndex], incoming);

    assert.equal(parsed.stats.tradeCount, 2);
    assert.equal(matchIndex, 0);
    assert.equal(merged.type, 'Шорт');
    assert.equal(merged.sheet.profitRisk, '1,2R');
    assert.equal(merged.sheet.matchedBy, 'date+ticker+pnl');
    assert.equal(isPureGoogleSheetTrade(merged), false);
});
