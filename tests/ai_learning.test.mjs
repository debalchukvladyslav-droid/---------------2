import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, PATTERN_KEYS } from '../lib/ai_learning.js';

test('AI learning candidates combine trade, journal outcome and matching screenshot', () => {
    const rows = [{
        id: 7,
        user_id: '00000000-0000-0000-0000-000000000001',
        trade_date: '2026-07-29',
        pnl: -500,
        kf: -1,
        notes: 'Поспішив після пробою',
        daily_metrics: {
            screenshots: { good: [], normal: [], bad: ['screenshots/u/AMIX-entry.png'], error: [] },
            trades: [{ symbol: 'AMIX', opened: '2026-07-29 10:15', net: -500, kf: -1, criteria: '700k+', exceptions: '-' }],
        },
    }];
    const candidates = buildCandidates(rows);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source_snapshot.ticker, 'AMIX');
    assert.equal(candidates[0].source_snapshot.dayNotes, 'Поспішив після пробою');
    assert.equal(candidates[0].outcome.pnl, -500);
    assert.equal(candidates[0].screenshot_path, 'screenshots/u/AMIX-entry.png');
    assert.match(candidates[0].content_hash, /^[a-f0-9]{64}$/);
});

test('AI learning keeps positive trades and supports non-error labels', () => {
    const candidates = buildCandidates([{ id: 1, user_id: 'u', trade_date: '2026-07-30', pnl: 100, kf: 1, daily_metrics: { trades: [{ symbol: 'GOOD', net: 100, kf: 1 }] } }]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].outcome.pnl, 100);
    assert.equal(PATTERN_KEYS.has('valid_entry'), true);
    assert.equal(PATTERN_KEYS.has('insufficient_data'), true);
});
