import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeDiscipline, minutesFromTime, shortRiskReward } from '../lib/discipline_score.js';

const valid = { type: 'SHORT', opened: '07:15', setup: 'Pump & Dump Short', rvol: 8, atr: 0.55, entry: 4, stop: 4.2, exit: 3.6 };
test('A grade reflects execution quality', () => { const result = gradeDiscipline(valid); assert.equal(result.grade, 'A'); assert.equal(result.score, 100); assert.equal(shortRiskReward(valid), 2); });
test('profitable chase outside session cannot receive a high grade', () => { const result = gradeDiscipline({ ...valid, opened: '10:15', exit: 2, chased: true, pnl: 2000 }); assert.ok(['D', 'F'].includes(result.grade)); assert.equal(result.outcomeIndependent, true); });
test('well-executed stopped trade keeps A independent of loss', () => { const result = gradeDiscipline({ ...valid, exit: 4.2, pnl: -100 }); assert.equal(result.grade, 'A'); });
test('invalid short stop and missing evidence are penalized', () => { const result = gradeDiscipline({ setup: 'Pump & Dump Short', opened: '05:00', entry: 4, stop: 3.9 }); assert.equal(result.grade, 'F'); assert.ok(result.reasons.some((reason) => reason.includes('Stop'))); });
test('time parser enforces valid clock values', () => { assert.equal(minutesFromTime('04:00'), 240); assert.equal(minutesFromTime('24:00'), null); });
