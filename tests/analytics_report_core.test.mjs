import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAnalyticsReportData,
    dateMatchesReportPeriod,
    makeAnalyticsPdfFilename,
    summarizeReportPeriod,
    validateAnalyticsExportConfig,
} from '../js/analytics_report_core.js';

const journal = {
    '2026-07-01': { pnl: 100, commissions: 5, locates: 2, errors: ['FOMO'], trades: [{ ticker: 'ABC', net: 100, type: 'Short' }] },
    '2026-07-02': { pnl: -40, commissions: 4, locates: 1, errors: ['FOMO', 'Late'], trades: [{ ticker: 'XYZ', net: -40, type: 'Short' }] },
    '2026-08-03': { pnl: 80, commissions: 3, locates: 0, trades: [] },
};

test('report periods match year, month, week and custom ranges', () => {
    assert.equal(dateMatchesReportPeriod('2026-07-02', { type: 'year', value: '2026' }), true);
    assert.equal(dateMatchesReportPeriod('2026-08-02', { type: 'month', value: '2026-07' }), false);
    assert.equal(dateMatchesReportPeriod('2026-07-05', { type: 'week', from: '2026-06-29' }), true);
    assert.equal(dateMatchesReportPeriod('2026-07-02', { type: 'custom', from: '2026-07-01', to: '2026-07-31' }), true);
});

test('period summary calculates KPI, drawdown, costs, errors and trades', () => {
    const report = summarizeReportPeriod({ journal, period: { type: 'month', value: '2026-07' } });
    assert.equal(report.kpis.totalPnl, 60);
    assert.equal(report.kpis.tradeDays, 2);
    assert.equal(report.kpis.winRate, 50);
    assert.equal(report.kpis.profitFactor, 2.5);
    assert.equal(report.kpis.maxDrawdown, 40);
    assert.equal(report.kpis.commissions, 9);
    assert.equal(report.kpis.locates, 3);
    assert.equal(report.errors[0].label, 'FOMO');
    assert.equal(report.trades.length, 2);
});

test('report builder keeps periods separate and produces comparisons', () => {
    const config = {
        periods: [
            { id: 'jul', type: 'month', value: '2026-07' },
            { id: 'aug', type: 'month', value: '2026-08' },
        ],
        sections: { kpis: true },
    };
    const report = buildAnalyticsReportData(config, [{ label: 'Trader', journal }]);
    assert.equal(report.groups[0].periods.length, 2);
    assert.equal(report.groups[0].comparison.length, 1);
    assert.equal(report.groups[0].comparison[0].totalPnl, 20);
});

test('config validation rejects missing periods and sections', () => {
    assert.equal(validateAnalyticsExportConfig({ periods: [], sections: { cover: true } }).valid, false);
    assert.equal(validateAnalyticsExportConfig({ periods: [{ type: 'custom', from: '', to: '' }], sections: { cover: true } }).valid, false);
    assert.equal(validateAnalyticsExportConfig({ periods: [{ type: 'all' }], sections: {} }).valid, false);
});

test('filename is deterministic and privacy aware', () => {
    const filename = makeAnalyticsPdfFilename(
        { periods: [{ type: 'month', value: '2026-07' }], identity: { nick: true } },
        { nick: 'trader' },
        new Date('2026-07-26T10:00:00Z'),
    );
    assert.match(filename, /^analytics_trader_2026-07_2026-07-26\.pdf$/);
});
