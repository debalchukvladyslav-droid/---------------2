import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deterministicTradeParse, normalizeTradeDraft, SwarmError, SwarmOrchestrator } from '../lib/swarm_orchestrator.js';

test('swarm parser normalizes a short and calculates risk reward', () => {
    const draft = normalizeTradeDraft({ ticker: ' xyz ', direction: 'short', entry: 4, stop: 4.2, exit: 3.6, setup: 'liquidity sweep', rvol: 500, atr: 0.8 });
    assert.equal(draft.ticker, 'XYZ'); assert.equal(draft.direction, 'SHORT'); assert.equal(draft.riskReward, 2); assert.deepEqual(draft.warnings, []);
});

test('swarm parser warns about invalid premarket short geometry', () => {
    const draft = normalizeTradeDraft({ ticker: 'ABC', entry: 5, stop: 4.8, rvol: -1, atr: 0 });
    assert.equal(draft.warnings.length, 3);
});

test('deterministic fallback extracts a usable trade when free APIs are unavailable', () => {
    const draft = deterministicTradeParse('Short XYZ at 4, stopped out at 4.20, liquidity sweep, RVOL 500, ATR 0.80');
    assert.equal(draft.ticker, 'XYZ'); assert.equal(draft.entry, 4); assert.equal(draft.stop, 4.2); assert.equal(draft.setup, 'liquidity sweep'); assert.equal(draft.rvol, 500);
});

test('orchestrator routes structured parsing through the fast Groq agent', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ticker":"pump","direction":"SHORT","entry":8,"stop":8.5,"exit":7,"setup":"pump-and-dump"}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const result = await new SwarmOrchestrator({ environment: { GROQ_API_KEY: 'test-key' }, fetchImpl }).run('swarm-parse', { text: 'Short PUMP at 8, stop 8.5, cover 7.' });
    assert.equal(result.draft.ticker, 'PUMP'); assert.equal(result.draft.riskReward, 2); assert.deepEqual(result.agents, ['groq-parser']); assert.match(calls[0].url, /groq\.com/); assert.equal(calls[0].body.model, 'llama-3.1-8b-instant');
});

test('orchestrator exposes a graceful rate-limit contract', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'limit' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'retry-after': '3' } });
    await assert.rejects(() => new SwarmOrchestrator({ environment: { GROQ_API_KEY: 'test-key' }, fetchImpl }).run('swarm-parse', { text: 'Short XYZ' }), (error) => error instanceof SwarmError && error.code === 'RATE_LIMITED' && error.retryAfter === '3');
});

test('orchestrator routes vision to Gemini with strict timeout and JSON normalization', async () => {
    let request;
    const fetchImpl = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"setup":"ORB","summary":"Failed breakout","levels":[],"volumeEvidence":"Volume expanded","risks":["No retest"],"confidence":0.8}' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const result = await new SwarmOrchestrator({ environment: { GEMINI_API_KEY: 'test' }, fetchImpl }).run('swarm-vision', { mimeType: 'image/png', imageBase64: Buffer.from('png').toString('base64') });
    assert.equal(result.vision.setup, 'ORB'); assert.equal(result.vision.confidence, 0.8); assert.match(request.url, /generativelanguage\.googleapis\.com/); assert.ok(request.options.signal);
});

test('swarm UI exposes microphone, paste zone and persistent vision context', async () => {
    const [html, client, api] = await Promise.all([readFile(new URL('../partials/views/trades-view.html', import.meta.url), 'utf8'), readFile(new URL('../js/swarm_capture.js', import.meta.url), 'utf8'), readFile(new URL('../api/gemini.js', import.meta.url), 'utf8')]);
    assert.match(html, /id="swarm-mic-btn"/); assert.match(html, /id="swarm-dropzone"/); assert.match(client, /new MediaRecorder/); assert.match(client, /addEventListener\('paste'/); assert.match(client, /storage\.from\('trade-charts'\)\.upload/); assert.match(client, /trade_multimodal_inputs/); assert.match(api, /new SwarmOrchestrator\(\)\.run/); assert.match(api, /hydratePrivateChart/); assert.match(api, /voice: 'swarm-voice'.*vision: 'swarm-vision'.*'text-parse': 'swarm-parse'/s);
});

test('multimodal migration creates a private owner-scoped storage contract', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20260817192629_trade_multimodal_storage.sql', import.meta.url), 'utf8');
    assert.match(sql, /'trade-charts', 'trade-charts', false/i); assert.match(sql, /audio_transcript text/i); assert.match(sql, /chart_image_url text/i); assert.match(sql, /vision_analysis text/i); assert.match(sql, /ai_confidence_score integer/i); assert.match(sql, /storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/i); assert.match(sql, /trade_charts_update_owner[\s\S]+using[\s\S]+with check/i);
});
