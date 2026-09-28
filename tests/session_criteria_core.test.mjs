import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExceptionKfRows } from '../js/stats_sheet_metrics.js';
import { pickSessionCriteriaHints, sessionCriteriaDateMatches } from '../js/session_criteria_core.js';

test('two-month window includes the anchor day and the same day two months earlier', () => {
    const matches = sessionCriteriaDateMatches('2026-09-28', 2);
    assert.equal(matches('2026-07-27'), false);
    assert.equal(matches('2026-07-28'), true);
    assert.equal(matches('2026-09-28'), true);
    assert.equal(matches('2026-09-29'), false);
    assert.equal(matches('not-a-date'), false);
});

test('month shift clamps to the last day of a shorter month', () => {
    const matches = sessionCriteriaDateMatches('2026-03-31', 1);
    assert.equal(matches('2026-02-28'), true);
    assert.equal(matches('2026-03-01'), true);
    assert.equal(matches('2026-03-31'), true);
    assert.equal(matches('2026-02-27'), false);
});

test('session hints are the first two and last two bars of the analytics chart', () => {
    const rows = [
        { criterion: 'ORB', kf: 4.2, trades: 3 },
        { criterion: 'Sweep', kf: 6.1, trades: 2 },
        { criterion: 'Gap', kf: 1.4, trades: 9 },
        { criterion: 'Late', kf: -5.5, trades: 4 },
        { criterion: 'News', kf: -2.2, trades: 6 },
        { criterion: 'Chase', kf: -0.4, trades: 8 },
        { criterion: 'ORB; Sweep', kf: 12, trades: 2 },
        { criterion: '-', kf: 32, trades: 1 },
        { criterion: 'Flat', kf: 0, trades: 5 },
        { criterion: '700K+; Shs float<1M', kf: -18, trades: 4 },
        { criterion: 'Shs float<1M', kf: -22, trades: 6 },
    ];
    const hints = pickSessionCriteriaHints(rows, 2);
    assert.deepEqual(hints.strong.map((row) => row.criterion), ['-', 'ORB; Sweep']);
    assert.deepEqual(hints.avoid.map((row) => row.criterion), ['700K+; Shs float<1M', 'Shs float<1M']);
});

test('hints use the same criterion КФ as analytics, limited to two months', () => {
    const sheetRows = {
        book: {
            '2026-07-27': [{ sheet: { sheetRow: 1, exceptions: 'Старий', profitRisk: '9' } }],
            '2026-08-10': [
                { sheet: { sheetRow: 2, exceptions: 'Sweep', profitRisk: '3.5' } },
                { sheet: { sheetRow: 3, exceptions: 'Sweep; Late', profitRisk: '1' } },
            ],
            '2026-09-02': [
                { sheet: { sheetRow: 4, exceptions: 'Late', profitRisk: '-4' } },
                { sheet: { sheetRow: 5, exception: 'News', profitRisk: '-1.5' } },
            ],
            '2026-09-20': [{ sheet: { sheetRow: 6, exceptions: ['ORB', 'Late'], profitRisk: '2' } }],
        },
    };
    const rows = buildExceptionKfRows([], null, {
        sheetRows,
        dateMatches: sessionCriteriaDateMatches('2026-09-28', 2),
    });
    const byName = Object.fromEntries(rows.map((row) => [row.criterion, row]));
    assert.equal(byName['Старий'], undefined);
    assert.equal(byName.Sweep.kf, 4.5);
    assert.equal(byName.Late.kf, -1);
    const hints = pickSessionCriteriaHints(rows, 2);
    assert.deepEqual(hints.strong.map((row) => row.criterion), ['Sweep', 'Late; ORB']);
    assert.deepEqual(hints.avoid.map((row) => row.criterion), ['Late', 'News']);
});
