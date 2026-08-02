import test from 'node:test';
import assert from 'node:assert/strict';

import { openRouterCandidates, payloadHasImages } from '../api/gemini.js';
import { summarizeAIPayload } from '../js/ai/telemetry.js';
import { outcomeBlindJournalContext, requireVisualPatternEvidence } from '../js/ai/outcome_guard.js';

test('general AI proxy routes screenshots only through explicit vision models', () => {
    const payload = { contents: [{ parts: [
        { text: 'Analyze this chart' },
        { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1000) } },
    ] }] };
    assert.equal(payloadHasImages(payload), true);
    const models = openRouterCandidates(payload, 'openrouter/free');
    assert.equal(models.includes('openrouter/free'), false);
    assert.ok(models.length >= 3);
    assert.ok(models.every((model) => model.endsWith(':free')));
});

test('general AI proxy keeps configured text routing for requests without images', () => {
    const payload = { contents: [{ parts: [{ text: 'Summarize my trading day' }] }] };
    assert.equal(payloadHasImages(payload), false);
    assert.deepEqual(openRouterCandidates(payload, 'openrouter/free'), ['openrouter/free']);
});

test('AI request telemetry never stores journal text or image contents', () => {
    const secretJournalText = 'Private journal note and trading plan';
    const encodedImage = 'A'.repeat(1200);
    const summary = summarizeAIPayload({
        systemInstruction: { parts: [{ text: 'System prompt' }] },
        contents: [{ parts: [
            { text: secretJournalText },
            { inlineData: { mimeType: 'image/png', data: encodedImage } },
        ] }],
    });
    assert.equal(summary.redacted, true);
    assert.equal(summary.image_count, 1);
    assert.equal(summary.encoded_image_chars, encodedImage.length);
    assert.equal(JSON.stringify(summary).includes(secretJournalText), false);
    assert.equal(JSON.stringify(summary).includes(encodedImage), false);
});

test('legacy loss-pattern analysis removes outcome and post-trade leakage', () => {
    const blind = outcomeBlindJournalContext({
        direction: 'short', entryPrice: 2, setup: 'retest',
        exitPrice: 1.5, exitReason: 'target', dayNotes: 'won', mistakes: 'none',
    });
    assert.deepEqual(blind, { direction: 'short', entryPrice: 2, setup: 'retest' });
});

test('legacy pattern labels require concrete visual evidence', () => {
    const guarded = requireVisualPatternEvidence({
        patternKey: 'pullback_entry', label: 'Pullback', visualEvidence: '', confidence: 0.91,
    });
    assert.equal(guarded.patternKey, 'unclear');
    assert.equal(guarded.confidence, 0.35);
});
