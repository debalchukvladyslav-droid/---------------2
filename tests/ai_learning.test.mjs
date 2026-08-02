import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzedCandidateIdentities, assignChronologicalSplits, buildCandidates, buildCandidatesFromExamples, candidateIdentity, derivePersonalPatterns, deriveProcessOutcomeAssessment, embeddingText, evaluateAnalysis, inferScreenshotRole, inspectImageBuffer, isMemoryEligible, matchTradeScreens, outcomeBlindSnapshot, outcomeGroup, parseAiJson, resolveOpenRouterVisionModel, retryAiGeneration, selectFreshCandidateBatch, semanticPatternMatch, sortCandidatesByOutcome, summarizeEvaluationResults, PATTERN_KEYS } from '../lib/ai_learning.js';
import { diversifyReviewExamples, prioritizeReviewExamples, reviewPriority } from '../lib/ai_review_priority.js';
import { validateHumanReview } from '../lib/ai_learning_admin.js';

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

test('AI learning keeps several screenshots with roles and confidence', () => {
    const metrics = { screenshots: { good: ['u/ABCD-pre-entry.png', 'u/ABCD-entry.png'], normal: ['u/ABCD-post-exit.png'], bad: [], error: [] } };
    const screens = matchTradeScreens({ symbol: 'ABCD' }, metrics, 2);
    assert.equal(screens.length, 3);
    assert.equal(screens[0].matchMethod, 'filename');
    assert.equal(screens[0].matchConfidence, 0.6);
    assert.equal(inferScreenshotRole(screens[0].path, 0, screens.length), 'pre_entry');
    assert.equal(inferScreenshotRole(screens[2].path, 2, screens.length), 'post_exit');
});

test('ambiguous screenshots are not assigned across several trades without evidence', () => {
    const metrics = { screenshots: { good: [], normal: ['u/random.png'], bad: [], error: [] } };
    assert.deepEqual(matchTradeScreens({ symbol: 'ABCD' }, metrics, 2), []);
    const single = matchTradeScreens({ symbol: 'ABCD' }, metrics, 1);
    assert.equal(single[0].matchMethod, 'single_trade_day');
    assert.equal(single[0].matchConfidence, 0.55);
});

test('persistent screenshot registry overrides filename heuristics and keeps explicit role', () => {
    const path = 'screenshots/u/random-file.png';
    const metrics = { screenshots: { good: [path], normal: [], bad: [], error: [] }, trades: [{ symbol: 'ABCD' }] };
    const contexts = new Map([['u', { registry: { [path]: { ticker: 'ABCD', screenshot_role: 'pre_entry', quality_status: 'ready', pixel_width: 1440, pixel_height: 900 } } }]]);
    const [candidate] = buildCandidates([{ id: 'd', user_id: 'u', trade_date: '2026-01-01', daily_metrics: metrics }], contexts);
    assert.equal(candidate.source_snapshot.screenshotMatch.method, 'registry_ticker');
    assert.equal(candidate.source_snapshot.screenshotSet[0].role, 'pre_entry');
    assert.equal(candidate.source_snapshot.screenshotSet[0].qualityStatus, 'ready');
    assert.equal(candidate.source_snapshot.screenshotSet[0].width, 1440);
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

test('new training rebuilds candidates from already analyzed examples', () => {
    const candidates = buildCandidatesFromExamples([{
        user_id: 'user', journal_day_id: 'day', trade_date: '2026-07-30', trade_key: 'user:trade',
        source_snapshot: { ticker: 'OLD' }, outcome: { pnl: -20 }, screenshot_path: 'screenshots/user/old.png',
    }], 'entry-memory-v4');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source_snapshot.ticker, 'OLD');
    assert.match(candidates[0].content_hash, /^[a-f0-9]{64}$/);
});

test('training separates losses and profits before structural analysis', () => {
    const profit = { trade_key: 'profit', trade_date: '2026-07-31', outcome: { pnl: 25 } };
    const loss = { trade_key: 'loss', trade_date: '2026-07-30', outcome: { pnl: -10 } };
    const neutral = { trade_key: 'neutral', trade_date: '2026-07-29', outcome: { pnl: 0 } };
    assert.equal(outcomeGroup(loss), 'loss');
    assert.equal(outcomeGroup(profit), 'profit');
    assert.deepEqual(sortCandidatesByOutcome([neutral, profit, loss]).map(item => item.trade_key), ['loss', 'profit', 'neutral']);
});

test('trade outcome never substitutes the whole day result for a missing trade result', () => {
    const [candidate] = buildCandidates([{
        id: 'day', user_id: 'user', trade_date: '2026-07-30', pnl: 500, kf: 3,
        daily_metrics: { trades: [{ symbol: 'UNKNOWN' }] },
    }]);
    assert.equal(candidate.outcome.pnl, null);
    assert.equal(candidate.outcome.kf, null);
    assert.equal(candidate.outcome.dayPnl, 500);
    assert.equal(outcomeGroup(candidate), 'neutral');
});

test('evaluation requires both a matching label and explicit evidence', () => {
    const metrics = evaluateAnalysis('breakout_retest', {
        ai_pattern_key: 'breakout_retest',
        analysis_features: { chartSummary: 'Breakout and retest', evidence: { visible: ['level retest'], missing: [] } },
    });
    assert.deepEqual(metrics, { exactMatch: true, compatibleMatch: true, evidenceComplete: true, abstained: false });
    assert.equal(evaluateAnalysis('breakout_retest', { ai_pattern_key: 'unclear', analysis_features: {} }).abstained, true);
});

test('semantic evaluation credits a supported subtype under a broad human valid-entry label', () => {
    assert.equal(semanticPatternMatch('valid_entry', 'pullback_entry'), true);
    assert.equal(semanticPatternMatch('valid_entry', 'breakout_retest'), true);
    assert.equal(semanticPatternMatch('pullback_entry', 'valid_entry'), false);
    assert.equal(semanticPatternMatch('no_structure', 'unclear'), false);
    const metrics = evaluateAnalysis('valid_entry', {
        ai_pattern_key: 'pullback_entry',
        analysis_features: { chartSummary: 'Visible pullback', evidence: { visible: ['entry arrow at retest'], missing: [] } },
    });
    assert.equal(metrics.exactMatch, false);
    assert.equal(metrics.compatibleMatch, true);
});

test('unsupported model classifications are downgraded instead of becoming facts', () => {
    const unsupported = parseAiJson(JSON.stringify({ patternKey: 'valid_entry', confidence: 0.97, explanation: 'Looks good' }));
    assert.equal(unsupported.ai_pattern_key, 'unclear');
    assert.equal(unsupported.ai_confidence, 0.35);
    const uncalibratedCertainty = parseAiJson(JSON.stringify({
        patternKey: 'valid_entry', confidence: 1, chartSummary: 'Visible retest at marked entry',
        evidence: { visible: ['entry marker at retested level'], inferred: [], missing: [] },
        taxonomy: { trigger: ['level_retest'] }, execution: { confirmation: 'level_retest' },
    }));
    assert.equal(uncalibratedCertainty.ai_confidence, 0.9);
    const supported = parseAiJson(JSON.stringify({
        patternKey: 'valid_entry', confidence: 0.8, chartSummary: 'Price retested the visible level before entry',
        evidence: { visible: ['entry marker is above the retested level'], inferred: [], missing: [] },
        taxonomy: { trigger: ['level_retest'] }, execution: { confirmation: 'visible_retest' },
    }));
    assert.equal(supported.ai_pattern_key, 'valid_entry');
    assert.equal(supported.ai_confidence, 0.8);
    const tablePriceMasqueradingAsVision = parseAiJson(JSON.stringify({
        patternKey: 'pullback_entry', confidence: 0.85,
        chartSummary: 'Sharp impulse and recovery',
        evidence: { visible: ['Price high at 2.37', 'Entry price 1.9858', 'Volume bars present'], inferred: [], missing: [] },
        movement: { entryLocation: 'mid pullback retest' }, execution: { timing: 'post correction' },
        processScores: { entryQuality: 80 },
    }));
    assert.equal(tablePriceMasqueradingAsVision.ai_pattern_key, 'unclear');
    assert.equal(tablePriceMasqueradingAsVision.ai_confidence, 0.35);
    assert.equal(tablePriceMasqueradingAsVision.analysis_features.movement.entryLocation, '');
    assert.ok(tablePriceMasqueradingAsVision.analysis_features.evidence.missing.includes('visible_entry_marker'));
    const futureLeakage = parseAiJson(JSON.stringify({
        patternKey: 'valid_entry', confidence: 0.9,
        chartSummary: 'Entry marker visible at the breakout',
        explanation: 'Price subsequently moved higher, confirming the direction of the setup.',
        evidence: { visible: ['entry marker line at 1.98'], inferred: [], missing: [] },
    }));
    assert.equal(futureLeakage.ai_pattern_key, 'unclear');
    assert.equal(futureLeakage.ai_confidence, 0.35);
    assert.ok(futureLeakage.analysis_features.evidence.missing.includes('outcome_blind_entry_assessment'));
    const unsupportedTrigger = parseAiJson(JSON.stringify({
        patternKey: 'pullback_entry', confidence: 0.85,
        chartSummary: 'A pullback is visible before the marked entry',
        evidence: { visible: ['entry marker near 1.98', 'downtrend'], inferred: [], missing: [] },
        taxonomy: { trigger: ['unclear'], structure: ['pullback'] },
        execution: { confirmation: 'none_visible' }, processScores: { entryQuality: 70 },
    }));
    assert.equal(unsupportedTrigger.ai_pattern_key, 'unclear');
    assert.equal(unsupportedTrigger.ai_confidence, 0.35);
    assert.equal(unsupportedTrigger.analysis_features.processScores.entryQuality, null);
    assert.ok(unsupportedTrigger.analysis_features.evidence.missing.includes('visible_entry_trigger_or_confirmation'));
    const inferredTrigger = parseAiJson(JSON.stringify({
        patternKey: 'pullback_entry', confidence: 0.8,
        chartSummary: 'A marked entry appears inside a descending channel',
        evidence: {
            visible: ['entry marker near 1.98', 'descending channel', 'volume bars'],
            inferred: ['support zone near 1.98'], missing: [],
        },
        taxonomy: { trigger: ['support_retest'], structure: ['descending_channel'] },
        execution: { confirmation: 'unclear', trendAlignment: 'countertrend' },
        processScores: { entryQuality: 80 },
    }));
    assert.equal(inferredTrigger.ai_pattern_key, 'unclear');
    assert.equal(inferredTrigger.ai_confidence, 0.35);
    assert.equal(inferredTrigger.analysis_features.processScores.entryQuality, null);
    assert.ok(inferredTrigger.analysis_features.evidence.missing.includes('visible_entry_trigger_or_confirmation'));
    const genericNearLevelTrigger = parseAiJson(JSON.stringify({
        patternKey: 'pullback_entry', confidence: 0.85,
        chartSummary: 'A descending channel and consolidation are visible near 2.00',
        evidence: {
            visible: ['Green execution arrow at 1.9858', 'descending channel', 'price action near 2.00 level'],
            inferred: ['pullback within a bearish regime'], missing: [],
        },
        taxonomy: { trigger: ['price_action_near_level'], structure: ['descending_channel'] },
        execution: { confirmation: 'unclear', trendAlignment: 'countertrend' },
        processScores: { entryQuality: 65 },
    }), { entryPrice: 1.9858 });
    assert.equal(genericNearLevelTrigger.ai_pattern_key, 'unclear');
    assert.equal(genericNearLevelTrigger.ai_confidence, 0.35);
    assert.equal(genericNearLevelTrigger.analysis_features.processScores.entryQuality, null);
    assert.ok(genericNearLevelTrigger.analysis_features.evidence.missing.includes('visible_entry_trigger_or_confirmation'));
    const concreteSignalTrigger = parseAiJson(JSON.stringify({
        patternKey: 'valid_entry', confidence: 0.9,
        chartSummary: 'A marked entry follows a vertical impulse and visible volume expansion',
        evidence: { visible: ['Green execution arrow at $2.71', 'significant volume spike'], inferred: [], missing: [] },
        taxonomy: { trigger: ['price_action'], structure: ['impulse', 'pullback'] },
        signals: ['impulse_move', 'volume_spike'],
        execution: { confirmation: 'price_action' }, processScores: { entryQuality: 80 },
    }), { entryPrice: 2.7164 });
    assert.equal(concreteSignalTrigger.ai_pattern_key, 'valid_entry');
    assert.equal(concreteSignalTrigger.ai_confidence, 0.9);
    const alignedExecutionArrow = parseAiJson(JSON.stringify({
        patternKey: 'valid_entry', confidence: 0.82,
        chartSummary: 'Impulse followed by a controlled retest',
        evidence: { visible: ['Red arrow at $2.71', 'retested level at 2.70'], inferred: [], missing: [] },
        taxonomy: { trigger: ['level_retest'] }, execution: { confirmation: 'visible_retest' },
    }), { entryPrice: 2.7164 });
    assert.equal(alignedExecutionArrow.ai_pattern_key, 'valid_entry');
    const unrelatedArrow = parseAiJson(JSON.stringify({
        patternKey: 'valid_entry', confidence: 0.82,
        chartSummary: 'A red arrow is visible elsewhere on the chart',
        evidence: { visible: ['Red arrow at $1.52', 'retested level at 2.70'], inferred: [], missing: [] },
        taxonomy: { trigger: ['level_retest'] }, execution: { confirmation: 'visible_retest' },
    }), { entryPrice: 2.7164 });
    assert.equal(unrelatedArrow.ai_pattern_key, 'unclear');
});

test('personal patterns use only human-reviewed examples and enforce minimum support', () => {
    const reviewed = Array.from({ length: 10 }, (_, index) => ({
        review_status: 'approved', reviewed_by: 'admin', reviewed_pattern_key: 'breakout_retest',
        outcome: { pnl: index < 7 ? 10 : -10 },
    }));
    reviewed.push({ review_status: 'pending', reviewed_by: null, ai_pattern_key: 'breakout_retest', outcome: { pnl: 1000 } });
    reviewed.push(...Array.from({ length: 7 }, () => ({ review_status: 'corrected', reviewed_by: 'admin', reviewed_pattern_key: 'late_entry', outcome: { pnl: -10 } })));
    const patterns = derivePersonalPatterns(reviewed);
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].patternKey, 'breakout_retest');
    assert.equal(patterns[0].sampleSize, 10);
    assert.equal(patterns[0].wins, 7);
    assert.equal(patterns[0].reliability, 'exploratory');
    assert.equal(patterns[0].comparisonSampleSize, 7);
    assert.equal(patterns[0].baselineWinRate, 0);
});

test('personal pattern reliability requires separation from other reviewed trades', () => {
    const make = (pattern, wins, total) => Array.from({ length: total }, (_, index) => ({
        review_status: 'approved', reviewed_by: 'admin', reviewed_pattern_key: pattern,
        outcome: { pnl: index < wins ? 10 : -10 },
    }));
    const separated = derivePersonalPatterns([...make('breakout_retest', 34, 40), ...make('late_entry', 12, 40)]);
    const strong = separated.find((item) => item.patternKey === 'breakout_retest');
    assert.equal(strong.reliability, 'strong');
    assert.equal(strong.baselineWinRate, 0.3);
    assert.equal(strong.comparisonSampleSize, 40);
    assert.ok(strong.liftInterval95[0] > 0);
    const indistinguishable = derivePersonalPatterns([...make('breakout_retest', 22, 40), ...make('late_entry', 20, 40)]);
    assert.equal(indistinguishable.find((item) => item.patternKey === 'breakout_retest').reliability, 'exploratory');
});

test('admin can recalculate stored personal patterns after statistical changes', () => {
    const adminSource = readFileSync(new URL('../lib/ai_learning_admin.js', import.meta.url), 'utf8');
    assert.match(adminSource, /body\.action === 'refresh-patterns'/);
    assert.match(adminSource, /await refreshPersonalPatterns\(user\.id\)/);
});

test('image metadata inspection reads dimensions without decoding the screenshot', () => {
    const png = Buffer.alloc(24);
    png.write('PNG', 1, 'ascii');
    png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
    assert.deepEqual(inspectImageBuffer(png, 'image/png'), { width: 1920, height: 1080 });
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(640, 6); gif.writeUInt16LE(480, 8);
    assert.deepEqual(inspectImageBuffer(gif, 'image/gif'), { width: 640, height: 480 });
    assert.deepEqual(inspectImageBuffer(Buffer.from('not-image'), 'image/png'), { width: null, height: null });
});

test('evaluation summary separates coverage, selective accuracy and calibration', () => {
    const summary = summarizeEvaluationResults([
        { expectedPatternKey: 'valid_entry', predictedPatternKey: 'valid_entry', confidence: 0.8, exactMatch: true, evidenceComplete: true, abstained: false },
        { expectedPatternKey: 'late_entry', predictedPatternKey: 'valid_entry', confidence: 0.8, exactMatch: false, evidenceComplete: true, abstained: false },
        { expectedPatternKey: 'late_entry', predictedPatternKey: 'unclear', confidence: 0.2, exactMatch: false, evidenceComplete: true, abstained: true },
    ]);
    assert.equal(summary.exactAccuracy, 1 / 3);
    assert.equal(summary.qualityStatus, 'insufficient_gold');
    assert.equal(summary.minimumGoldCases, 30);
    assert.equal(summary.minimumTestCases, 5);
    assert.equal(summary.totalGoldCases, 3);
    assert.equal(summary.selectiveAccuracy, 0.5);
    assert.equal(summary.coverage, 2 / 3);
    assert.ok(summary.brierScore > 0);
    assert.ok(summary.calibrationError > 0);
    assert.equal(summary.confusionMatrix.late_entry.valid_entry, 1);
    assert.equal(summary.perPattern.find((item) => item.patternKey === 'late_entry').recall, 0);
});

test('evaluation readiness requires 30 gold cases and 5 independent holdout cases', () => {
    const result = { expectedPatternKey: 'valid_entry', predictedPatternKey: 'valid_entry', confidence: 0.8, exactMatch: true, evidenceComplete: true, abstained: false };
    assert.equal(summarizeEvaluationResults(Array(5).fill(result), { totalGoldCases: 30 }).qualityStatus, 'measured');
    assert.equal(summarizeEvaluationResults(Array(4).fill(result), { totalGoldCases: 30 }).qualityStatus, 'insufficient_holdout');
    assert.equal(summarizeEvaluationResults(Array(5).fill(result), { totalGoldCases: 29 }).qualityStatus, 'insufficient_gold');
});

test('evaluation generation retries a transient provider failure', async () => {
    let calls = 0;
    const result = await retryAiGeneration(async () => {
        calls++;
        if (calls === 1) throw new Error('Provider returned error');
        return { ai_pattern_key: 'valid_entry' };
    }, { attempts: 2, delayMs: 0 });
    assert.equal(calls, 2);
    assert.equal(result.ai_pattern_key, 'valid_entry');
});

test('process quality is separated from trade outcome without leaking into retrieval text', () => {
    const analysis = { analysis_features: { processScores: { setupValidity: 80, contextFit: 70, entryQuality: 75, riskPlan: 70, executionReadiness: 80 } } };
    assert.equal(deriveProcessOutcomeAssessment(analysis, { pnl: -25 }).quadrant, 'good_process_bad_outcome');
    assert.equal(deriveProcessOutcomeAssessment(analysis, { pnl: 25 }).quadrant, 'skill_confirmed');
    const text = embeddingText({
        source_snapshot: { ticker: 'TEST', aiFeatures: { movement: { phase: 'retest' }, processOutcome: { quadrant: 'skill_confirmed', result: 'profit' } } },
        outcome: { pnl: 25 },
    });
    assert.match(text, /retest/);
    assert.doesNotMatch(text, /skill_confirmed|profit|"pnl"/);
});

test('blind snapshot removes post-trade and prior-AI leakage but keeps setup criteria', () => {
    const blind = outcomeBlindSnapshot({
        ticker: 'TEST', entryPrice: 10, exitPrice: 12, criteria: '700k+', exceptions: '-',
        setup: 'pullback', tradeType: 'standard', tradeComment: 'missed target',
        dayNotes: 'profit', mistakes: 'stopped', aiFeatures: { pattern: 'valid_entry' },
    });
    assert.deepEqual(blind, {
        ticker: 'TEST', entryPrice: 10, criteria: '700k+', exceptions: '-', setup: 'pullback', tradeType: 'standard',
    });
});

test('evaluation holdout keeps the newest reviewed trades for testing', () => {
    const cases = Array.from({ length: 10 }, (_, index) => ({ id: String(index), trade_date: `2026-01-${String(index + 1).padStart(2, '0')}` }));
    const assigned = assignChronologicalSplits(cases);
    assert.deepEqual(assigned.slice(0, 7).map((item) => item.dataset_split), Array(7).fill('train'));
    assert.equal(assigned[7].dataset_split, 'validation');
    assert.deepEqual(assigned.slice(8).map((item) => item.dataset_split), ['test', 'test']);
    assert.deepEqual(assignChronologicalSplits(cases.slice(0, 4)).map((item) => item.dataset_split), Array(4).fill('test'));
});

test('learning cards expose the full human review workflow', () => {
    const source = readFileSync(new URL('../js/ai_learning.js', import.meta.url), 'utf8');
    assert.match(source, /ai-learning-pattern-select/);
    assert.match(source, /reviewButton\('Підтвердити прогноз', 'approve'/);
    assert.match(source, /reviewButton\('Зберегти виправлення', 'correct'/);
    assert.match(source, /reviewButton\('Відхилити', 'reject'/);
    assert.match(source, /if \(example\.review_status === 'pending'\) \{/);
    assert.match(source, /body\.append\(reviewNote\)/);
    assert.match(source, /body\.append\(reviewControls\)/);
});

test('generic free routing resolves to chart-capable vision models', () => {
    assert.equal(resolveOpenRouterVisionModel('openrouter/free', 0), 'google/gemma-4-26b-a4b-it:free');
    assert.equal(resolveOpenRouterVisionModel('openrouter/free', 1), 'nvidia/nemotron-nano-12b-v2-vl:free');
    assert.equal(resolveOpenRouterVisionModel('openrouter/free', 2), 'google/gemma-4-31b-it:free');
    assert.equal(resolveOpenRouterVisionModel('custom/vision:free', 0), 'custom/vision:free');
});

test('semantic trade identity deduplicates legacy AI keys against journal trades', () => {
    const current = { user_id: 'u', journal_day_id: 'd', trade_date: '2026-01-01', trade_key: 'new-key', source_snapshot: { ticker: 'ABCD', entryTime: '10:05', direction: 'long', tradeIndex: 2 } };
    const legacy = { ...current, trade_key: 'old-key', source_snapshot: { ticker: 'abcd', entryTime: '10:05', direction: 'LONG', tradeIndex: 2 } };
    assert.equal(candidateIdentity(current), candidateIdentity(legacy));
    assert.notEqual(candidateIdentity(current), candidateIdentity({ ...legacy, source_snapshot: { ...legacy.source_snapshot, tradeIndex: 3 } }));
});

test('training advances past a candidate that made no progress', () => {
    const candidates = [{ id: 'blocked' }, { id: 'next' }, { id: 'third' }];
    assert.deepEqual(selectFreshCandidateBatch(candidates, 1, 0), [{ id: 'blocked' }]);
    assert.deepEqual(selectFreshCandidateBatch(candidates, 1, 1), [{ id: 'next' }]);
    assert.deepEqual(selectFreshCandidateBatch(candidates, 1, 100), [{ id: 'next' }]);
});

test('training persists the real eligible remaining count instead of estimating from all trades', () => {
    const learningSource = readFileSync(new URL('../lib/ai_learning.js', import.meta.url), 'utf8');
    const runnerSource = readFileSync(new URL('../scripts/continue-ai-training.mjs', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../supabase/migrations/20260802234500_ai_job_remaining_count.sql', import.meta.url), 'utf8');
    assert.match(learningSource, /remaining_count: Number\(run\.remaining_count \|\| 0\)/);
    assert.match(runnerSource, /job\?\.remaining_count \?\? null/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS remaining_count INTEGER/);
});

test('job progress includes examples written by a concurrent training worker', () => {
    const learningSource = readFileSync(new URL('../lib/ai_learning.js', import.meta.url), 'utf8');
    assert.match(learningSource, /prompt_version=eq\.\$\{encodeURIComponent\(job\.prompt_version\)\}&select=id/);
    assert.match(learningSource, /const versionProcessed = \(versionExamples \|\| \[\]\)\.length/);
    assert.match(learningSource, /versionProcessed > Number\(job\.processed_count \|\| 0\)/);
    assert.match(learningSource, /processed_count: versionProcessed/);
});

test('24-hour training advances an active durable job instead of bypassing it', () => {
    const adminSource = readFileSync(new URL('../lib/ai_learning_admin.js', import.meta.url), 'utf8');
    assert.match(adminSource, /if \(body\.action === 'run'\) \{\s*const queued = await processNextLearningJob/s);
    assert.match(adminSource, /campaign: queued\.run \? await updateCampaignAfterRun\(queued\.run, \{ job: queued\.job \}\)/);
    assert.match(adminSource, /status=in\.\(running,processing\).*activeJobs/s);
    assert.match(adminSource, /campaign: await currentTrainingCampaign\(\{ resumeIdleForJob: true \}\)/);
    assert.match(adminSource, /resumeIdleForJob: true/);
    assert.match(adminSource, /durableWorkRemaining/);
    assert.match(adminSource, /const resumableIdle = campaign\?\.status === 'idle' && durableWorkRemaining && campaignWindowOpen/);
    assert.match(adminSource, /campaign\?\.status !== 'running' && !resumableIdle/);
    assert.match(adminSource, /processed: job \? Number\(job\.processed_count \|\| 0\)/);
});

test('Supabase cron wakes durable AI jobs without starting endless fallback training', () => {
    const cronSource = readFileSync(new URL('../api/cron/sync-google-sheets.js', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../supabase/migrations/20260802235500_ai_durable_worker_cron.sql', import.meta.url), 'utf8');
    assert.match(cronSource, /mode.*job-only/);
    assert.match(cronSource, /queued\.job \? queued : \{ job: null, run: null, status: 'idle' \}/);
    assert.match(migration, /cron\.schedule\(/);
    assert.match(migration, /'\*\/2 \* \* \* \*'/);
    assert.match(migration, /mode=job-only/);
    assert.match(migration, /ai_worker_wake_tokens/);
    assert.match(migration, /claim_ai_worker_wake/);
    assert.match(migration, /wakeToken/);
    assert.match(cronSource, /rpc\/claim_ai_worker_wake/);
    assert.match(cronSource, /claimed === true/);
});

test('same-version semantic identity prevents hash-collision starvation', () => {
    const prior = {
        prompt_version: 'v2', user_id: 'u', journal_day_id: 'd', trade_date: '2026-01-01',
        trade_key: 'legacy-key', source_snapshot: { ticker: 'ABCD', entryTime: '10:05', direction: 'long', tradeIndex: 2 },
    };
    const candidate = { ...prior, trade_key: 'new-key', prompt_version: undefined };
    assert.equal(analyzedCandidateIdentities([prior], 'v2').has(candidateIdentity(candidate)), true);
    assert.equal(analyzedCandidateIdentities([prior], 'v3').has(candidateIdentity(candidate)), false);
});

test('training deduplication scopes the database query to the active prompt version', () => {
    const source = readFileSync(new URL('../lib/ai_learning.js', import.meta.url), 'utf8');
    assert.match(source, /ai_learning_examples\?prompt_version=eq\.\$\{encodeURIComponent\(version\)\}/);
});

test('evaluation sync accepts only genuine human-reviewed gold examples', () => {
    const source = readFileSync(new URL('../lib/ai_learning_admin.js', import.meta.url), 'utf8');
    assert.match(source, /review_status=in\.\(approved,corrected\).*reviewed_by=not\.is\.null.*reviewed_pattern_key=not\.is\.null/);
    assert.doesNotMatch(source, /ai_learning_examples\?is_current=eq\.true&review_status=in\.\(approved,corrected\)/);
    assert.match(source, /String\(example\.review_note \|\| ''\)\.startsWith\('\[auto\]'\)/);
    assert.match(source, /if \(!byTrade\.has\(identity\)\) byTrade\.set\(identity, example\)/);
    assert.match(source, /const gold = await syncGoldCases\(user\.id\)/);
    assert.match(source, /staleCases/);
    assert.match(source, /active: false/);
    assert.match(source, /deactivated: staleCases\.length/);
});

test('evaluation output keeps evidence needed to diagnose false classifications', () => {
    const source = readFileSync(new URL('../lib/ai_learning.js', import.meta.url), 'utf8');
    assert.match(source, /visualEvidence: result\.analysis\?\.visual_evidence \|\| \[\]/);
    assert.match(source, /analysisFeatures: result\.analysis\?\.analysis_features \|\| null/);
    assert.match(source, /actualModelName: result\.analysis\?\.actual_model_name \|\| null/);
});

test('human-reviewed memory survives model-version replacement', () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260802233000_preserve_human_ai_memory.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(migration, /AND e\.is_current/);
    assert.match(migration, /review_status IN \('approved', 'corrected'\)/);
    assert.match(migration, /review_note, ''\) NOT LIKE '\[auto\]%'/);
});

test('manual review queue prioritizes evidence-rich uncertain and audit cases', () => {
    const uncertain = {
        id: 'uncertain', screenshot_path: 'screenshots/u/chart.png', ai_pattern_key: 'unclear', ai_confidence: 0.35,
        source_snapshot: { criteria: 'retest', aiFeatures: { evidence: { missing: ['confirmation'] } } }, created_at: '2026-01-02',
    };
    const missingImage = { id: 'missing', ai_pattern_key: 'insufficient_data', ai_confidence: 0, created_at: '2026-01-01' };
    const confident = { id: 'confident', screenshot_path: 'screenshots/u/chart2.png', ai_pattern_key: 'breakout_retest', ai_confidence: 0.9, created_at: '2026-01-03' };
    assert.ok(reviewPriority(uncertain).score > reviewPriority(missingImage).score);
    const ordered = prioritizeReviewExamples([missingImage, confident, uncertain]);
    assert.equal(ordered[0].id, 'uncertain');
    assert.ok(ordered[0].review_priority.reasons.includes('є скріншот'));
});

test('manual review queue diversifies high-priority examples by ticker and date', () => {
    const example = (id, ticker, tradeDate, scorePattern = 'unclear') => ({
        id, trade_date: tradeDate, screenshot_path: `${id}.png`, ai_pattern_key: scorePattern,
        ai_confidence: 0.35, source_snapshot: { ticker, aiFeatures: { evidence: { missing: ['trigger'] } } },
        created_at: `2026-01-0${id}T00:00:00Z`,
    });
    const queue = diversifyReviewExamples([
        example('1', 'AAA', '2026-01-01'), example('2', 'AAA', '2026-01-01'),
        example('3', 'AAA', '2026-01-01'), example('4', 'BBB', '2026-01-02'),
        example('5', 'CCC', '2026-01-03', 'valid_entry'),
    ]);
    assert.deepEqual(queue.slice(0, 3).map((item) => item.source_snapshot.ticker), ['AAA', 'BBB', 'CCC']);
});

test('manual review queue alternates profitable and losing evidence when priorities match', () => {
    const example = (id, pnl) => ({
        id, trade_date: '2026-01-01', screenshot_path: `${id}.png`, ai_pattern_key: 'unclear',
        ai_confidence: 0.35, outcome: { pnl }, source_snapshot: { ticker: 'AAA', aiFeatures: { evidence: { missing: [] } } },
        created_at: `2026-01-0${id}T00:00:00Z`,
    });
    const queue = diversifyReviewExamples([example('1', 10), example('2', 20), example('3', -10), example('4', -20)]);
    assert.deepEqual(queue.slice(0, 2).map((item) => Math.sign(item.outcome.pnl)), [1, -1]);
});

test('quality UI does not overwrite accuracy with category share', () => {
    const source = readFileSync(new URL('../js/ai_learning.js', import.meta.url), 'utf8');
    assert.match(source, /точність.*item\.accuracy.*частка.*share/s);
    assert.doesNotMatch(source, /value\.textContent = `\$\{formatPercent\(share\)\} · \$\{item\.total\}`/);
});

test('quality UI shows progress toward the minimum human gold set', () => {
    const source = readFileSync(new URL('../js/ai_learning.js', import.meta.url), 'utf8');
    const adminSource = readFileSync(new URL('../lib/ai_learning_admin.js', import.meta.url), 'utf8');
    assert.match(source, /summary\.goldCases/);
    assert.match(source, /summary\.goldRemaining/);
    assert.match(source, /summary\.goldPositive/);
    assert.match(source, /summary\.goldNegative/);
    assert.match(adminSource, /minimumGoldCases:\s*30/);
    assert.match(adminSource, /goldRemaining:/);
    assert.match(adminSource, /goldPositive/);
    assert.match(adminSource, /goldNegative/);
    assert.match(adminSource, /activeGoldIds/);
    assert.match(adminSource, /activeGoldIds\.has\(row\.id\)/);
});

test('human gold review requires screenshot attestation and meaningful corrections', () => {
    const uiSource = readFileSync(new URL('../js/ai_learning.js', import.meta.url), 'utf8');
    const adminSource = readFileSync(new URL('../lib/ai_learning_admin.js', import.meta.url), 'utf8');
    assert.match(uiSource, /evidenceReviewed/);
    assert.match(uiSource, /ai-learning-evidence-reviewed/);
    assert.throws(() => validateHumanReview({ example: {}, action: 'approve', evidenceReviewed: true }), /screenshot is required/i);
    assert.throws(() => validateHumanReview({ example: { screenshot_path: 'chart.png' }, action: 'approve' }), /screenshot was reviewed/i);
    assert.equal(validateHumanReview({ example: { screenshot_path: 'chart.png' }, action: 'approve', evidenceReviewed: true }), '');
    assert.throws(() => validateHumanReview({ example: { screenshot_path: 'chart.png' }, action: 'correct', evidenceReviewed: true, note: 'bad' }), /Explain the correction/);
    assert.equal(validateHumanReview({ example: { screenshot_path: 'chart.png' }, action: 'correct', evidenceReviewed: true, note: '  visible trigger was different  ' }), 'visible trigger was different');
    assert.match(adminSource, /if \(!example\.screenshot_path\) continue/);
    assert.match(adminSource, /screenshot_path=not\.is\.null/);
});

test('visual memory and personal patterns exclude journal-only reviews', () => {
    const learningSource = readFileSync(new URL('../lib/ai_learning.js', import.meta.url), 'utf8');
    const adminSource = readFileSync(new URL('../lib/ai_learning_admin.js', import.meta.url), 'utf8');
    assert.match(learningSource, /screenshot_path=not\.is\.null&reviewed_by=not\.is\.null/);
    assert.match(adminSource, /is_current=eq\.true&screenshot_path=not\.is\.null&reviewed_by=not\.is\.null/);
});
