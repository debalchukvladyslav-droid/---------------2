import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateEntryCriteria,
    decideSnapshotWrite,
    parseEntryInstant,
    presentSnapshot,
    snapshotIsFrozen,
    zonedDateTimeToUtcMs,
} from '../lib/massive_criteria.js';
import { aggregatesHost, fetchMassiveAggregates, mapMassiveFailure, massiveApiKey, redactSecrets, resetMassiveClientState } from '../lib/massive_client.js';

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

test('criteria use the completed session before the trade and ignore later minutes', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-09-28', opened: '11:22' });
    assert.equal(entry.entryAt, '2026-09-28T15:22:00.000Z');
    const days = [];
    for (let day = 10; day <= 27; day += 1) {
        days.push({
            t: midnightEt(`2026-09-${String(day).padStart(2, '0')}`),
            h: 12,
            l: 10,
            c: 11,
            v: day === 27 ? 2_000_000 : 1_000_000,
        });
    }
    days.push({ t: midnightEt('2026-09-28'), h: 80, l: 1, c: 40, v: 9_000_000 });
    const criteria = calculateEntryCriteria({
        dailyBars: days,
        minuteBars: [minute('2026-09-28', '11:21:00', { h: 50, l: 1, v: 999_999 })],
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(criteria.atr14, 2);
    assert.equal(criteria.avgVol14, 1_000_000);
    assert.equal(criteria.dayVolume, 2_000_000);
    assert.equal(criteria.volPlay14, 2);
    assert.equal(criteria.atrPlay14, 1);
    assert.equal(criteria.high, 12);
    assert.equal(criteria.low, 10);
    assert.equal(criteria.completeness, 'complete');
    assert.equal(criteria.sourceMeta.sessionDate, '2026-09-27');
    const view = presentSnapshot(criteria);
    assert.equal(view.display.atr14, '2.00');
    assert.equal(view.display.volPlay14, '2.0');
    assert.equal(view.display.atrPlay14, '1.0');
});

test('fourteen completed sessions before the scored day are a hard boundary', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-09-28', opened: '11:22:00' });
    const days = [];
    for (let day = 13; day <= 27; day += 1) {
        days.push({ t: midnightEt(`2026-09-${day}`), h: 12, l: 10, v: 100 });
    }
    const thirteenPrior = calculateEntryCriteria({
        dailyBars: days.slice(1),
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(thirteenPrior.avgVol14, null);
    assert.equal(thirteenPrior.atr14, null);
    assert.equal(thirteenPrior.dayVolume, 100);
    const ready = calculateEntryCriteria({
        dailyBars: days,
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
    });
    assert.equal(ready.atr14, 2);
    assert.equal(ready.avgVol14, 100);
    assert.equal(ready.dayVolume, 100);
    assert.equal(ready.sourceMeta.sessionDate, '2026-09-27');
});

test('New York daylight-saving offsets are applied to the session clocks', () => {
    assert.equal(zonedDateTimeToUtcMs('2026-03-08', '04:00:00'), Date.parse('2026-03-08T08:00:00.000Z'));
    assert.equal(zonedDateTimeToUtcMs('2026-03-08', '11:22:00'), Date.parse('2026-03-08T15:22:00.000Z'));
    assert.equal(zonedDateTimeToUtcMs('2026-11-01', '04:00:00'), Date.parse('2026-11-01T09:00:00.000Z'));
    assert.equal(zonedDateTimeToUtcMs('2026-11-01', '11:22:00'), Date.parse('2026-11-01T16:22:00.000Z'));
});

test('unadjusted history is rejected and an older snapshot is recalculated', () => {
    const entry = parseEntryInstant({ tradeDate: '2026-09-28', opened: '11:22' });
    const unadjusted = calculateEntryCriteria({
        dailyBars: [],
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
        adjusted: false,
    });
    assert.equal(unadjusted.avgVol14, null);
    assert.equal(unadjusted.fetchStatus, 'error');
    assert.equal(snapshotIsFrozen({ completeness: 'complete', fetch_status: 'ok', calculation_version: 1 }), false);
    assert.equal(snapshotIsFrozen({ completeness: 'complete', fetch_status: 'ok', calculation_version: 2 }), true);
});

test('a finished snapshot is not replaced automatically', () => {
    const frozen = { completeness: 'complete', fetch_status: 'ok', calculation_version: 2 };
    const failed = { completeness: 'unavailable', fetch_status: 'forbidden' };
    assert.equal(decideSnapshotWrite(null, { manual: false }), 'insert');
    assert.equal(decideSnapshotWrite(frozen, { manual: true }), 'reuse');
    assert.equal(decideSnapshotWrite(failed, { manual: false }), 'reuse');
    assert.equal(decideSnapshotWrite(failed, { manual: true }), 'replace');
});

test('Massive uses the same key as Polygon when MASSIVE_API_KEY is absent', () => {
    assert.equal(massiveApiKey({ POLYGON_API_KEY: 'polygon-key' }), 'polygon-key');
    assert.equal(aggregatesHost({ POLYGON_API_KEY: 'polygon-key' }), 'api.polygon.io');
    assert.equal(massiveApiKey({ MASSIVE_API_KEY: 'massive-key', POLYGON_API_KEY: 'polygon-key' }), 'massive-key');
    assert.equal(massiveApiKey({}), '');
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
