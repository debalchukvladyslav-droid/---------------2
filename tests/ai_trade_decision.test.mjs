import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperTradeDecision, canEnableLiveExecution } from '../lib/ai_trade_decision.js';

const strongAnalysis = {
    ai_pattern_key: 'breakout_retest',
    ai_confidence: 0.91,
    analysis_features: {
        evidence: { visible: ['entry arrow at retested level', 'volume expansion'], missing: [] },
        processScores: {
            setupValidity: 85, contextFit: 80, entryQuality: 82,
            riskPlan: 75, executionReadiness: 84,
        },
    },
};

test('paper decision permits only evidence-rich reliable reviewed patterns', () => {
    const decision = buildPaperTradeDecision(
        strongAnalysis,
        { direction: 'short' },
        { sample_size: 12, reliability: 0.72 },
    );
    assert.equal(decision.action, 'SHORT');
    assert.equal(decision.executable, false);
    assert.equal(decision.risk.maxRiskR, 0.25);
});

test('paper decision abstains when memory or visible trigger is weak', () => {
    const decision = buildPaperTradeDecision(
        { ...strongAnalysis, analysis_features: { ...strongAnalysis.analysis_features, evidence: { visible: ['chart'], missing: ['visible_entry_trigger_or_confirmation'] } } },
        { direction: 'long' },
        { sample_size: 2, reliability: 0.9 },
    );
    assert.equal(decision.action, 'SKIP');
    assert.ok(decision.reasons.includes('critical_visual_evidence_missing'));
    assert.ok(decision.reasons.includes('reviewed_pattern_samples_below_5'));
});

test('live execution remains locked until a substantial paper and holdout record exists', () => {
    assert.equal(canEnableLiveExecution({ goldCount: 99, holdoutCount: 30, selectiveAccuracy: 0.9, coverage: 0.8, maxPaperDrawdownR: 2, paperTrades: 200 }), false);
    assert.equal(canEnableLiveExecution({ goldCount: 100, holdoutCount: 30, selectiveAccuracy: 0.75, coverage: 0.5, maxPaperDrawdownR: 5, paperTrades: 100 }), true);
});
