import crypto from 'node:crypto';
import { getSupabaseEnv, supabaseRest } from './google_sheet_sync.js';

export const AI_MODEL = 'gemini-2.5-flash';
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const PROMPT_VERSION = 'entry-mistake-v1';
export const PATTERN_KEYS = new Set([
    'late_entry', 'chase_extension', 'weak_breakout', 'countertrend', 'no_structure',
    'early_entry', 'poor_rr', 'stop_violation', 'repeated_entry', 'valid_entry',
    'unclear', 'insufficient_data',
]);

const MAX_BATCH = 8;

function env(...names) {
    return names.map((name) => String(process.env[name] || '').trim()).find(Boolean) || '';
}

function geminiRequestHeaders() {
    const raw = env('GEMINI_REFERER', 'APP_PUBLIC_URL', 'NEXT_PUBLIC_SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL')
        || 'https://traderjournal-six.vercel.app';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const origin = new URL(withProtocol).origin;
        return { 'Content-Type': 'application/json', Referer: `${origin}/`, Origin: origin };
    } catch (_) {
        return { 'Content-Type': 'application/json' };
    }
}

function compact(value, max = 500) {
    if (Array.isArray(value)) value = value.filter(Boolean).join('; ');
    if (value && typeof value === 'object') value = Object.values(value).filter((v) => ['string', 'number'].includes(typeof v)).join('; ');
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    const parsed = Number.parseFloat(String(value).replace(',', '.').replace(/[^0-9.+-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function allScreens(metrics = {}) {
    const screens = metrics.screenshots && typeof metrics.screenshots === 'object' ? metrics.screenshots : {};
    return ['good', 'normal', 'bad', 'error'].flatMap((category) =>
        (Array.isArray(screens[category]) ? screens[category] : []).map((path) => ({ path, category })),
    ).filter((item) => item.path);
}

function tradeScreens(trade, metrics, tradeCount) {
    const ticker = compact(trade?.symbol || trade?.ticker || trade?.sheet?.ticker, 20).toUpperCase();
    const candidates = allScreens(metrics);
    const matched = ticker ? candidates.filter((item) => String(item.path).toUpperCase().includes(ticker)) : [];
    return matched.length ? matched : (tradeCount === 1 ? candidates : []);
}

function tradeSnapshot(row, trade, index) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    return {
        tradeDate: row.trade_date,
        tradeIndex: index,
        ticker: compact(trade?.symbol || trade?.ticker || sheet.ticker, 24),
        entryTime: compact(trade?.entryTime || trade?.opened || trade?.time || sheet.entryTime, 40),
        direction: compact(trade?.direction || trade?.side || trade?.position, 30),
        entryPrice: numberOrNull(trade?.entryPrice ?? trade?.entry ?? trade?.openPrice),
        exitPrice: numberOrNull(trade?.exitPrice ?? trade?.exit ?? trade?.closePrice),
        tradeType: compact(trade?.tradeType || trade?.type || sheet.tradeType, 160),
        setup: compact(trade?.setup || trade?.strategy || sheet.setup, 160),
        criteria: compact(trade?.criteria || trade?.criterion || sheet.criteria || sheet.criterion),
        exceptions: compact(trade?.exceptions || trade?.exception || sheet.exceptions || sheet.exception),
        tradeComment: compact(trade?.comment || trade?.notes || trade?.review || sheet.comment),
        dayNotes: compact(row.notes || row.daily_metrics?.notes || row.daily_metrics?.comment),
        mistakes: compact(row.daily_metrics?.mistakes || row.daily_metrics?.errors || row.daily_metrics?.errorNotes),
    };
}

function tradeOutcome(row, trade) {
    return {
        pnl: numberOrNull(trade?.net ?? trade?.pnl ?? trade?.profit ?? row.pnl),
        kf: numberOrNull(trade?.kf ?? trade?.profitRisk ?? trade?.sheet?.profitRisk ?? row.kf),
        dayPnl: numberOrNull(row.pnl),
        dayKf: numberOrNull(row.kf),
    };
}

export function buildCandidates(rows = []) {
    const output = [];
    for (const row of rows) {
        const metrics = row.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
        const trades = Array.isArray(metrics.trades) ? metrics.trades : [];
        trades.forEach((trade, index) => {
            const snapshot = tradeSnapshot(row, trade, index);
            const outcome = tradeOutcome(row, trade);
            const screens = tradeScreens(trade, metrics, trades.length);
            const screenshot = screens[0] || null;
            const tradeKey = `${row.user_id}:${row.trade_date}:${index}:${snapshot.ticker || 'trade'}`;
            const contentHash = crypto.createHash('sha256').update(JSON.stringify({ tradeKey, snapshot, outcome, screenshot })).digest('hex');
            output.push({
                user_id: row.user_id,
                journal_day_id: row.id,
                trade_date: row.trade_date,
                trade_key: tradeKey,
                content_hash: contentHash,
                source_snapshot: snapshot,
                outcome,
                screenshot_path: screenshot?.path || null,
            });
        });
    }
    return output.sort((a, b) => Number(!!b.screenshot_path) - Number(!!a.screenshot_path) || String(b.trade_date).localeCompare(String(a.trade_date)));
}

function parseAiJson(text) {
    const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const value = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
    const patternKey = PATTERN_KEYS.has(value.patternKey) ? value.patternKey : 'unclear';
    return {
        ai_pattern_key: patternKey,
        ai_label: compact(value.label || patternKey, 100),
        ai_confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
        ai_explanation: compact(value.explanation, 800),
        visual_evidence: compact(value.visualEvidence, 500),
        journal_evidence: compact(value.journalEvidence, 500),
        alternative_pattern_key: PATTERN_KEYS.has(value.alternativePatternKey) ? value.alternativePatternKey : null,
    };
}

async function storageImage(path) {
    if (!path) return null;
    const { url, serviceKey } = getSupabaseEnv();
    const objectPath = String(path).replace(/^screenshots\//, '');
    const response = await fetch(`${url}/storage/v1/object/screenshots/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 7 * 1024 * 1024) return null;
    return { mime_type: response.headers.get('content-type') || 'image/jpeg', data: buffer.toString('base64') };
}

async function geminiGenerate(candidate, similar = []) {
    const key = env('GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_KEY');
    if (!key) throw new Error('GEMINI_API_KEY is not configured');
    const image = await storageImage(candidate.screenshot_path);
    const prompt = `Ти класифікуєш якість входу трейдера. Результат угоди є лише сигналом: плюс не доводить правильність, мінус не доводить помилку. Використай скрін і журнал разом. Якщо даних замало — insufficient_data. Категорії: ${[...PATTERN_KEYS].join(', ')}. Поверни ТІЛЬКИ JSON {"patternKey":"...","label":"...","confidence":0.0,"explanation":"...","visualEvidence":"...","journalEvidence":"...","alternativePatternKey":"..."}.\nУгода: ${JSON.stringify(candidate.source_snapshot)}\nРезультат: ${JSON.stringify(candidate.outcome)}\nПідтверджені схожі приклади: ${JSON.stringify(similar)}`;
    const parts = [{ text: prompt }];
    if (image) parts.push({ inline_data: image });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${key}`, {
        method: 'POST', headers: geminiRequestHeaders(),
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.12, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(50000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini ${response.status}`);
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return parseAiJson(text);
}

export async function createEmbedding(text, taskType = 'RETRIEVAL_DOCUMENT') {
    const key = env('GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_KEY');
    if (!key) return null;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${key}`, {
        method: 'POST', headers: geminiRequestHeaders(),
        body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: 768, taskType }),
        signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    return response.ok && Array.isArray(payload?.embedding?.values) ? payload.embedding.values : null;
}

export function embeddingText(example) {
    return JSON.stringify({ trade: example.source_snapshot, result: example.outcome, pattern: example.reviewed_pattern_key || example.ai_pattern_key, note: example.review_note || '' });
}

async function currentMemory(candidate, limit = 5) {
    const queryEmbedding = await createEmbedding(embeddingText(candidate), 'RETRIEVAL_QUERY');
    if (queryEmbedding) {
        try {
            return await supabaseRest('rpc/match_ai_learning_examples', {
                method: 'POST',
                body: JSON.stringify({ query_embedding: queryEmbedding, match_count: limit }),
            });
        } catch (_) { /* fall back to recent reviewed memory */ }
    }
    return supabaseRest(`ai_learning_examples?is_current=eq.true&review_status=in.(approved,corrected)&select=reviewed_pattern_key,ai_pattern_key,source_snapshot,outcome,review_note&order=reviewed_at.desc&limit=${limit}`);
}

export async function runLearningBatch({ triggerType = 'manual', userId = null, batchSize = MAX_BATCH } = {}) {
    const runRows = await supabaseRest('ai_learning_runs?select=*', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ trigger_type: triggerType, created_by: userId, model_name: AI_MODEL, prompt_version: PROMPT_VERSION }),
    });
    const run = runRows[0];
    const errors = [];
    let scanned = 0; let created = 0; let processed = 0; let skipped = 0;
    try {
        const rows = await supabaseRest('journal_days?select=id,user_id,trade_date,pnl,kf,notes,daily_metrics&order=trade_date.desc&limit=1000');
        const candidates = buildCandidates(rows || []);
        scanned = candidates.length;
        const existingRows = candidates.length ? await supabaseRest('ai_learning_examples?select=content_hash&limit=5000') : [];
        const existing = new Set((existingRows || []).map((row) => row.content_hash));
        const fresh = candidates.filter((candidate) => !existing.has(candidate.content_hash));
        skipped = candidates.length - fresh.length;
        for (const candidate of fresh.slice(0, Math.max(1, Math.min(20, batchSize)))) {
            try {
                const previous = await supabaseRest(`ai_learning_examples?user_id=eq.${candidate.user_id}&trade_key=eq.${encodeURIComponent(candidate.trade_key)}&select=id,source_version&order=source_version.desc&limit=1`);
                const memory = await currentMemory(candidate);
                const analysis = await geminiGenerate(candidate, memory);
                const inserted = await supabaseRest('ai_learning_examples?select=id', {
                    method: 'POST', headers: { Prefer: 'return=representation' },
                    body: JSON.stringify({ ...candidate, ...analysis, source_version: Number(previous?.[0]?.source_version || 0) + 1, run_id: run.id, model_name: AI_MODEL, prompt_version: PROMPT_VERSION }),
                });
                if (previous?.length && inserted?.[0]?.id) {
                    await supabaseRest(`ai_learning_examples?user_id=eq.${candidate.user_id}&trade_key=eq.${encodeURIComponent(candidate.trade_key)}&id=neq.${inserted[0].id}&is_current=eq.true`, {
                        method: 'PATCH', body: JSON.stringify({ is_current: false, updated_at: new Date().toISOString() }),
                    });
                }
                created++; processed++;
            } catch (error) {
                errors.push({ tradeKey: candidate.trade_key, message: String(error?.message || error).slice(0, 300) });
            }
        }
        const failed = errors.length;
        const status = failed ? (processed ? 'partial' : 'failed') : 'completed';
        await supabaseRest(`ai_learning_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status, scanned_count: scanned, created_count: created, processed_count: processed, skipped_count: skipped, failed_count: failed, error_summary: errors, estimated_cost_usd: Number((processed * 0.001).toFixed(4)), finished_at: new Date().toISOString() }) });
        return { ...run, status, scanned_count: scanned, created_count: created, processed_count: processed, skipped_count: skipped, failed_count: failed, errors };
    } catch (error) {
        await supabaseRest(`ai_learning_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', scanned_count: scanned, created_count: created, processed_count: processed, skipped_count: skipped, failed_count: errors.length + 1, error_summary: [...errors, { message: String(error?.message || error).slice(0, 300) }], finished_at: new Date().toISOString() }) });
        throw error;
    }
}
