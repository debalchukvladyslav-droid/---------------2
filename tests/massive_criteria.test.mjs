import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateEntryCriteria,
    decideSnapshotWrite,
    parseEntryInstant,
    presentSnapshot,
    zonedDateTimeToUtcMs,
} from '../lib/massive_criteria.js';
import { fetchMassiveAggregates, mapMassiveFailure, redactSecrets, resetMassiveClientState } from '../lib/massive_client.js';

function midnightEt(date) {
    return zonedDateTimeToUtcMs(date, '00:00:00');
}

function minute(date, clock, extra = {}) {
    return { t: zonedDateTimeToUtcMs(date, clock), h: 10, l: 9.9, v: 0, ...extra };
}

function ctntFixture() {
    const days = [];
    for (let day = 14; day <= 27; day += 1) {
        const date = `2026-09-${String(day).padStart(2, '0')}`;
        const recent = day >= 15;
        const range = day === 27 ? 20.18 : 20.22;
        days.push({
            t: midnightEt(date),
            h: recent ? 10 + range : 50,
            l: recent ? 10 : 1,
            v: 1_760_174,
        });
    }
    days.push({ t: midnightEt('2026-09-28'), h: 80, l: 1, v: 9_000_000 });
    days.push({ t: midnightEt('2026-09-29'), h: 90, l: 1, v: 9_000_000 });
    const minutes = [
        minute('2026-09-28', '04:00:00', { h: 10.4, l: 10.2, v: 174_017 }),
        minute('2026-09-28', '09:30:00', { h: 10.05, l: 10.02, v: 1_000 }),
        minute('2026-09-28', '11:21:00', { h: 10.1, l: 10, v: 1_000 }),
        minute('2026-09-28', '11:22:00', { h: 50, l: 1, v: 999_999 }),
    ];
    return { days, minutes };
}

test('CTNT 2026-09-28 11:22 ET matches the TOS targets on adjusted bars', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-09-28', opened: '11:22' });
    assert.equal(entry.entryAt, '2026-09-28T15:22:00.000Z');
    const { days, minutes } = ctntFixture();
    const criteria = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: minutes,
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(criteria.atr14, 18.78);
    assert.equal(criteria.avgVol14, 1_760_174);
    assert.equal(criteria.volPlay14, 0.1);
    assert.equal(criteria.atrPlay14, 0.0);
    assert.equal(criteria.high, 10.1);
    assert.equal(criteria.low, 10);
    assert.equal(criteria.lastCandleAt, '2026-09-28T15:21:00.000Z');
    assert.equal(criteria.completeness, 'complete');
    assert.equal(criteria.dayVolume, 176_017);
    const view = presentSnapshot(criteria);
    assert.equal(view.display.atr14, '18.78');
    assert.equal(view.display.avgVol14, '1,760,174');
    assert.equal(view.display.volPlay14, '0.1');
    assert.equal(view.display.atrPlay14, '0.0');
    assert.equal(view.display.lastCandle, '2026-09-28 11:21 ET');
});

test('fourteen completed sessions are a hard boundary and missing bars stay null', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-09-28', opened: '11:22:00' });
    const days = [];
    for (let day = 15; day <= 27; day += 1) {
        days.push({ t: midnightEt(`2026-09-${day}`), h: 20, l: 10, v: 100 });
    }
    const thirteen = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: [minute('2026-09-28', '04:00:00', { v: 50, h: 11, l: 10 }), minute('2026-09-28', '09:30:00', { v: 5, h: 12, l: 11 })],
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(thirteen.avgVol14, null);
    assert.equal(thirteen.volPlay14, null);
    assert.equal(thirteen.atr14, 9.36);
    days.push({ t: midnightEt('2026-09-14'), h: null, l: null, v: null });
    const missing = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: [],
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(missing.avgVol14, null);
    assert.equal(missing.atr14, null);
    assert.equal(missing.dayVolume, null);
    assert.notEqual(missing.dayVolume, 0);
});

test('only minute bars completed before the entry are used', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-01-15', opened: '11:22' });
    assert.equal(entry.entryAt, '2026-01-15T16:22:00.000Z');
    const days = Array.from({ length: 14 }, (_, index) => ({
        t: midnightEt(`2026-01-${String(index + 1).padStart(2, '0')}`),
        h: 12,
        l: 10,
        v: 10,
    }));
    const criteria = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: [
            minute('2026-01-15', '11:21:00', { h: 11, l: 10.5, v: 4 }),
            minute('2026-01-15', '11:22:00', { h: 30, l: 1, v: 500 }),
        ],
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
        volumeSessionStart: '11:00',
        highLowSessionStart: '11:00',
    });
    assert.equal(criteria.high, 11);
    assert.equal(criteria.low, 10.5);
    assert.equal(criteria.dayVolume, 4);
    assert.equal(criteria.lastCandleAt, '2026-01-15T16:21:00.000Z');
});

test('New York daylight-saving offsets are applied to the session clocks', () => {
    assert.equal(zonedDateTimeToUtcMs('2026-03-08', '04:00:00'), Date.parse('2026-03-08T08:00:00.000Z'));
    assert.equal(zonedDateTimeToUtcMs('2026-03-08', '11:22:00'), Date.parse('2026-03-08T15:22:00.000Z'));
    assert.equal(zonedDateTimeToUtcMs('2026-11-01', '04:00:00'), Date.parse('2026-11-01T09:00:00.000Z'));
    assert.equal(zonedDateTimeToUtcMs('2026-11-01', '11:22:00'), Date.parse('2026-11-01T16:22:00.000Z'));
});

test('adjusted history is used as returned and a late first print is incomplete', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-09-28', opened: '11:22' });
    const { days, minutes } = ctntFixture();
    const unadjusted = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: minutes,
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
        adjusted: false,
    });
    assert.equal(unadjusted.avgVol14, null);
    assert.equal(unadjusted.fetchStatus, 'error');
    const late = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: minutes.filter((bar) => bar.t > zonedDateTimeToUtcMs('2026-09-28', '04:00:00')),
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(late.completeness, 'incomplete');
    assert.match(late.sourceMeta.notes.join(' '), /премаркету неповний/);
    assert.notEqual(late.dayVolume, 0);
});

test('a finished snapshot is not replaced automatically', () => {
    const frozen = { completeness: 'complete', fetch_status: 'ok' };
    const failed = { completeness: 'unavailable', fetch_status: 'forbidden' };
    assert.equal(decideSnapshotWrite(null, { manual: false }), 'insert');
    assert.equal(decideSnapshotWrite(frozen, { manual: true }), 'reuse');
    assert.equal(decideSnapshotWrite(failed, { manual: false }), 'reuse');
    assert.equal(decideSnapshotWrite(failed, { manual: true }), 'replace');
});

test('Massive errors stay free of the API key and incomplete payloads are marked', async () => {
    resetMassiveClientState();
    const secret = 'super-secret-key';
    assert.equal(redactSecrets(`apiKey=${secret}&next=1`, secret), 'apiKey=[redacted]&next=1');
    assert.equal(mapMassiveFailure(403, 'CTNT').fetchStatus, 'forbidden');
    assert.equal(mapMassiveFailure(429, 'CTNT').fetchStatus, 'rate_limited');
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 403, json: async () => ({ error: `bad ${secret}` }) };
        return {
            ok: true,
            status: 200,
            json: async () => ({ adjusted: true, status: 'DELAYED', resultsCount: 3, results: [{ t: 1, h: 2, l: 1, v: 5 }] }),
        };
    };
    await assert.rejects(
        () => fetchMassiveAggregates({ ticker: 'CTNT', timespan: 'day', from: '2026-09-01', to: '2026-09-27', apiKey: secret, fetchImpl }),
        (error) => {
            assert.equal(error.fetchStatus, 'forbidden');
            assert.equal(error.message.includes(secret), false);
            return true;
        },
    );
    assert.equal(calls, 1);
    await assert.rejects(
        () => fetchMassiveAggregates({ ticker: 'CTNT', timespan: 'day', from: '2026-09-01', to: '2026-09-27', apiKey: secret, fetchImpl }),
        (error) => error.fetchStatus === 'forbidden',
    );
    assert.equal(calls, 1);
    resetMassiveClientState();
    const delayed = await fetchMassiveAggregates({
        ticker: 'CTNT',
        timespan: 'minute',
        from: '1',
        to: '2',
        apiKey: secret,
        fetchImpl,
    });
    assert.equal(delayed.delayed, true);
    assert.equal(delayed.incomplete, true);
    assert.equal(delayed.results.length, 1);
});
