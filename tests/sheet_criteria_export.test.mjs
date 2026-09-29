import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedDateTimeToUtcMs } from '../lib/massive_criteria.js';
import {
    activityChoice,
    buildCellUpdates,
    carrySheetDates,
    composeCriteriaValues,
    dayPositionLabel,
    assignEntryTrades,
    deriveSheetMarket,
    premarketVolumeUntil,
    detectHeaderColumns,
    entryTimeBucket,
    isEligibleCriteriaDate,
    movePlayed,
    tradingDate,
    scoreCompletedSession,
    selectExportRows,
    toMillions,
    vwapSide,
} from '../lib/sheet_criteria_export.js';

const noon = zonedDateTimeToUtcMs('2026-09-29', '12:00:00');

test('criteria export includes today and skips yesterday in New York', () => {
    assert.equal(isEligibleCriteriaDate('2026-09-27', noon), true);
    assert.equal(isEligibleCriteriaDate('2026-09-28', noon), false);
    assert.equal(isEligibleCriteriaDate('2026-09-29', noon), true);
    assert.equal(isEligibleCriteriaDate('2026-09-30', noon), false);
    assert.equal(isEligibleCriteriaDate('BKYI', noon), false);
});

test('sheet dates stay on the following ticker rows', () => {
    assert.deepEqual(carrySheetDates([null, '2026-09-27', null, '2026-09-25']), [
        null,
        '2026-09-27',
        '2026-09-27',
        '2026-09-25',
    ]);
});

test('header detection uses Потенціал and skips the coefficient column', () => {
    const grid = [
        ['Дата', 'коеф.', 'Ticker', '', 'VolPre(Вхід)', 'SHRFloat', 'ATR', 'ATRPlay', 'AVGVol', 'Vol', 'VolPlay', 'Потенціал', 'Потенціал'],
        ['', '', '', '', 'm', 'm', '', '', 'm', 'm', '', '', 'КФ'],
        [],
        [],
        ['Дата', '', 'Ticker', '', '', '', '', '', '', '', '', '', '', '', 'Актив Пост', 'Актив Ранній', 'VWAP', 'TIME', 'Day Pos', 'Цiна входу', 'Сходила'],
    ];
    const columns = detectHeaderColumns(grid);
    assert.equal(columns.date, 'A');
    assert.equal(columns.ticker, 'C');
    assert.equal(columns.volPre, 'E');
    assert.equal(columns.shrFloat, 'F');
    assert.equal(columns.atr, 'G');
    assert.equal(columns.atrPlay, 'H');
    assert.equal(columns.avgVol, 'I');
    assert.equal(columns.vol, 'J');
    assert.equal(columns.volPlay, 'K');
    assert.equal(columns.potential, 'L');
    assert.equal(columns.activePost, 'O');
    assert.equal(columns.activeEarly, 'P');
    assert.equal(columns.vwap, 'Q');
    assert.equal(columns.time, 'R');
    assert.equal(columns.dayPos, 'S');
    assert.equal(columns.entry, 'T');
});

test('volumes become millions and the activity checkbox is exclusive', () => {
    assert.equal(toMillions(585_000), 0.585);
    assert.equal(toMillions(270_000), 0.27);
    assert.equal(activityChoice(2_000_000, 2_000_000), 'post');
    assert.equal(activityChoice(1_500_000, 1_000_000), 'early');
    assert.equal(activityChoice(100, 999_999), null);
    assert.equal(vwapSide(4, 5), 'Під');
    assert.equal(vwapSide(5, 5), 'Над');
    assert.equal(dayPositionLabel(1, 4, 1), 'Low');
    assert.equal(dayPositionLabel(2.5, 4, 1), 'Balance');
    assert.equal(dayPositionLabel(3.5, 4, 1), 'High');
});

test('entry hour is 4 through 9 and market fields use the previous session', () => {
    const entryMs = zonedDateTimeToUtcMs('2026-09-27', '05:30:00');
    assert.equal(entryTimeBucket(entryMs), '4 - 6');
    assert.equal(entryTimeBucket(zonedDateTimeToUtcMs('2026-09-27', '06:15:00')), '06:00');
    assert.equal(entryTimeBucket(zonedDateTimeToUtcMs('2026-09-27', '09:05:00')), '09:00');
    assert.equal(entryTimeBucket(zonedDateTimeToUtcMs('2026-09-27', '10:00:00')), null);
    const market = deriveSheetMarket({
        tradeDate: '2026-09-27',
        entryMs,
        dailyBars: [
            { t: zonedDateTimeToUtcMs('2026-09-25', '00:00:00'), c: 4.2, v: 100_000 },
            { t: zonedDateTimeToUtcMs('2026-09-26', '00:00:00'), c: 3.5, v: 1_200_000 },
            { t: zonedDateTimeToUtcMs('2026-09-27', '00:00:00'), c: 1.25, h: 2, l: 1, v: 9_000_000 },
        ],
        minuteBars: [
            { t: zonedDateTimeToUtcMs('2026-09-26', '16:10:00'), v: 2_000_000, c: 3.4, h: 3.6, l: 3.3 },
            { t: zonedDateTimeToUtcMs('2026-09-27', '04:00:00'), v: 100_000, c: 4, h: 4.2, l: 3.8 },
            { t: zonedDateTimeToUtcMs('2026-09-27', '05:00:00'), v: 100_000, c: 6, h: 6.2, l: 5.8 },
            { t: zonedDateTimeToUtcMs('2026-09-27', '05:30:00'), v: 100_000, c: 8, h: 8, l: 7 },
        ],
    });
    assert.equal(market.previousClose, 3.5);
    assert.equal(market.previousVolume, 1_200_000);
    assert.equal(market.sessionClose, 1.25);
    assert.equal(market.postVolume, 2_000_000);
    assert.equal(market.earlyVolume, 300_000);
    assert.equal(market.vwap, 5);
    assert.equal(market.high, 6.2);
    assert.equal(market.low, 3.8);
    const values = composeCriteriaValues({
        atr14: 0.64,
        atrPlay14: 3.75,
        avgVol14: 270_000,
        dayVolume: 585_000,
        volPlay14: 2.17,
        floatShares: 560_000,
        entryMs,
        entryPrice: 4,
        ...market,
    });
    assert.equal(values.volPre, 0.2);
    assert.equal(market.premarketVolume, 200_000);
    assert.equal(values.vol, 0.585);
    assert.equal(values.atrPlay, 3.8);
    assert.equal(values.avgVol, 0.27);
    assert.equal(values.shrFloat, 0.56);
    assert.equal(values.atr, 0.64);
    assert.equal(values.volPlay, 2.2);
    assert.equal(values.potential, 3.5);
    assert.equal(values.vwap, 'Під');
    assert.equal(values.time, '4 - 6');
    assert.equal(values.dayPos, 'Low');
    assert.equal(values.activePost, true);
    assert.equal(values.activeEarly, null);
});

test('writes skip filled cells and formulas and can check an empty box', () => {
    const row = [];
    const formulaRow = [];
    row[26] = '0.2';
    formulaRow[32] = true;
    row[43] = '4 - 6';
    formulaRow[43] = true;
    row[41] = 'TRUE';
    const updates = buildCellUpdates({
        excelRow: 12,
        columns: { volPre: 'AA', potential: 'AG', time: 'AR', activePost: 'AO', activeEarly: 'AP' },
        row,
        formulaRow,
        values: { volPre: 0.585, potential: 3.5, time: '5', activePost: true, activeEarly: true },
    });
    assert.deepEqual(updates, [
        { range: 'AO12', value: true },
    ]);
    const unchecked = buildCellUpdates({
        excelRow: 8,
        columns: { activeEarly: 'A' },
        row: ['FALSE'],
        formulaRow: [false],
        values: { activeEarly: true },
    });
    assert.deepEqual(unchecked, [{ range: 'A8', value: true }]);
    const dropdown = buildCellUpdates({
        excelRow: 9,
        columns: { vwap: 'A', dayPos: 'B', time: 'C' },
        row: ['над', 'Low', '4'],
        formulaRow: [false, false, false],
        values: { vwap: 'Над', dayPos: 'High', time: '06:00' },
    });
    assert.deepEqual(dropdown, [
        { range: 'A9', value: 'Над' },
        { range: 'C9', value: '06:00' },
    ]);
});

test('a UTC-midnight daily bar belongs to the next New York session', () => {
    assert.equal(tradingDate(Date.parse('2026-09-26T00:00:00Z')), '2026-09-26');
    assert.equal(movePlayed(2, 1, 1.25), 'YES');
    assert.equal(movePlayed(2, 1, 1.9), 'NO');
    assert.equal(movePlayed(2, 1, 1.75), 'NO');
});

test('SLND today uses the last completed session and the 14 sessions before it', () => {
    const rows = [
        ['2026-09-08', 0.64, 0.6212, 49944.4124],
        ['2026-09-09', 0.65, 0.611, 190908.2484],
        ['2026-09-10', 0.629, 0.5635, 221963.3994],
        ['2026-09-11', 0.606, 0.5661, 81035.8324],
        ['2026-09-14', 0.6186, 0.5815, 49722.34536],
        ['2026-09-15', 0.5845, 0.5601, 77880.556355],
        ['2026-09-16', 0.58, 0.5521, 82314.706355],
        ['2026-09-17', 0.6, 0.5558, 75652.6504],
        ['2026-09-18', 0.65, 0.5776, 241990.458192],
        ['2026-09-21', 0.65, 0.59, 188638.579998],
        ['2026-09-22', 0.6668, 0.615, 99530.1834],
        ['2026-09-23', 0.639, 0.61, 55378.2364],
        ['2026-09-24', 0.6489, 0.61, 78879.4124],
        ['2026-09-25', 0.6799, 0.6264, 114145.4124],
        ['2026-09-28', 0.6554, 0.61, 81309.91061, 0.61],
    ];
    const bars = rows.map(([date, high, low, volume, close]) => ({
        t: zonedDateTimeToUtcMs(date, '16:00:00'),
        h: high,
        l: low,
        c: close ?? high,
        v: volume,
    }));
    const today = scoreCompletedSession(bars, '2026-09-29', { nowDate: '2026-09-29' });
    assert.equal(today.date, '2026-09-28');
    assert.equal(today.atr14, 0.04);
    assert.equal(today.avgVol14, 114856);
    assert.equal(today.volume, 81309.91061);
    assert.equal(today.volPlay14, 0.7);
    assert.equal(today.atrPlay14, 1.1);
    assert.equal(today.close, 0.61);
    const previousTrade = scoreCompletedSession(bars, '2026-09-28');
    assert.equal(previousTrade.date, '2026-09-25');
    assert.equal(previousTrade.volume, 114145.4124);
});

test('premarket volume stops at each entry and does not reuse one trade', () => {
    const bars = [
        { t: zonedDateTimeToUtcMs('2026-09-28', '04:10:00'), v: 100_000 },
        { t: zonedDateTimeToUtcMs('2026-09-28', '07:40:00'), v: 250_000 },
        { t: zonedDateTimeToUtcMs('2026-09-28', '08:20:00'), v: 400_000 },
        { t: zonedDateTimeToUtcMs('2026-09-28', '09:30:00'), v: 900_000 },
    ];
    const first = zonedDateTimeToUtcMs('2026-09-28', '07:49:00');
    const second = zonedDateTimeToUtcMs('2026-09-28', '08:31:00');
    const afterOpen = zonedDateTimeToUtcMs('2026-09-28', '10:15:00');
    assert.equal(premarketVolumeUntil(bars, '2026-09-28', first), 350_000);
    assert.equal(premarketVolumeUntil(bars, '2026-09-28', second), 750_000);
    assert.equal(premarketVolumeUntil(bars, '2026-09-28', afterOpen), 750_000);
    const trades = [
        { symbol: 'BKYI', opened: '2026-09-28 07:49:32', sheet: { sheetRow: 12 } },
        { symbol: 'BKYI', opened: '2026-09-28 08:31:00' },
        { symbol: 'SLND', opened: '2026-09-28 04:15:00' },
    ];
    const assigned = assignEntryTrades([
        { excelRow: 12, ticker: 'BKYI' },
        { excelRow: 18, ticker: 'BKYI' },
        { excelRow: 19, ticker: 'SLND' },
    ], trades);
    assert.equal(assigned.get(12).opened, '2026-09-28 07:49:32');
    assert.equal(assigned.get(18).opened, '2026-09-28 08:31:00');
    assert.equal(assigned.get(19).opened, '2026-09-28 04:15:00');
});

test('quantity limit records only the first missing rows', () => {
    const rows = [
        { date: '2026-09-27', ticker: 'AAA', eligible: true, writableCount: 2 },
        { date: '2026-09-29', ticker: 'BKYI', eligible: false, writableCount: 4 },
        { date: '2026-09-26', ticker: 'BBB', eligible: true, writableCount: 1 },
        { date: '2026-09-25', ticker: 'CCC', eligible: true, writableCount: 0 },
    ];
    assert.equal(selectExportRows(rows, { limitEnabled: false }).length, 2);
    assert.deepEqual(selectExportRows(rows, { limitEnabled: true, limit: 1 }).map((row) => row.ticker), ['AAA']);
    assert.equal(selectExportRows(rows, { limitEnabled: true, limit: 0 }).length, 0);
});
