import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStopReviewCandidates, googleDriveFileId, isStopExitReason, normalizeStopExitReason } from '../js/stop_review_core.js';
import { calculateJournalScore, isJournalActivityDay } from '../js/journal_score_core.js';

test('normalizes and recognizes only the stop exit reason', () => {
    assert.equal(normalizeStopExitReason('  СтОп  '), 'стоп');
    assert.equal(isStopExitReason('СТОП'), true);
    assert.equal(isStopExitReason(' тейк '), false);
    assert.equal(isStopExitReason('по часу'), false);
    assert.equal(isStopExitReason(''), false);
});

test('groups stop trades and OCR screenshots by date and ticker', () => {
    const appData = {
        tickers: { 'screenshots/a.png': 'tsla', 'screenshots/b.png': 'TSLA', 'screenshots/c.png': 'NVDA' },
        sheetRows: {
            sheetA: {
                '2026-07-10': [
                    { symbol: 'TSLA', net: -40, stop: 320, type: 'Short', sheet: { exit: ' Стоп ', sheetRow: 21 } },
                    { symbol: 'tsla', net: -25, stop: 321, type: 'Short', sheet: { exit: 'СТОП', sheetRow: 22 } },
                    { symbol: 'NVDA', net: 50, sheet: { exit: 'тейк', sheetRow: 23 } },
                ],
            },
        },
        journal: {
            '2026-07-10': {
                screenshots: { good: ['screenshots/a.png'], normal: [], bad: ['screenshots/b.png'], error: ['screenshots/c.png'] },
                trades: [],
            },
        },
    };
    const rows = buildStopReviewCandidates(appData, '2026-07-01', '2026-07-31');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, 'TSLA');
    assert.equal(rows[0].trade_refs.length, 2);
    assert.deepEqual(rows[0].screenshot_paths, ['screenshots/a.png', 'screenshots/b.png']);
});

test('keeps a stop candidate even when no OCR screenshot is available', () => {
    const rows = buildStopReviewCandidates({
        sheetRows: {
            sheetA: {
                '2026-07-11': [{ symbol: 'AMD', net: -10, sheet: { exit: 'стоп' } }],
            },
        },
        journal: {
            '2026-07-11': {
                trades: [],
                screenshots: { good: ['screenshots/unknown.png'] },
            },
        },
        tickers: {},
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].screenshot_paths, []);
});

test('does not use Trades as a stop source when the sheet has no matching row', () => {
    const rows = buildStopReviewCandidates({
        sheetRows: { sheetA: { '2026-07-12': [{ symbol: 'TSLA', sheet: { exit: 'тейк' } }] } },
        journal: {
            '2026-07-12': {
                trades: [{ symbol: 'AMD', net: -50, sheet: { exit: 'стоп' } }],
            },
        },
    });
    assert.deepEqual(rows, []);
});

test('does not use Trades as a stop source when table rows are absent', () => {
    const rows = buildStopReviewCandidates({
        journal: {
            '2026-07-12': {
                trades: [{ symbol: 'AMD', net: -50, sheet: { exit: 'стоп' } }],
                screenshots: { bad: ['screenshots/AMD-stop.png'] },
            },
        },
        tickers: { 'screenshots/AMD-stop.png': 'AMD' },
    });
    assert.deepEqual(rows, []);
});

test('matches same-day stop screenshots by ticker tag or filename', () => {
    const rows = buildStopReviewCandidates({
        sheetRows: { sheetA: { '2026-07-14': [{ symbol: 'MULN', sheet: { exit: 'стоп' } }] } },
        journal: {
            '2026-07-14': { screenshots: { good: ['screenshots/chart-one.png'], bad: ['screenshots/MULN-entry.png'] } },
        },
        screenTags: { 'screenshots/chart-one.png': ['MULN'] },
    });
    assert.deepEqual(rows[0].screenshot_paths, ['screenshots/chart-one.png', 'screenshots/MULN-entry.png']);
});

test('links a sheet ticker hyperlink to a synced Drive screenshot without OCR', () => {
    const driveId = '1AbC_example-file-id';
    const path = 'screenshots/user/chart.png';
    const rows = buildStopReviewCandidates({
        sheetRows: {
            sheetA: {
                '2026-07-13': [{
                    symbol: 'META',
                    net: -30,
                    sheet: { exit: 'стоп', screenshotUrl: `https://drive.google.com/file/d/${driveId}/view` },
                }],
            },
        },
        journal: { '2026-07-13': { screenshots: { good: [], normal: [], bad: [], error: [] } } },
        unassignedImages: [path],
        screenMeta: { [path]: { driveId } },
        tickers: {},
    });
    assert.deepEqual(rows[0].screenshot_paths, [path]);
    assert.equal(rows[0].trade_refs[0].screenshotUrl, `https://drive.google.com/file/d/${driveId}/view`);
    assert.equal(googleDriveFileId(`https://drive.google.com/open?id=${driveId}`), driveId);
});

test('extracts Drive ids from supported sheet link formats', () => {
    assert.equal(googleDriveFileId('https://drive.google.com/uc?id=18UpVEcD0zAZWe0mv_MCln-n_Ictin_v6'), '18UpVEcD0zAZWe0mv_MCln-n_Ictin_v6');
    assert.equal(googleDriveFileId('https://drive.google.com/file/d/1X3sjg_bqpcmpEGouj-ocEzc0alfQJikc/view?usp=drivesdk'), '1X3sjg_bqpcmpEGouj-ocEzc0alfQJikc');
});

test('journal score ignores completely untouched days', () => {
    assert.equal(isJournalActivityDay({ pnl: 0, trades: [] }), false);
    assert.equal(calculateJournalScore({ journal: { '2026-07-01': { pnl: 0, trades: [] } } }).score, null);
});

test('daily journal work has more weight than learning', () => {
    const journal = {
        '2026-07-01': {
            notes: 'Підсумок дня',
            nextSessionImprovement: 'Чекати підтвердження',
            sessionGoal: 'Торгувати план',
            sessionReadiness: 8,
            sessionReviewDone: true,
            checkedParams: ['plan'],
            trades: [{ net: -10 }],
            screenshots: { good: ['one.png'] },
        },
    };
    const withoutLearning = calculateJournalScore({ journal, now: new Date('2026-07-15T12:00:00Z') });
    const withLearning = calculateJournalScore({
        journal,
        learnCache: { date: '2026-07-01', summaries: { video: 'Конспект' } },
        now: new Date('2026-07-15T12:00:00Z'),
    });
    assert.equal(withLearning.score - withoutLearning.score, 1);
    assert.ok(withoutLearning.score >= 7);
});

test('journal score uses only current month and prioritizes PnL plus daily thought', () => {
    const result = calculateJournalScore({
        now: new Date('2026-08-20T12:00:00Z'),
        journal: {
            '2026-07-31': { pnl: 500, notes: 'Старий місяць', sessionGoal: 'План', sessionDone: true },
            '2026-08-04': { gross_pnl: 120, notes: 'Головний висновок дня' },
        },
    });
    assert.equal(result.activeDays, 1);
    assert.equal(result.score, 6);
    assert.equal(result.gaps[0].label, 'Початок сесії');
});
