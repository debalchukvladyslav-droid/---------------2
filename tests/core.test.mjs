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

const {
    canAccessMentorReviewQueueState,
    canWriteMentorCommentState,
    isMentorViewingOtherJournalState,
    isViewingOtherProfileState,
} = await import('../js/access_control.js');
const { buildAutoTradeTypesData, deriveDayKfFromTrades, isNotTakenTrade, normalizeAppData, normalizeDayEntry } = await import('../js/data_utils.js');
const { ecnFeeColumnIndex, parsePPROReportDate, parsePPROTotalReportRows, parseSheetDateCellToIso, parseSheetDateCellsToIsoSequence } = await import('../js/parser_utils.js');
const { sanitizeHTML, safeExternalUrl, sanitizeRichHTML } = await import('../js/sanitize.js');
const { mergeGoogleSheetTradesIntoJournal } = await import('../js/sheet_journal_merge.js');
const { parseFondexxSummaryByDateRows } = await import('../js/fondexx_summary_parser.js');
const { collectDatagridRows } = await import('../js/datagrid_rows.js');
const { enrichTradeWithSheet, findSheetMatchIndex, parseSheetGridToTrades } = await import('../js/sheet_sync_core.js');
const { summarizeJournalPnl } = await import('../js/stats_math.js');
const { findTradeIndexByIdentity, getCalendarDayResult, getEffectiveDayPnl, isPureGoogleSheetTrade, visibleTradeRows } = await import('../js/trade_filters.js');
const { normalizeBrokerTradeType } = await import('../js/trade_import_utils.js');
const { duplicateSheetMappingConfig, getCumulativeArchiveSchedule } = await import('../js/sheet_import_modes.js');
const { detectExactSheetAutoMapping, migrateLegacyClassificationMapping, normalizeExactSheetHeader, relocateSheetDataStartRow } = await import('../js/sheet_auto_mapping.js');
const { buildExceptionKfRows, buildHourlyKfBuckets, buildSheetEntryPriceBuckets, buildSummaryByDateWeekdayPnl, combineStatsSheetRows, parseSheetProfitRisk } = await import('../js/stats_sheet_metrics.js');
const { parseDecimalInput } = await import('../js/utils.js');
const { getZonedClockParts, isEndOfSessionReviewTime } = await import('../js/session_schedule.js');
const { buildServiceBotSnapshot, hashServiceBotApiKey, hasServiceBotPermission, parseServiceBotRange } = await import('../lib/service_bots.js');
const { calculateCumulativeWeek, collectWeekStarts, getWeekRange, getWeekStartIso, parseCumulativeNumber, resolveMonthlyDayloss } = await import('../js/cumulative_weekly.js');
const { getNyseDaySchedule } = await import('../js/nyse_calendar.js');
const { mergedJournalDayForReview, reviewReasonsForDay } = await import('../js/review_signals.js');

test('review completeness uses trader Gross instead of imported net PnL', () => {
    const completed = reviewReasonsForDay({ gross_pnl: 125, pnl: null, notes: 'День заповнено' });
    assert.equal(completed.some((reason) => reason.key === 'inc'), false);
    const netOnly = reviewReasonsForDay({ gross_pnl: null, pnl: 120, notes: 'Є лише net' });
    assert.equal(netOnly.some((reason) => reason.key === 'inc'), true);
    assert.equal(mergedJournalDayForReview({ gross_pnl: 125, pnl: 120 }, {}).gross_pnl, 125);
});

test('NYSE calendar marks official holidays and shortened sessions', () => {
    assert.deepEqual(getNyseDaySchedule('2026-07-03'), {
        type: 'closed',
        name: 'День незалежності США',
        message: 'NYSE зачинена: День незалежності США',
    });
    assert.equal(getNyseDaySchedule('2026-11-27')?.type, 'early-close');
    assert.equal(getNyseDaySchedule('2026-11-27')?.closeTime, '13:00 ET');
    assert.equal(getNyseDaySchedule('2026-12-24')?.name, 'Переддень Різдва');
    assert.equal(getNyseDaySchedule('2026-07-02'), null);
});

test('NYSE calendar applies movable holiday rules', () => {
    assert.equal(getNyseDaySchedule('2027-03-26')?.name, 'Страсна п’ятниця');
    assert.equal(getNyseDaySchedule('2027-06-18')?.name, 'Juneteenth');
    assert.equal(getNyseDaySchedule('2028-01-01'), null);
});

test('cumulative week uses Monday through Friday and parses supported numbers', () => {
    assert.deepEqual(getWeekRange('2026-07-29').dates, ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']);
    assert.equal(getWeekStartIso('2026-08-02'), '2026-07-27');
    assert.equal(parseCumulativeNumber(' -1,25R '), -1.25);
    assert.equal(parseCumulativeNumber('$42.50'), 42.5);
    assert.equal(parseCumulativeNumber('none'), null);
});

test('cumulative week aggregates exact sheet types and authoritative imported pnl', () => {
    const result = calculateCumulativeWeek({
        weekStart: '2026-07-27',
        dayloss: -100,
        journal: {
            '2026-07-27': {
                fondexxSource: 'summary-by-date',
                fondexx: { net: 25, comm: 4, locates: 3 },
                pproSource: 'ppro-total-report',
                ppro: { net: -5 },
                pnl: 17,
            },
            '2026-07-28': { fondexxSource: 'trades', fondexx: { net: 999 } },
            '2026-08-01': { pproSource: 'ppro-total-report', ppro: { net: 999 } },
        },
        rowsByDay: {
            '2026-07-27': [
                { sheet: { sheetNet: '$10', pv: '1,5R', profitRisk: '0.7R', tradeType: 'виняток — не брав(ла)' } },
                { sheet: { sheetNet: '-3', pv: '-0.5', profitRisk: '-0,4R', tradeType: 'синя%' } },
                { sheet: { sheetNet: '7', pv: '2', profitRisk: '1.5R', tradeType: 'РПфіолетова' } },
                { sheet: { sheetNet: '4', pv: '1', tradeType: 'РПвізуально' } },
                { sheet: { sheetNet: '50', pv: '3', tradeType: 'РПзелена' } },
            ],
            '2026-08-01': [{ sheet: { sheetNet: 999, pv: 999, tradeType: 'не брав' } }],
        },
    });
    assert.equal(result.tableProfit, 68);
    assert.equal(result.metroResult, 17);
    assert.equal(result.pvResult, 7);
    assert.equal(result.notTakenResult, 1.5);
    assert.equal(result.notTakenKf, 0.7);
    assert.equal(result.notTakenKfCount, 1);
    assert.equal(result.blue, -3);
    assert.equal(result.green, 50);
    assert.equal(result.purple, 7);
    assert.equal(result.visual, 4);
    assert.equal(result.blueKf, -0.4);
    assert.equal(result.blueKfCount, 1);
    assert.equal(result.purpleKf, 1.5);
    assert.equal(result.purpleKfCount, 1);
    assert.equal(result.greenKfCount, 0);
    assert.equal(result.effectiveness, 0.17);
});

test('cumulative metro result falls back to calendar import formula with locates', () => {
    const result = calculateCumulativeWeek({
        weekStart: '2026-07-27',
        journal: {
            '2026-07-27': {
                fondexxSource: 'summary-by-date',
                fondexx: { net: 120, comm: 8, locates: 20 },
                pproSource: 'ppro-total-report',
                ppro: { net: -10, comm: 2, locates: 0 },
            },
        },
    });
    assert.equal(result.metroResult, 90);
});

test('cumulative week list always includes current week', () => {
    const weeks = collectWeekStarts({}, {}, new Date(2026, 6, 29));
    assert.deepEqual(weeks, ['2026-07-27']);
});

test('cumulative dayloss repeats the latest previous month until overridden', () => {
    const limits = { '2026-05': 80, '2026-07': -120, '2026-09': 200 };
    assert.equal(resolveMonthlyDayloss(limits, '2026-07'), 120);
    assert.equal(resolveMonthlyDayloss(limits, '2026-08'), 120);
    assert.equal(resolveMonthlyDayloss(limits, '2026-04'), null);
});

test('parser utils find ECN fee columns across supported header names', () => {
    assert.equal(ecnFeeColumnIndex({ Symbol: 0, 'Ecn Fee': 4 }), 4);
    assert.equal(ecnFeeColumnIndex({ Symbol: 0, ECN: 7 }), 7);
    assert.equal(ecnFeeColumnIndex({ Symbol: 0 }), undefined);
});

test('sheet date parser treats text Excel dates as day/month/year', () => {
    assert.equal(parseSheetDateCellToIso('4/1/2026'), '2026-01-04');
    assert.equal(parseSheetDateCellToIso('4/2/2026'), '2026-02-04');
    assert.equal(parseSheetDateCellToIso('4/6/2026'), '2026-06-04');
    assert.equal(parseSheetDateCellToIso('1.4.2026'), '2026-04-01');
    assert.equal(parseSheetDateCellToIso('15,05,26'), '2026-05-15');
    assert.equal(parseSheetDateCellToIso('15.05.26'), '2026-05-15');
    assert.equal(parseSheetDateCellToIso('15/05/26'), '2026-05-15');
    assert.equal(parseSheetDateCellToIso('15-05-2026'), '2026-05-15');
});

test('sheet date sequence parser infers day/month or month/day from row order', () => {
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['20.06', '21.06', '24.06'], { year: 2026 }),
        ['2026-06-20', '2026-06-21', '2026-06-24']
    );
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['06.20', '06.21', '06.24'], { year: 2026 }),
        ['2026-06-20', '2026-06-21', '2026-06-24']
    );
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['20,06,26', '21,06,26', '24.06.2026']),
        ['2026-06-20', '2026-06-21', '2026-06-24']
    );
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['4/1/2026', '4/2/2026', '4/6/2026']),
        ['2026-04-01', '2026-04-02', '2026-04-06']
    );
});

test('sheet date parser accepts weekday prefixes and rolls future compact dates to previous year', () => {
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['Пн-1.06', '2.06'], { year: 2026 }),
        ['2026-06-01', '2026-06-02'],
    );
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['3.11', '4.11'], { year: 2026 }),
        ['2025-11-03', '2025-11-04'],
    );
});

test('end-of-session review starts at 09:30 New York time regardless of Kyiv local time', () => {
    const beforeClose = new Date('2026-07-15T13:29:00Z');
    const afterClose = new Date('2026-07-15T13:30:00Z');
    assert.deepEqual(getZonedClockParts(afterClose), { hour: 9, minute: 30 });
    assert.equal(isEndOfSessionReviewTime(beforeClose), false);
    assert.equal(isEndOfSessionReviewTime(afterClose), true);
    assert.equal(isEndOfSessionReviewTime(new Date('2026-07-15T16:00:00Z')), true);
    assert.equal(isEndOfSessionReviewTime(new Date('2026-07-15T16:01:00Z')), false);
});

test('sheet date sequence treats day-only rows after a month marker as the next month', () => {
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['Серпень', '1', '2', '3', '31'], { year: 2025 }),
        [null, '2025-09-01', '2025-09-02', '2025-09-03', null],
    );
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['Грудень 2025', '1', '2']),
        [null, '2026-01-01', '2026-01-02'],
    );
});

test('sheet date sequence still reads both 23/07 and 07/23 around month markers', () => {
    assert.deepEqual(
        parseSheetDateCellsToIsoSequence(['Червень', '1', '23/07', '07/23'], { year: 2025 }),
        [null, '2025-07-01', '2025-07-23', '2025-07-23'],
    );
});

test('PPRO report dates are parsed as month/day/year', () => {
    assert.equal(parsePPROReportDate('03/02/2026'), '2026-03-02');
    assert.equal(parsePPROReportDate('03/13/2026'), '2026-03-13');
});

test('PPRO total report rows aggregate daily Trading Total as profit-only source', () => {
    const rows = [
        ['Trader ID', 'Date', 'Currency', 'Gross', 'Gateway Charge', 'Sec Fee', 'Act Fee', 'Clr Fee', 'Exe Fee', 'Trading Total'],
        ['VLADDEBA', '03/02/2026', 'USD', '-2,087.1539', '80.3625', '0.71', '2.2169', '7.0682', '0.0000', '-2,177.5084'],
        ['VLADDEBA', '03/02/2026', 'USD', '100.0000', '0', '0', '0', '0', '0', '1,000.2550'],
        ['VLADDEBA', '03/13/2026', 'USD', '745.1800', '11.0675', '0.08', '0.2622', '0.8360', '0.0000', '732.9307'],
        ['VLADDEBA', '13/03/2026', 'USD', '999', '0', '0', '0', '0', '0', '999'],
        ['VLADDEBA', '07/01/2027', 'USD', '999', '0', '0', '0', '0', '0', '999'],
    ];

    const parsed = parsePPROTotalReportRows(rows, { todayIso: '2026-06-18' });

    assert.deepEqual(parsed, [
        { dateStr: '2026-03-02', gross: -1177.25, net: -1177.25, comm: 0, locates: 0, tickers: [] },
        { dateStr: '2026-03-13', gross: 732.93, net: 732.93, comm: 0, locates: 0, tickers: [] },
    ]);
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

const fondexxSummaryHeaders = [
    'Date', 'Type', 'Orders', 'Fills', 'Qty', 'Gross', 'Comm', 'Ecn Fee', 'SEC', 'TAF',
    'NSCC', 'CLR', 'Misc', 'ORF', 'PTFPF', 'Net', 'Daily Interest', 'HTB',
    'Misc (Cost of execution)', 'Credits Comm', 'Dividend', 'Software', 'Adj Net',
    'Unrealized Delta', 'Total Delta',
];

function summaryRow({ date, type = 'Eq', orders = 1, fills = 1, qty = 100, gross = 0, comm = 0, ecn = 0, net = 0, software = 0, total = 0 }) {
    return [
        date, type, orders, fills, qty, gross, comm, ecn, 0, 0,
        0, 0, 0, 0, 0, net, 0, 0,
        0, 0, 0, software, total, 0, total,
    ];
}

test('Fondexx Summary by date parser does not assign multi-month Equities total to first month', () => {
    const parsed = parseFondexxSummaryByDateRows([
        fondexxSummaryHeaders,
        summaryRow({ date: '2026-01-05', gross: 14000, comm: 184.61, net: 13815.39, total: 13815.39 }),
        summaryRow({ date: '2026-01-31', type: '', orders: 0, fills: 0, qty: 0, software: -65, total: 631.8 }),
        summaryRow({ date: '2026-02-02', gross: 6000, comm: 34.06, net: 5965.94, total: 5965.94 }),
        summaryRow({ date: '2026-02-28', type: '', orders: 0, fills: 0, qty: 0, total: -168.2 }),
        summaryRow({ date: '2026-03-02', gross: 9300, comm: 60.79, net: 9239.21, total: 9239.21 }),
        ['Equities', '', 426, 5009, 1604174, 39621.99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 34079.56, 0, 0, 0, 0, 0, 0, 29484.14, 0, 29484.14],
    ]);

    assert.deepEqual(parsed.touchedMonths, ['2026-01', '2026-02', '2026-03']);
    assert.deepEqual(parsed.dailyRows.map((row) => row.dateStr), ['2026-01-05', '2026-02-02', '2026-03-02']);
    assert.equal(parsed.monthlyAdjustments['2026-01'].pnl, 631.8);
    assert.equal(parsed.monthlyAdjustments['2026-02'].pnl, -168.2);
    assert.equal(parsed.monthlyAdjustments['2026-03'], undefined);
    assert.equal(parsed.auditTotals[0], 29484.14);
    assert.equal(parsed.monthlyAdjustments['2026-01'].pnl !== 15036.95, true);
});

test('Fondexx Summary by date parser keeps blank no-activity rows as monthly adjustments', () => {
    const parsed = parseFondexxSummaryByDateRows([
        fondexxSummaryHeaders,
        summaryRow({ date: '2026-04-01', type: '', orders: 0, fills: 0, qty: 0, total: -134.64 }),
        summaryRow({ date: '2026-04-07', gross: -2262.83, comm: 52.37, net: -2315.2, total: -2622.3 }),
        summaryRow({ date: '2026-05-30', type: 'Fees', orders: 0, fills: 0, qty: 0, software: -70, total: -173.2 }),
        summaryRow({ date: '2026-06-01', gross: 19000, comm: 80.34, net: 18919.66, total: 18919.66 }),
        ['Equities', '', 588, 5825, 1958564, 67764.15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 61867.71, 0, 0, 0, 0, 0, 0, 47379.78, 0, 47379.78],
    ]);

    assert.deepEqual(parsed.dailyRows.map((row) => row.dateStr), ['2026-04-07', '2026-06-01']);
    assert.equal(parsed.monthlyAdjustments['2026-04'].pnl, -134.64);
    assert.equal(parsed.monthlyAdjustments['2026-05'].pnl, -173.2);
    assert.equal(parsed.monthlyAdjustments['2026-04'].pnl !== 39478.69, true);
});

test('access control opens viewing but keeps review and mentor comment role-scoped', () => {
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'trader', isMentorMode: false }), false);
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'mentor', isMentorMode: false }), true);
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'admin', isMentorMode: false }), true);
    assert.equal(canAccessMentorReviewQueueState({ myRole: 'trader', isMentorMode: true }), true);

    assert.equal(isViewingOtherProfileState({
        userDocName: 'trader_a_stats',
        currentViewedUser: 'trader_b_stats',
    }), true);
    assert.equal(canWriteMentorCommentState({
        myRole: 'trader',
        isMentorMode: false,
        userDocName: 'trader_a_stats',
        currentViewedUser: 'trader_b_stats',
    }), false);
    assert.equal(canWriteMentorCommentState({
        myRole: 'admin',
        isMentorMode: false,
        userDocName: 'admin_stats',
        currentViewedUser: 'trader_b_stats',
    }), false);
    assert.equal(canWriteMentorCommentState({
        myRole: 'mentor',
        isMentorMode: true,
        userDocName: 'mentor_stats',
        currentViewedUser: 'trader_stats',
    }), true);

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
        { net: 10, sheet: { tradeType: 'синя%', profitRisk: '1.5' } },
        { net: -4, sheet: { tradeType: 'РПсиня', profitRisk: '-0,4R' } },
        { net: 6, sheet: { tradeType: 'зелена%', profitRisk: '0.6' } },
        { net: 3, sheet: { tradeType: 'РПфіолетова', profitRisk: '0.3' } },
        { net: 2, sheet: { tradeType: 'РПвізуально', profitRisk: '0.2' } },
    ]);

    assert.deepEqual(auto, {
        'Синя': { pnl: 6, kf: 1.1 },
        'Зелена': { pnl: 6, kf: 0.6 },
        'Фіолетова': { pnl: 3, kf: 0.3 },
        'Візуально': { pnl: 2, kf: 0.2 },
    });
});

test('daily KФ is derived from explicit trade R values without double-counting sheet rows', () => {
    const trades = [
        { id: 'a', sheet: { source: 'google', sheetRow: 7, profitRisk: '1.5R' } },
        { id: 'duplicate', sheet: { source: 'google', sheetRow: 7, profitRisk: '1.5R' } },
        { id: 'b', profitRisk: '-0,4R' },
        { id: 'skip', type: 'do not take', profitRisk: '9R' },
        { id: 'unknown', net: 500 },
    ];
    assert.equal(deriveDayKfFromTrades(trades), 1.1);
    assert.equal(normalizeDayEntry({ kf: null, trades }).kf, 1.1);
});

test('stored daily KФ wins and missing trade R stays unknown', () => {
    assert.equal(normalizeDayEntry({ kf: 2.25, trades: [{ profitRisk: '1R' }] }).kf, 2.25);
    assert.equal(deriveDayKfFromTrades([{ net: 100 }]), null);
    assert.equal(normalizeDayEntry({ kf: null, trades: [{ net: 100 }] }).kf, null);
});

test('not-taken sheet trade types are detected but excluded from auto trade PnL buckets', () => {
    assert.equal(isNotTakenTrade({ sheet: { tradeType: 'не брав візуально' } }), true);
    assert.equal(isNotTakenTrade({ type: 'do not take' }), true);
    assert.equal(isNotTakenTrade({ sheet: { tradeType: 'синя%' } }), false);

    const auto = buildAutoTradeTypesData([
        { net: 10, sheet: { tradeType: 'синя%', profitRisk: '1R' } },
        { net: -999, type: 'не брав візуально', sheet: { tradeType: 'не брав візуально', profitRisk: '-5R' } },
        { net: 500, sheet: { tradeType: 'do not take', profitRisk: '3R' } },
    ]);

    assert.deepEqual(auto, {
        'Синя': { pnl: 10, kf: 1 },
        'Зелена': { pnl: '', kf: '' },
        'Фіолетова': { pnl: '', kf: '' },
        'Візуально': { pnl: '', kf: '' },
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

test('trade identity finds the exact trade after journal rows are reordered', () => {
    const trades = [
        { symbol: 'AAPL', opened: '09:35', entry: 10, exit: 9.2, qty: 100 },
        { symbol: 'AAPL', opened: '10:05', entry: 8, exit: 7.4, qty: 250 },
    ];
    assert.equal(findTradeIndexByIdentity(trades, { symbol: 'AAPL', opened: '10:05', entry: 8, exit: 7.4, qty: 250 }), 1);
});

test('Trades import direction normalizes obvious broker Short and Long values', () => {
    assert.equal(normalizeBrokerTradeType('Short'), 'Short');
    assert.equal(normalizeBrokerTradeType('Sell Short'), 'Short');
    assert.equal(normalizeBrokerTradeType('Long'), 'Long');
    assert.equal(normalizeBrokerTradeType('Buy Long'), 'Long');
    assert.equal(normalizeBrokerTradeType('Custom Broker Type'), 'Custom Broker Type');
    assert.equal(normalizeBrokerTradeType(''), '');
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
    assert.equal(getEffectiveDayPnl({ pnl: '12,50', trades: [] }), 12.5);
});

test('PPRO-only pnl remains effective day profit', () => {
    const pproOnlyDay = {
        pnl: 732.93,
        fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: { gross: 732.93, net: 732.93, comm: 0, locates: 0, tickers: [] },
        pproSource: 'ppro-total-report',
        trades: [],
    };
    const combinedBrokerDay = {
        pnl: 932.93,
        fondexx: { gross: 250, net: 200, comm: 50, locates: 0, tickers: [] },
        ppro: { gross: 732.93, net: 732.93, comm: 0, locates: 0, tickers: [] },
        fondexxSource: 'summary-by-date',
        pproSource: 'ppro-total-report',
        trades: [],
    };

    assert.equal(getEffectiveDayPnl(pproOnlyDay), 732.93);
    assert.equal(getEffectiveDayPnl(combinedBrokerDay), 932.93);
});

test('calendar shows manual values as Gross and imported file values as Net', () => {
    assert.deepEqual(getCalendarDayResult({ gross_pnl: '125,50', pnl: 90 }), { value: 125.5, kind: 'gross' });
    assert.deepEqual(getCalendarDayResult({ pnl: -42, gross_pnl: -30, fondexxSource: 'summary-by-date' }), { value: -42, kind: 'net' });
    assert.deepEqual(getCalendarDayResult({ pnl: 18, gross_pnl: null }), { value: 18, kind: 'gross' });
});

test('day normalization preserves PPRO source marker', () => {
    const entry = normalizeDayEntry({
        ppro: { gross: 10, net: 10, comm: 0, locates: 0 },
        pproSource: 'ppro-total-report',
    });

    assert.equal(entry.pproSource, 'ppro-total-report');
});

test('sheet profit risk parser accepts dot, comma, and R suffix values', () => {
    assert.equal(parseSheetProfitRisk('1.5'), 1.5);
    assert.equal(parseSheetProfitRisk('1,5'), 1.5);
    assert.equal(parseSheetProfitRisk('+1.5R'), 1.5);
    assert.equal(parseSheetProfitRisk('-0,3R'), -0.3);
    assert.equal(parseSheetProfitRisk(''), null);
    assert.equal(parseSheetProfitRisk('no pnl'), null);
});

test('weekday PnL uses only Fondexx Summary by date rows', () => {
    const rows = [
        { dateStr: '2026-07-27', dateObj: new Date(2026, 6, 27), pnl: 100, data: { fondexxSource: 'summary-by-date' } },
        { dateStr: '2026-07-28', dateObj: new Date(2026, 6, 28), pnl: -25, data: { fondexxSource: 'summary-by-date' } },
        { dateStr: '2026-07-29', dateObj: new Date(2026, 6, 29), pnl: 999, data: { fondexxSource: 'trades-report' } },
    ];
    assert.deepEqual(buildSummaryByDateWeekdayPnl(rows), [100, -25, 0, 0, 0]);
});

test('entry price buckets use raw Sheet rows even when no Trades import exists', () => {
    const rows = buildSheetEntryPriceBuckets({
        'sheet-main': {
            '2026-07-01': [
                { symbol: 'CENT', net: 10, sheet: { entryPrice: 0.75, sheetNet: 10, profitRisk: '1R' } },
                { symbol: 'LOW', net: -5, sheet: { entryPrice: 2.5, sheetNet: -5, profitRisk: '-0,5R' } },
                { symbol: 'MID', net: 20, sheet: { entryPrice: 5, sheetNet: 20, profitRisk: '2R' } },
                { symbol: 'HIGH', net: 7, sheet: { entryPrice: 20, sheetNet: 7, profitRisk: '0,7R' } },
                { symbol: 'OVER', net: -12, sheet: { entryPrice: 20.01, sheetNet: -12, profitRisk: '-1,2R' } },
            ],
        },
        'sheet-cumulative': {
            '2026-02-01': [
                { symbol: 'OLD', sheet: { sheetRow: 12, entryPrice: 2, sheetNet: 15, profitRisk: '1R' } },
            ],
        },
    });

    assert.deepEqual(rows.map((row) => row.label), ['Центовка', '$1–3', '$3–5', '$5–10', '$10–20', '>$20']);
    assert.deepEqual(rows.map((row) => row.pnl), [10, 10, 0, 20, 7, -12]);
    assert.deepEqual(rows.map((row) => row.kf), [1, 0.5, 0, 2, 0.7, -1.2]);
    assert.deepEqual(rows.map((row) => row.trades), [1, 2, 0, 1, 1, 1]);
});

test('hourly KФ buckets use matched Sheet profitRisk instead of trade net', () => {
    const entries = [{
        dateStr: '2026-04-01',
        data: {
            trades: [
                { symbol: 'AAPL', opened: '2026-04-01 09:31:00', net: 100, sheet: { source: 'google', matchedBy: 'date+ticker+pnl', sheetNet: 30, profitRisk: '1.5R' } },
                { symbol: 'TSLA', opened: '2026-04-01 09:45:00', net: -999, sheet: { source: 'google', matchedBy: 'date+ticker+pnl', sheetNet: -10, profitRisk: '-0,5R' } },
                { symbol: 'NVDA', opened: '2026-04-01 09:50:00', net: 50, sheet: { source: 'google', profitRisk: '5R' } },
                { symbol: 'AMD', opened: '2026-04-01 08:10:00', net: 60, sheet: { source: 'google', matchedBy: 'date+ticker+pnl' } },
            ],
        },
    }];

    const buckets = buildHourlyKfBuckets(entries);
    const hourNine = buckets.find((row) => row.hour === 9);

    assert.equal(hourNine.pnl, 20);
    assert.equal(hourNine.kf, 1);
    assert.equal(hourNine.trades, 2);
});

test('hourly KФ counts each Sheet row once when broker trades contain duplicates', () => {
    const entries = [{
        dateStr: '2026-04-01',
        data: { trades: [
            { symbol: 'AAPL', opened: '2026-04-01 09:31:00', sheet: { source: 'google', matchedBy: 'date+ticker+pnl', sheetRow: 8, profitRisk: '2R' } },
            { symbol: 'AAPL', opened: '2026-04-01 09:31:00', sheet: { source: 'google', matchedBy: 'date+ticker+pnl', sheetRow: 8, profitRisk: '2R' } },
        ] },
    }];
    const hourNine = buildHourlyKfBuckets(entries).find((row) => row.hour === 9);
    assert.equal(hourNine.kf, 2);
    assert.equal(hourNine.trades, 1);
});

test('hourly results aggregate main and cumulative Sheet sources', () => {
    const entries = [{ dateStr: '2026-04-01', data: { trades: [
        { opened: '2026-04-01 09:31:00' },
        { opened: '2026-04-01 08:15:00' },
    ] } }];
    const sheetRows = {
        main: { '2026-04-01': [{ sheet: { sheetRow: 5, matchedTradeIndex: 0, sheetNet: 20, profitRisk: '1R' } }] },
        cumulative: { '2026-04-01': [{ sheet: { sheetRow: 5, matchedTradeIndex: 1, sheetNet: -5, profitRisk: '-0.25R' } }] },
    };
    const rows = buildHourlyKfBuckets(entries, null, { sheetRows });
    assert.deepEqual(rows.find((row) => row.hour === 8), { hour: 8, pnl: -5, kf: -0.25, trades: 1, pnlRows: 1, kfRows: 1, label: '08' });
    assert.deepEqual(rows.find((row) => row.hour === 9), { hour: 9, pnl: 20, kf: 1, trades: 1, pnlRows: 1, kfRows: 1, label: '09' });
});

test('main and cumulative rows remain separate when they use the same spreadsheet id', () => {
    const main = { shared: { '2026-07-01': [{ sheet: { sheetRow: 6, profitRisk: '1R', exception: 'Main' } }] } };
    const cumulative = { shared: { '2025-01-01': [{ sheet: { sheetRow: 6, profitRisk: '2R', exception: 'Archive' } }] } };
    const combined = combineStatsSheetRows(main, cumulative);
    assert.deepEqual(Object.keys(combined), ['main:shared', 'cumulative:shared']);
    const rows = buildExceptionKfRows([], null, { sheetRows: combined });
    assert.deepEqual(rows.map(({ criterion, kf }) => ({ criterion, kf })), [
        { criterion: 'Archive', kf: 2 },
        { criterion: 'Main', kf: 1 },
    ]);
});

test('exception criteria use only criterion and KФ from the same isolated Sheet row', () => {
    const sheetRows = { active: { '2026-04-01': [
        { sheet: { sheetNet: -20, profitRisk: '-1R', exception: 'Late entry', exceptions: ['Late entry'] } },
        { sheet: { sheetNet: 10, profitRisk: '0,5R', exception: '-', exceptions: ['Chase'] } },
        { sheet: { profitRisk: '2R', exception: 'Shs float <4M; 700K+' } },
        { sheet: { sheetNet: 99, profitRisk: '2R' } },
        { sheet: { sheetNet: 30, exception: 'No KФ' } },
        { sheet: { profitRisk: '-5R', exception: 'No PnL' } },
    ] }, archive: { '2025-12-01': [
        { sheet: { sheetRow: 3, sheetNet: 5, profitRisk: '0,25R', exception: 'Late entry' } },
    ] } };

    const rows = buildExceptionKfRows([], null, { sheetRows });

    assert.deepEqual(new Set(rows.map((row) => row.criterion)), new Set([
        '-', 'Chase', 'Late entry', 'No PnL', 'Shs float <4M', '700K+', 'Shs float <4M; 700K+',
    ]));
    for (const criterion of ['Shs float <4M', '700K+', 'Shs float <4M; 700K+']) {
        assert.deepEqual(rows.find((row) => row.criterion === criterion), {
            criterion, pnl: 0, kf: 2, trades: 1, pnlRows: 0, kfRows: 1, avgKf: 2,
        });
    }
    assert.deepEqual(rows.find((row) => row.criterion === 'Late entry'), {
        criterion: 'Late entry',
        pnl: 0,
        kf: -0.75,
        trades: 2,
        pnlRows: 0,
        kfRows: 2,
        avgKf: -0.38,
    });
    assert.deepEqual(rows.find((row) => row.criterion === 'Chase'), {
        criterion: 'Chase',
        pnl: 0,
        kf: 0.5,
        trades: 1,
        pnlRows: 0,
        kfRows: 1,
        avgKf: 0.5,
    });
    assert.deepEqual(rows.find((row) => row.criterion === '-'), {
        criterion: '-', pnl: 0, kf: 0.5, trades: 1, pnlRows: 0, kfRows: 1, avgKf: 0.5,
    });
    assert.deepEqual(rows.find((row) => row.criterion === 'No PnL'), {
        criterion: 'No PnL', pnl: 0, kf: -5, trades: 1, pnlRows: 0, kfRows: 1, avgKf: -5,
    });
    assert.deepEqual(buildExceptionKfRows([{ data: { trades: [{ sheet: {
        sheetNet: 500, profitRisk: '5R', exception: 'Trades fallback',
    } }] } }]), []);
});

test('google sheet rows enrich existing Trades instead of becoming sheet-only trades', () => {
    const parsed = parseSheetGridToTrades(
        [
            ['1/4/2026', 'AAPL', 'Шорт', '120,50', '1,2R', 'PV ok'],
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
    assert.equal(merged.opened, '2026-04-01 09:47:00');
    assert.equal(merged.type, 'Шорт');
    assert.equal(merged.sheet.profitRisk, '1,2R');
    assert.equal(merged.sheet.matchedBy, 'date+ticker+pnl');
    assert.equal(isPureGoogleSheetTrade(merged), false);
});

test('google sheet-only rows do not invent 09:30 entry time', () => {
    const parsed = parseSheetGridToTrades(
        [
            ['20.06.2026', 'AAPL', '10'],
        ],
        { date: 'A', symbol: 'B', profit: 'C' },
        'sheet-no-time',
        6,
    );

    const sheetOnly = parsed.outByDay['2026-06-20'][0];
    assert.equal(sheetOnly.opened, '');
    assert.equal(sheetOnly.closed, '');

    const grid = collectDatagridRows({
        sheetRows: {
            'sheet-no-time': {
                '2026-06-20': [sheetOnly],
            },
        },
    }, 'sheet-no-time', new Date(2026, 5, 21));
    assert.equal(grid.rows[0].trade.opened, '');
});

test('google sheet import keeps alternating compact dates as separate days', () => {
    const parsed = parseSheetGridToTrades(
        [
            ['06.20', 'AAPL', '10'],
            ['06.21', 'TSLA', '20'],
            ['06.24', 'NVDA', '-5'],
        ],
        {
            date: 'A',
            symbol: 'B',
            profit: 'C',
        },
        'sheet-compact-dates',
        10,
    );

    assert.deepEqual(Object.keys(parsed.outByDay).sort(), ['2026-06-20', '2026-06-21', '2026-06-24']);
    assert.equal(parsed.dateAnchors['2026-06-20'], 10);
    assert.equal(parsed.dateAnchors['2026-06-21'], 11);
    assert.equal(parsed.dateAnchors['2026-06-24'], 12);
});

test('shared Google Sheet merge stores all rows but only updates existing Trades', () => {
    const journal = {
        '2026-04-01': {
            trades: [
                { symbol: 'AAPL', opened: '2026-04-01 09:31:00', net: 10, gross: 10, comm: 0, type: 'Short' },
            ],
            pnl: 10,
            fondexx: { gross: 10, net: 10, comm: 0, locates: 0, tickers: ['AAPL'] },
            ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        },
        '2026-04-02': {
            trades: [],
            fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        },
    };
    const outByDay = {
        '2026-04-01': [
            { symbol: 'AAPL', opened: '2026-04-01 09:30:00', net: 12, type: 'Setup A', sheet: { source: 'google', spreadsheetId: 'sheet-1', pv: 'ok', tradeType: 'Setup A' } },
        ],
        '2026-04-02': [
            { symbol: 'TSLA', opened: '2026-04-02 09:30:00', net: 5, type: 'do not take', sheet: { source: 'google', spreadsheetId: 'sheet-1', tradeType: 'do not take' } },
        ],
    };

    const synced = [];
    const marked = [];
    const sheetRowsStore = {};
    const result = mergeGoogleSheetTradesIntoJournal(journal, outByDay, 'sheet-1', {
        sheetRowsStore,
        syncDayTotals: (dateStr) => synced.push(dateStr),
        markTouched: (dateStr) => marked.push(dateStr),
    });

    assert.equal(result.importedSheetRows, 2);
    assert.equal(result.matchedSheetRows, 1);
    assert.equal(result.skippedSheetRows, 1);
    assert.deepEqual(result.touchedDates, ['2026-04-01']);
    assert.deepEqual(synced, ['2026-04-01']);
    assert.deepEqual(marked, ['2026-04-01']);
    assert.equal(journal['2026-04-01'].trades.length, 1);
    assert.equal(journal['2026-04-01'].trades[0].net, 10);
    assert.equal(journal['2026-04-01'].pnl, 10);
    assert.equal(journal['2026-04-01'].trades[0].type, 'Setup A');
    assert.equal(journal['2026-04-01'].trades[0].sheet.pv, 'ok');
    assert.equal(journal['2026-04-02'].trades.length, 0);
    assert.equal(sheetRowsStore['sheet-1']['2026-04-01'].length, 1);
    assert.equal(sheetRowsStore['sheet-1']['2026-04-01'][0].sheet.matchedTradeIndex, 0);
    assert.equal(sheetRowsStore['sheet-1']['2026-04-02'].length, 1);
    assert.equal(sheetRowsStore['sheet-1']['2026-04-02'][0].symbol, 'TSLA');
    assert.equal(sheetRowsStore['sheet-1']['2026-04-02'][0].type, 'do not take');
});

test('main Google Sheet writes grouped metrics and Gross without replacing net calendar PnL', () => {
    const journal = {};
    const touched = [];
    const result = mergeGoogleSheetTradesIntoJournal(journal, {
        '2026-04-03': [
            { symbol: 'AAPL', net: 25.5, sheet: { source: 'google', sheetNet: 25.5, profitRisk: '1.5R', tradeType: 'синя%' } },
            { symbol: 'TSLA', net: -10, sheet: { source: 'google', sheetNet: -10, profitRisk: '-0.5R', tradeType: 'РПзелена' } },
            { symbol: 'NVDA', net: 999, sheet: { source: 'google', sheetNet: 999, profitRisk: '9R', tradeType: 'не брав' } },
        ],
    }, 'sheet-1', {
        mode: 'main',
        sheetRowsStore: {},
        markTouched: (dateStr) => touched.push(dateStr),
    });

    assert.equal(journal['2026-04-03'].pnl, null);
    assert.equal(journal['2026-04-03'].gross_pnl, 15.5);
    assert.deepEqual(journal['2026-04-03'].tradeTypesData, {
        'Синя': { pnl: 25.5, kf: 1.5 },
        'Зелена': { pnl: -10, kf: -0.5 },
        'Фіолетова': { pnl: '', kf: '' },
        'Візуально': { pnl: '', kf: '' },
    });
    assert.equal(journal['2026-04-03'].sheetGrossSource, 'sheet-1');
    assert.deepEqual(result.syncedPnlDates, ['2026-04-03']);
    assert.ok(touched.includes('2026-04-03'));
});

test('sheet resync removes deleted rows and restores Summary by Date net PnL', () => {
    const journal = {
        '2026-04-03': {
            ...normalizeDayEntry({}),
            pnl: 999,
            gross_pnl: 15.5,
            fondexxSource: 'summary-by-date',
            fondexx: { gross: 30, net: 20, comm: 5, locates: 3, tickers: [] },
            ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            tradeTypesData: { 'Синя': { pnl: 15.5, kf: 1.5 } },
            sheetPnlSource: 'sheet-1',
            sheetGrossSource: 'sheet-1',
            sheetGrossValue: 15.5,
            sheetTradeTypesSource: 'sheet-1',
        },
    };

    mergeGoogleSheetTradesIntoJournal(journal, {}, 'sheet-1', { mode: 'main', sheetRowsStore: {} });

    assert.equal(journal['2026-04-03'].pnl, 17);
    assert.equal(journal['2026-04-03'].gross_pnl, null);
    assert.deepEqual(journal['2026-04-03'].tradeTypesData, {});
    assert.equal(journal['2026-04-03'].sheetPnlSource, undefined);
});

test('sheet resync clears legacy calendar metrics using the previously stored row dates', () => {
    const journal = {
        '2026-04-04': {
            ...normalizeDayEntry({}),
            pnl: 12,
            gross_pnl: 40,
            tradeTypesData: { 'Синя': { pnl: 40, kf: 2 } },
        },
    };
    const sheetRowsStore = {
        'sheet-1': {
            '2026-04-04': [{ sheet: { sheetRow: 10, sheetNet: 40, tradeType: 'синя%' } }],
        },
    };

    mergeGoogleSheetTradesIntoJournal(journal, {}, 'sheet-1', { mode: 'main', sheetRowsStore });

    assert.equal(journal['2026-04-04'].pnl, 12);
    assert.equal(journal['2026-04-04'].gross_pnl, null);
    assert.deepEqual(journal['2026-04-04'].tradeTypesData, {});
});

test('datagrid rows prefer current sheetRows and keep sheet-only rows out of real trade counts', () => {
    const appData = {
        sheetRows: {
            'sheet-1': {
                '2026-04-01': [
                    { symbol: 'AAPL', opened: '2026-04-01 09:30:00', net: 12, type: 'Setup A', sheet: { source: 'google', spreadsheetId: 'sheet-1', matchedTradeIndex: 0 } },
                    { symbol: 'TSLA', opened: '2026-04-01 09:31:00', net: 0, type: 'do not take', sheet: { source: 'google', spreadsheetId: 'sheet-1', tradeType: 'do not take' } },
                ],
            },
            'sheet-2': {
                '2026-05-01': [
                    { symbol: 'MSFT', opened: '2026-05-01 09:30:00', net: 1, type: 'Setup B', sheet: { source: 'google', spreadsheetId: 'sheet-2' } },
                ],
            },
        },
        journal: {
            '2026-04-01': {
                trades: [
                    { symbol: 'AAPL', opened: '2026-04-01 09:30:00', net: 10 },
                    { symbol: 'TSLA', opened: '2026-04-01 09:31:00', net: 0, sheet: { source: 'google', spreadsheetId: 'sheet-1' } },
                ],
            },
        },
    };

    const current = collectDatagridRows(appData, 'sheet-1');
    assert.equal(current.source, 'sheet');
    assert.equal(current.spreadsheetId, 'sheet-1');
    assert.deepEqual(current.rows.map((row) => row.trade.symbol), ['AAPL', 'TSLA']);
    assert.equal(current.rows[0].tradeIndex, 0);
    assert.equal(current.rows[1].tradeIndex, -1);
    assert.equal(visibleTradeRows(appData.journal['2026-04-01'].trades).length, 1);

    const latest = collectDatagridRows(appData);
    assert.equal(latest.spreadsheetId, 'sheet-2');
});

test('datagrid keeps recent main rows and restores older months from cumulative archive', () => {
    const result = collectDatagridRows({
        sheetRows: {
            'sheet-1': {
                '2026-04-30': [
                    { symbol: 'OLD', opened: '2026-04-30 09:30:00', sheet: { source: 'google', spreadsheetId: 'sheet-1' } },
                ],
                '2026-05-01': [
                    { symbol: 'MAY', opened: '2026-05-01 09:30:00', sheet: { source: 'google', spreadsheetId: 'sheet-1' } },
                ],
                '2026-06-17': [
                    { symbol: 'JUN', opened: '2026-06-17 09:30:00', sheet: { source: 'google', spreadsheetId: 'sheet-1' } },
                ],
            },
        },
        cumulativeSheetRows: {
            'archive-1': {
                '2025-01-01': [
                    { symbol: 'ARCHIVE', opened: '2025-01-01 09:30:00', sheet: { source: 'google', spreadsheetId: 'archive-1' } },
                ],
            },
        },
    }, 'sheet-1', new Date(2026, 5, 17));

    assert.equal(result.source, 'sheet');
    assert.deepEqual(result.rows.map((row) => row.trade.symbol), ['ARCHIVE', 'MAY', 'JUN']);
});

test('datagrid rows fall back to real Trades when no sheetRows exist', () => {
    const result = collectDatagridRows({
        journal: {
            '2026-04-01': {
                trades: [
                    { symbol: 'AAPL', opened: '2026-04-01 09:30:00', net: 10 },
                    { symbol: 'TSLA', opened: '2026-04-01 09:31:00', net: 0, sheet: { source: 'google', spreadsheetId: 'sheet-1' } },
                ],
            },
        },
    });

    assert.equal(result.source, 'trades');
    assert.deepEqual(result.rows.map((row) => row.trade.symbol), ['AAPL']);
});

test('cumulative sheet import stores invisible rows and enriches only existing Trades', () => {
    const journal = {
        '2026-01-10': {
            pnl: 25,
            trades: [
                { symbol: 'AAPL', opened: '2026-01-10 09:31:00', net: 25, gross: 30, comm: 5, type: 'Short' },
            ],
            fondexx: { gross: 30, net: 25, comm: 5, locates: 0, tickers: ['AAPL'] },
            ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        },
        '2026-01-11': {
            pnl: null,
            trades: [],
            fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        },
    };
    const cumulativeSheetRows = {};
    const result = mergeGoogleSheetTradesIntoJournal(journal, {
        '2026-01-10': [
            { symbol: 'AAPL', opened: '2026-01-10 09:30:00', net: 26, type: 'Archive Setup', sheet: { source: 'google', spreadsheetId: 'archive-1', sheetRow: 12, tradeType: 'Archive Setup', pv: 'old-ok' } },
        ],
        '2026-01-11': [
            { symbol: 'TSLA', opened: '2026-01-11 09:30:00', net: 5, type: 'Archive Only', sheet: { source: 'google', spreadsheetId: 'archive-1', sheetRow: 13, tradeType: 'Archive Only' } },
        ],
    }, 'archive-1', {
        mode: 'cumulative',
        sheetRowsStore: cumulativeSheetRows,
    });

    assert.equal(result.importedSheetRows, 2);
    assert.equal(result.matchedSheetRows, 1);
    assert.equal(result.skippedSheetRows, 1);
    assert.equal(journal['2026-01-10'].trades.length, 1);
    assert.equal(journal['2026-01-10'].trades[0].net, 25);
    assert.equal(journal['2026-01-10'].pnl, 25);
    assert.equal(journal['2026-01-10'].trades[0].type, 'Archive Setup');
    assert.equal(journal['2026-01-10'].trades[0].sheet.pv, 'old-ok');
    assert.equal(journal['2026-01-11'].trades.length, 0);
    assert.equal(cumulativeSheetRows['archive-1']['2026-01-11'][0].symbol, 'TSLA');

    const grid = collectDatagridRows({ journal, cumulativeSheetRows });
    assert.equal(grid.source, 'sheet');
    assert.deepEqual(grid.rows.map((row) => row.trade.symbol), ['AAPL', 'TSLA']);
});

test('main sheet context wins over cumulative overlap', () => {
    const journal = {
        '2026-04-01': {
            pnl: 10,
            trades: [
                {
                    symbol: 'AAPL',
                    opened: '2026-04-01 09:31:00',
                    net: 10,
                    type: 'Main Setup',
                    sheet: { source: 'google', spreadsheetId: 'main-1', matchedBy: 'date+ticker+pnl', tradeType: 'Main Setup', pv: 'main' },
                },
            ],
        },
    };
    const cumulativeSheetRows = {};
    const result = mergeGoogleSheetTradesIntoJournal(journal, {
        '2026-04-01': [
            { symbol: 'AAPL', opened: '2026-04-01 09:30:00', net: 11, type: 'Archive Setup', sheet: { source: 'google', spreadsheetId: 'archive-1', sheetRow: 99, tradeType: 'Archive Setup', pv: 'archive' } },
        ],
    }, 'archive-1', {
        mode: 'cumulative',
        sheetRowsStore: cumulativeSheetRows,
    });

    assert.equal(result.matchedSheetRows, 0);
    assert.equal(result.skippedSheetRows, 1);
    assert.equal(journal['2026-04-01'].trades[0].type, 'Main Setup');
    assert.equal(journal['2026-04-01'].trades[0].sheet.pv, 'main');
    assert.equal(cumulativeSheetRows['archive-1']['2026-04-01'][0].sheet.matchedTradeIndex, undefined);
});

test('duplicating sheet mapping copies columns and anchors but not source file', () => {
    const duplicated = duplicateSheetMappingConfig(
        {
            version: 5,
            spreadsheetId: 'main-file',
            sheetTitle: 'Current',
            selectedFileName: 'Main',
            smartColumns: { date: 'A', symbol: 'B', tradeType: 'C' },
            smartAnchors: { date: 'A8', symbol: 'B8' },
            dataStartRow: 8,
        },
        {
            spreadsheetId: 'archive-file',
            sheetTitle: 'Archive',
            selectedFileName: 'Archive',
            smartColumns: { date: 'D' },
        },
    );

    assert.equal(duplicated.spreadsheetId, 'archive-file');
    assert.equal(duplicated.sheetTitle, 'Archive');
    assert.deepEqual(duplicated.smartColumns, { date: 'A', symbol: 'B', tradeType: 'C' });
    assert.deepEqual(duplicated.smartAnchors, { date: 'A8', symbol: 'B8' });
    assert.equal(duplicated.dataStartRow, 8);
});

test('cumulative archive schedule is due only once per month with a 1-5 day window', () => {
    assert.deepEqual(getCumulativeArchiveSchedule({}, new Date(2026, 7, 3)), {
        currentMonth: '2026-08', synced: false, inRecommendedWindow: true, overdue: false, day: 3,
    });
    assert.equal(getCumulativeArchiveSchedule({ month: '2026-08' }, new Date(2026, 7, 5)).synced, true);
    const late = getCumulativeArchiveSchedule({ month: '2026-07' }, new Date(2026, 7, 6));
    assert.equal(late.synced, false);
    assert.equal(late.inRecommendedWindow, false);
    assert.equal(late.overdue, true);
});

test('exact sheet automapping matches specified headers and starts at first ticker row', () => {
    const grid = [
        [],
        [
            'дата',
            'Ticker',
            'Тип угоди',
            'Профіт факт',
            'профіт в ризиках',
            'PV=PV',
            'Класифікація',
            'Alt PV',
            'Коментар\nтрейдера',
            '',
            'Коментар\nTEAMleader',
            'Тип бумаги',
            'Перiод',
            'Виросла.%',
            'Ризик в дол. на трейд',
            'Консол.в цц.',
            'Цiна входу  (нижня границя консолідації)',
            'Скільки шер брав',
            'Розрахункова к-ть шер',
        ],
        [],
        [],
        [],
        ['2026-07-01', 'BRK.B', 'Long', '10', '1R', 'так', 'немає', '', '', 'стоп', '', '', '', '', '', '', '', '', ''],
    ];
    const result = detectExactSheetAutoMapping(grid);

    assert.equal(result.ok, true);
    assert.equal(result.startRow, 6);
    assert.deepEqual(result.mapped, {
        date: 0,
        symbol: 1,
        tradeType: 2,
        profit: 3,
        profitRisk: 4,
        pv: 5,
        exceptions: 6,
        altPv: 7,
        traderComment: 8,
        teamLeadComment: 10,
        paperType: 11,
        period: 12,
        growthPct: 13,
        riskUsd: 14,
        consolidateCents: 15,
        entryPrice: 16,
        qtyShares: 17,
        qtySharesCalc: 18,
        exit: 9,
    });
});

test('exact sheet automapping normalizes whitespace but rejects broad aliases', () => {
    assert.equal(normalizeExactSheetHeader('  Коментар\n  TEAMleader  '), 'коментар teamleader');
    const result = detectExactSheetAutoMapping([
        ['Date', 'Ticker Symbol', 'type', 'risk', 'comment', 'symbol'],
        ['2026-07-01', 'AAPL', 'Long', '1R', 'note', 'AAPL'],
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ticker-header-not-found');
});

test('exact sheet automapping maps exception phrase and explicit exit header', () => {
    const result = detectExactSheetAutoMapping([
        ['Ticker', 'Детально: в чому виключення сьогодні', 'Вихід з позиції'],
        ['', '', ''],
        ['TSLA', 'немає', 'по часу'],
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.startRow, 3);
    assert.equal(result.mapped.exceptions, 1);
    assert.equal(result.mapped.exit, 2);
});

test('exact sheet automapping detects trade type column from approved values', () => {
    const result = detectExactSheetAutoMapping([
        ['Ticker', 'Невідомий заголовок', 'Класифікація'],
        ['AAPL', '  ШОРТ  ', 'виключення'],
        ['TSLA', 'не брав свій підхід', 'виключення'],
        ['NVDA', 'СИСТ-виключення не брав', 'виключення'],
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.mapped.tradeType, 1);
    assert.equal(result.mapped.exceptions, 2);
});

test('sheet mapping relocates its data row after rows are inserted or the old first trade changes', () => {
    const grid = [
        ['Новий службовий рядок'],
        ['Ще один вставлений рядок'],
        ['Дата', 'Ticker', 'Профіт факт', 'профіт в ризиках'],
        ['', '', '', ''],
        ['01/08/2026', 'AAPL', '25', '1R'],
    ];
    const relocated = relocateSheetDataStartRow(grid, 3);
    assert.equal(relocated.startRow, 5);
    assert.equal(relocated.moved, true);

    grid[4][1] = '';
    grid.push(['02/08/2026', 'TSLA', '-10', '-0.5R']);
    assert.equal(relocateSheetDataStartRow(grid, 5).startRow, 6);
});

test('explicit trade type header has priority over value-based detection', () => {
    const result = detectExactSheetAutoMapping([
        ['Ticker', 'Тип угоди', 'Інша колонка'],
        ['AAPL', '', 'шорт'],
        ['TSLA', '', 'памп-лонг'],
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.mapped.tradeType, 1);
});

test('legacy Classification mapping migrates from trade type to exceptions', () => {
    const result = migrateLegacyClassificationMapping({
        version: 5,
        smartColumns: { symbol: 'A', tradeType: 'B, C', exceptions: '' },
        smartAnchors: { tradeType: 'B6' },
    }, ['Ticker', 'Класифікація', 'Тип угоди']);
    assert.equal(result.changed, true);
    assert.equal(result.config.smartColumns.tradeType, 'C');
    assert.equal(result.config.smartColumns.exceptions, 'B');
    assert.equal(result.config.smartAnchors.tradeType, undefined);
    assert.equal(result.config.smartAnchors.exceptions, 'B6');
});

test('legacy Classification migration uses live headers and preserves existing exceptions', () => {
    const result = migrateLegacyClassificationMapping({
        smartColumns: { tradeType: 'D', exceptions: 'F' },
        smartAnchors: {},
    }, ['Ticker', '', '', 'Класифікація', '', 'У чому виключення']);
    assert.equal(result.changed, true);
    assert.equal(result.config.smartColumns.tradeType, '');
    assert.equal(result.config.smartColumns.exceptions, 'F, D');
});

test('failed ticker data detection does not return a partial mapping', () => {
    const result = detectExactSheetAutoMapping([
        ['дата', 'Ticker', 'Профіт факт'],
        ['2026-07-01', '', '10'],
        ['2026-07-02', '12345', '12'],
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ticker-data-not-found');
    assert.deepEqual(result.mapped, {});
});

test('service bot range parser supports date, inferred days, and max range', () => {
    assert.deepEqual(parseServiceBotRange({ date: '2026-06-24' }, '2026-06-25'), {
        start: '2026-06-24',
        end: '2026-06-24',
        days: 1,
    });
    assert.deepEqual(parseServiceBotRange({ days: '3' }, '2026-06-25'), {
        start: '2026-06-23',
        end: '2026-06-25',
        days: 3,
    });
    assert.deepEqual(parseServiceBotRange({ start: '2026-06-01', end: '2026-06-03' }, ''), {
        start: '2026-06-01',
        end: '2026-06-03',
        days: 3,
    });
    assert.throws(() => parseServiceBotRange({ start: '2026-06-01', end: '2026-07-10' }, ''), /Max range/);
});

test('service bot permission accepts explicit endpoint, star, and all only', () => {
    assert.equal(hasServiceBotPermission({ extra_data: { allowed_endpoints: ['api_service_snapshot_read'] } }), true);
    assert.equal(hasServiceBotPermission({ extra_data: { allowed_endpoints: ['*'] } }), true);
    assert.equal(hasServiceBotPermission({ extra_data: { allowed_endpoints: ['all'] } }), true);
    assert.equal(hasServiceBotPermission({ extra_data: { allowed_endpoints: ['other'] } }), false);
});

test('service bot API keys are stored as deterministic SHA-256 hashes', () => {
    const key = 'shs_service_example_secret';
    const hash = hashServiceBotApiKey(key);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash, hashServiceBotApiKey(key));
    assert.notEqual(hash, key);
    assert.notEqual(hash, hashServiceBotApiKey(`${key}x`));
});

test('service bot snapshot aggregates real and matched trades but skips pure sheet rows', () => {
    const snapshot = buildServiceBotSnapshot([
        {
            trade_date: '2026-06-24',
            locates: 12.5,
            daily_metrics: {
                trades: [
                    { symbol: 'AAPL', qty: 100, gross: 30, comm: 2, net: 28, opened: '2026-06-24 09:31:00', exchange: 'NYSE' },
                    { symbol: 'TSLA', qty: 50, gross: -10, comm: 1, net: -11, opened: '2026-06-24 09:45:00', demo: true, sheet: { source: 'google', matchedBy: 'date+ticker+pnl' } },
                    { symbol: 'MSFT', qty: 10, gross: 5, comm: 0, net: 5, sheet: { source: 'google' } },
                ],
            },
        },
    ], { start: '2026-06-24', end: '2026-06-24', days: 1 });

    assert.equal(snapshot.tickers.summary.total_events, 2);
    assert.equal(snapshot.tickers.summary.unique_count, 2);
    assert.deepEqual(snapshot.tickers.top.map((row) => row.symbol).sort(), ['AAPL', 'TSLA']);
    assert.equal(snapshot.orders.summary.total, 2);
    assert.equal(snapshot.orders.summary.requested_size, 150);
    assert.equal(snapshot.orders.summary.demo_count, 1);
    assert.equal(snapshot.locates.summary.total, 1);
    assert.equal(snapshot.locates.summary.total_price, 12.5);
});

test('service bot snapshot derives orders from broker and day totals when trades are empty', () => {
    const snapshot = buildServiceBotSnapshot([
        {
            user_id: 'u1',
            trade_date: '2026-06-24',
            pnl: 90,
            gross_pnl: 100,
            commissions: 10,
            locates: 0,
            daily_metrics: {
                trades: [],
                fondexx: { gross: 100, net: 90, comm: 10, locates: 0, tickers: ['AAPL', 'TSLA'] },
                ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            },
        },
        {
            user_id: 'u2',
            trade_date: '2026-06-25',
            pnl: -25,
            gross_pnl: -20,
            commissions: 5,
            locates: 0,
            daily_metrics: { trades: [], traded_tickers: [] },
        },
    ], { start: '2026-06-24', end: '2026-06-25', days: 2 });

    assert.equal(snapshot.orders.summary.total, 3);
    assert.equal(snapshot.tickers.summary.unique_count, 3);
    assert.equal(snapshot.orders.items[0].derived, true);
    assert(snapshot.orders.items.some((item) => item.symbol === 'JOURNAL_TOTAL'));
});

test('service bot snapshot can be restricted to ppro source only', () => {
    const snapshot = buildServiceBotSnapshot([
        {
            user_id: 'u1',
            trade_date: '2026-06-24',
            pnl: 70,
            gross_pnl: 100,
            commissions: 30,
            locates: 0,
            daily_metrics: {
                trades: [{ symbol: 'SHOULD_SKIP', qty: 1, net: 1 }],
                fondexx: { gross: 50, net: 40, comm: 10, locates: 0, tickers: ['FDXX'] },
                ppro: { gross: 30, net: 25, comm: 5, locates: 0, tickers: ['PPRO'] },
            },
        },
    ], { start: '2026-06-24', end: '2026-06-24', days: 1 }, { data_source: 'ppro' });

    assert.equal(snapshot.orders.summary.total, 1);
    assert.equal(snapshot.orders.items[0].symbol, 'PPRO');
    assert.equal(snapshot.orders.items[0].derived_source, 'daily_metrics.ppro');
    assert.equal(snapshot.orders.items.some((item) => item.symbol === 'FDXX'), false);
});
