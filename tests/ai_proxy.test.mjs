import test from 'node:test';
import assert from 'node:assert/strict';

import { openRouterCandidates, payloadHasImages, selectAIProvider } from '../api/gemini.js';
import { summarizeAIPayload } from '../js/ai/telemetry.js';
import { outcomeBlindJournalContext, requireVisualPatternEvidence } from '../js/ai/outcome_guard.js';
import { buildBoundedJournalContext, buildBoundedScreenTagContext } from '../js/ai/journal_context.js';
import { readFile } from 'node:fs/promises';

test('AI client uses Supabase Edge first and Vercel only as fallback', async () => {
    const source = await readFile(new URL('../js/ai/client.js', import.meta.url), 'utf8');
    assert.match(source, /const primaryUrl = geminiEdgeUrl\(\)/);
    assert.match(source, /const fallbackUrl = PROXY_FALLBACK/);
    assert.doesNotMatch(source, /const primaryUrl = hasImage/);
});

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

test('free provider router uses Groq for text and Gemini for vision', () => {
    const env = { GROQ_API_KEY: 'groq', GEMINI_API_KEY: 'gemini' };
    assert.equal(selectAIProvider({ contents: [{ parts: [{ text: 'summary' }] }] }, env), 'groq');
    assert.equal(selectAIProvider({ contents: [{ parts: [{ inlineData: { data: 'abc' } }] }] }, env), 'gemini');
});

test('provider router never sends images to explicitly selected Groq', () => {
    const payload = { contents: [{ parts: [{ inlineData: { data: 'abc' } }] }] };
    assert.equal(selectAIProvider(payload, { AI_PROVIDER: 'groq', GROQ_API_KEY: 'groq', OPENROUTER_API_KEY: 'router' }), 'openrouter');
});

test('general AI proxy keeps configured text routing for requests without images', () => {
    const payload = { contents: [{ parts: [{ text: 'Summarize my trading day' }] }] };
    assert.equal(payloadHasImages(payload), false);
    assert.deepEqual(openRouterCandidates(payload, 'openrouter/free'), ['openrouter/free']);
});

test('vision verification can request a specific free vision model without accepting Gemini ids', () => {
    const payload = { contents: [{ parts: [{ inlineData: { data: 'a'.repeat(1000) } }] }] };
    assert.equal(openRouterCandidates(payload, 'nvidia/nemotron-nano-12b-v2-vl:free')[0], 'nvidia/nemotron-nano-12b-v2-vl:free');
    assert.equal(openRouterCandidates(payload, 'nvidia/nemotron-nano-12b-v2-vl:free')[1], 'google/gemma-4-31b-it:free');
    assert.equal(openRouterCandidates(payload, 'gemini-2.5-flash').includes('gemini-2.5-flash'), false);
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

test('AI chat context is bounded and excludes raw day payloads', () => {
    const journal = Object.fromEntries(Array.from({ length: 140 }, (_, index) => {
        const date = `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`;
        return [date, { secretBlob: 'do not copy', screenshots: ['huge'], notes: 'n'.repeat(800), trades: [{ symbol: 'ABC', pnl: 5, raw: 'omit' }] }];
    }));
    const context = buildBoundedJournalContext(journal);
    assert.equal(Object.keys(context).length, 120);
    assert.equal(JSON.stringify(context).includes('secretBlob'), false);
    assert.equal(JSON.stringify(context).includes('screenshots'), false);
    assert.equal(JSON.stringify(context).includes('"raw"'), false);
    assert.equal(Object.values(context)[0].notes.length, 500);
});

test('AI chat sends only bounded screenshot tag metadata', () => {
    const tags = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`folder/screen-${index}.png`, ['tag']]));
    const context = buildBoundedScreenTagContext(tags);
    assert.equal(Object.keys(context).length, 100);
    assert.ok(Object.keys(context).every((key) => !key.includes('/')));
});
