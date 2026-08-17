const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
const clean = (value, max = 4000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export class RagReranker {
    constructor({ environment = process.env, fetchImpl = fetch, vectorSearch } = {}) {
        this.env = environment; this.fetch = fetchImpl; this.vectorSearch = vectorSearch;
    }

    async retrieve({ question, queryEmbedding, userId, candidateCount = 20, topN = 5 }) {
        const query = clean(question);
        if (!query || !Array.isArray(queryEmbedding) || queryEmbedding.length !== 384) throw new Error('RAG query and 384-dimensional embedding are required');
        if (typeof this.vectorSearch !== 'function') throw new Error('Vector search adapter is required');
        const candidates = (await this.vectorSearch({ queryEmbedding, userId, matchCount: Math.min(20, Math.max(1, candidateCount)) })) || [];
        if (!candidates.length) return { documents: [], provider: 'empty-memory' };
        const fallback = candidates.slice(0, Math.min(5, Math.max(3, topN))).map((item) => ({ ...item, rerank_score: null }));
        const key = clean(this.env.COHERE_API_KEY, 500);
        if (!key) return { documents: fallback, provider: 'pgvector-fallback' };
        let response;
        try {
            response = await this.fetch(COHERE_RERANK_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Client-Name': 'STRUM' }, body: JSON.stringify({ model: this.env.COHERE_RERANK_MODEL || 'rerank-v4.0-fast', query, documents: candidates.map((item) => clean(item.trade_text, 8000)), top_n: Math.min(5, Math.max(3, topN)) }), signal: AbortSignal.timeout(15000) });
        } catch { return { documents: fallback, provider: 'pgvector-fallback' }; }
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(data.results)) return { documents: fallback, provider: response.status === 429 ? 'pgvector-rate-limit-fallback' : 'pgvector-fallback' };
        const documents = data.results.map((rank) => candidates[rank.index] ? { ...candidates[rank.index], rerank_score: Number(rank.relevance_score) } : null).filter(Boolean);
        return { documents, provider: 'cohere-rerank-v4.0-fast' };
    }
}

export function supabaseVectorSearch({ url, serviceKey, fetchImpl = fetch }) {
    return async ({ queryEmbedding, userId, matchCount }) => {
        const response = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/rpc/match_trade_embeddings`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query_embedding: queryEmbedding, match_count: matchCount, filter_user_id: userId }), signal: AbortSignal.timeout(15000) });
        const data = await response.json().catch(() => ([]));
        if (!response.ok) throw new Error(`pgvector search failed (${response.status})`);
        return data;
    };
}
