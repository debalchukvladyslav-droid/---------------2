import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, embeddingText, isMemoryEligible, PATTERN_KEYS } from '../lib/ai_learning.js';

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

test('AI learning links random Drive filenames through profile OCR ticker map', () => {
    const path = 'screenshots/user/random-drive-id_thinkorswim_random.png';
    const rows = [{
        id: 2, user_id: 'user', trade_date: '2026-07-29', pnl: 10, kf: 0.2,
        daily_metrics: {
            screenshots: { good: [], normal: [path], bad: [], error: [] },
            trades: [{ symbol: 'NCRA', net: -5 }, { symbol: 'TURB', net: 15 }],
        },
    }];
    const contexts = new Map([['user', { tickers: { [path]: 'NCRA' } }]]);
    const candidates = buildCandidates(rows, contexts);
    assert.equal(candidates[0].screenshot_path, path);
    assert.equal(candidates[1].screenshot_path, null);
});

test('AI memory keeps visual structure and rejects generic no-structure guesses', () => {
    const text = embeddingText({
        source_snapshot: { ticker: 'TEST', aiFeatures: { movement: { phase: 'retest' }, signals: ['level held'] } },
        outcome: { pnl: -10 },
        ai_pattern_key: 'breakout_retest',
        visual_evidence: 'breakout followed by a retest',
    });
    assert.match(text, /retest/);
    assert.match(text, /level held/);
    assert.equal(isMemoryEligible({ ai_pattern_key: 'no_structure', ai_confidence: 0.99 }), false);
    assert.equal(isMemoryEligible({ ai_pattern_key: 'breakout_retest', ai_confidence: 0.7 }), true);
});
