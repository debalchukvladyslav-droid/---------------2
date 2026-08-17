import test from 'node:test';
import assert from 'node:assert/strict';
import { RagReranker } from '../lib/rag_reranker.js';
import { buildUnifiedEmbeddingText } from '../supabase/functions/_shared/utils/embedder.ts';
import { readFile } from 'node:fs/promises';

test('unified embedding includes voice, vision, setup, RVOL and result', () => {
    const text = buildUnifiedEmbeddingText({ baseText: 'Ticker: XYZ', trade: { symbol: 'XYZ', setup: 'pump-and-dump', rvol: 500, net: -100 }, multimodal: { audio_transcript: 'Chased the breakdown', vision_analysis: JSON.stringify({ summary: 'Failed support break', volumeEvidence: 'Weak sell volume' }) } });
    assert.match(text, /pump-and-dump/); assert.match(text, /RVOL: 500/); assert.match(text, /Failed support break/); assert.match(text, /Chased the breakdown/); assert.match(text, /Trade result: -100/);
});

test('Cohere rerank reorders pgvector candidates and returns top evidence', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({ id: `id-${index}`, trade_text: `trade ${index}`, similarity: 1 - index / 100 }));
    const fetchImpl = async (_url, options) => {
        assert.equal(JSON.parse(options.body).documents.length, 20); assert.equal(JSON.parse(options.body).top_n, 3); assert.ok(options.signal);
        return { ok: true, status: 200, json: async () => ({ results: [{ index: 11, relevance_score: .99 }, { index: 3, relevance_score: .8 }, { index: 18, relevance_score: .7 }] }) };
    };
    const result = await new RagReranker({ environment: { COHERE_API_KEY: 'test' }, fetchImpl, vectorSearch: async ({ matchCount }) => { assert.equal(matchCount, 20); return candidates; } }).retrieve({ question: 'Why did my pump short fail?', queryEmbedding: Array(384).fill(.01), userId: 'user', topN: 3 });
    assert.deepEqual(result.documents.map((item) => item.id), ['id-11', 'id-3', 'id-18']); assert.equal(result.provider, 'cohere-rerank-v4.0-fast');
});

test('reranker degrades to cosine order when free API is unavailable', async () => {
    const candidates = [{ id: 'a', trade_text: 'A' }, { id: 'b', trade_text: 'B' }, { id: 'c', trade_text: 'C' }];
    const result = await new RagReranker({ environment: {}, vectorSearch: async () => candidates }).retrieve({ question: 'ORB mistake', queryEmbedding: Array(384).fill(0), userId: 'user', topN: 3 });
    assert.deepEqual(result.documents.map((item) => item.id), ['a', 'b', 'c']); assert.equal(result.provider, 'pgvector-fallback');
});

test('authenticated AI router exposes bounded pgvector plus Cohere context retrieval', async () => {
    const source = await readFile(new URL('../api/gemini.js', import.meta.url), 'utf8');
    assert.match(source, /action === 'rag-context'/); assert.match(source, /candidateCount: 20/); assert.match(source, /topN: 5/); assert.match(source, /supabaseVectorSearch/); assert.match(source, /req\.headers\.authorization/);
});
