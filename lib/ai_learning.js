import crypto from 'node:crypto';
import { getSupabaseEnv, supabaseRest } from './google_sheet_sync.js';

export const AI_MODEL = 'gemini-2.5-flash';
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const PROMPT_VERSION = 'entry-memory-v3';
export const PATTERN_KEYS = new Set([
    'late_entry', 'chase_extension', 'weak_breakout', 'countertrend', 'no_structure',
    'early_entry', 'poor_rr', 'stop_violation', 'repeated_entry', 'valid_entry',
    'failed_follow_through', 'parabolic_extension', 'breakout_retest', 'pullback_entry',
    'liquidity_sweep', 'range_entry', 'trend_continuation', 'confirmed_reversal',
    'volume_mismatch', 'unclear', 'insufficient_data',
]);

const MAX_BATCH = 8;
const AUTO_MEMORY_CONFIDENCE = 0.7;
const MEMORY_EXCLUDED_PATTERNS = new Set(['unclear', 'insufficient_data', 'no_structure']);
const STRUCTURE_REVIEW_INSTRUCTION = `Analyze the chart structure before choosing a label. Compare the current movement, entry location, follow-through and level interaction with the supplied reviewed examples and preliminary visual pass. Reuse a known pattern when the visual evidence is materially similar. "no_structure" is a last-resort label: use it only when you can name concrete visible evidence that price has no readable range, trend, breakout, pullback, retest, reversal, continuation or liquidity-sweep structure. Missing context or an unreadable image must be "insufficient_data", never "no_structure". Do not infer the label from PnL.`;

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

function normalizedTicker(value) {
    return compact(value, 24).toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

function tradeScreens(trade, metrics, tradeCount, profileContext = {}) {
    const ticker = compact(trade?.symbol || trade?.ticker || trade?.sheet?.ticker, 20).toUpperCase();
    const candidates = allScreens(metrics);
    const tickerMap = profileContext.tickers && typeof profileContext.tickers === 'object' ? profileContext.tickers : {};
    const screenTags = profileContext.screenTags && typeof profileContext.screenTags === 'object' ? profileContext.screenTags : {};
    const wanted = normalizedTicker(ticker);
    const matched = wanted ? candidates.filter((item) => {
        const mapped = normalizedTicker(tickerMap[item.path]);
        const tags = Array.isArray(screenTags[item.path]) ? screenTags[item.path].map(normalizedTicker) : [];
        return mapped === wanted || tags.includes(wanted) || normalizedTicker(String(item.path).split(/[\\/]/).pop()).includes(wanted);
    }) : [];
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

export function buildCandidates(rows = [], profileContexts = new Map()) {
    const output = [];
    for (const row of rows) {
        const metrics = row.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
        const trades = Array.isArray(metrics.trades) ? metrics.trades : [];
        trades.forEach((trade, index) => {
            const snapshot = tradeSnapshot(row, trade, index);
            const outcome = tradeOutcome(row, trade);
            const screens = tradeScreens(trade, metrics, trades.length, profileContexts.get(row.user_id) || {});
            const screenshot = screens[0] || null;
            const tradeKey = `${row.user_id}:${row.trade_date}:${index}:${snapshot.ticker || 'trade'}`;
            const contentHash = crypto.createHash('sha256').update(JSON.stringify({ promptVersion: PROMPT_VERSION, tradeKey, snapshot, outcome, screenshot })).digest('hex');
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
    const movement = value.movement && typeof value.movement === 'object' ? value.movement : {};
    const execution = value.execution && typeof value.execution === 'object' ? value.execution : {};
    const context = value.context && typeof value.context === 'object' ? value.context : {};
    const signals = Array.isArray(value.signals) ? value.signals.map((item) => compact(item, 100)).filter(Boolean).slice(0, 8) : [];
    return {
        ai_pattern_key: patternKey,
        ai_label: compact(value.label || patternKey, 100),
        ai_confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
        ai_explanation: compact(value.explanation, 800),
        visual_evidence: compact(value.visualEvidence, 500),
        journal_evidence: compact(value.journalEvidence, 500),
        alternative_pattern_key: PATTERN_KEYS.has(value.alternativePatternKey) ? value.alternativePatternKey : null,
        analysis_features: {
            movement: {
                phase: compact(movement.phase, 40),
                direction: compact(movement.direction, 20),
                strength: Math.max(0, Math.min(1, Number(movement.strength) || 0)),
                extension: compact(movement.extension, 30),
                followThrough: compact(movement.followThrough, 30),
                structure: compact(movement.structure, 60),
                entryLocation: compact(movement.entryLocation, 60),
            },
            execution: {
                timing: compact(execution.timing, 40),
                confirmation: compact(execution.confirmation, 60),
                trendAlignment: compact(execution.trendAlignment, 40),
                riskReward: compact(execution.riskReward, 40),
                stopQuality: compact(execution.stopQuality, 40),
            },
            context: {
                levelInteraction: compact(context.levelInteraction, 60),
                volumeSignal: compact(context.volumeSignal, 60),
                volatility: compact(context.volatility, 40),
                journalAlignment: compact(context.journalAlignment, 60),
            },
            signals,
        },
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
    const prompt = `Ти виконуєш другий, поглиблений прохід аналізу входу трейдера. Використай накопичену пам'ять схожих угод, але перевіряй висновок за поточним скріном і журналом. Результат угоди є лише сигналом: плюс не доводить правильність, мінус не доводить помилку.
Окремо визнач:
- фазу руху: impulse, pullback, breakout, retest, reversal, range, exhaustion або unclear;
- напрям і силу руху, розтягнутість, follow-through, структуру та місце входу відносно руху/рівня;
- таймінг, наявність підтвердження, відповідність тренду, R/R і якість стопа;
- взаємодію з рівнем, волатильність, відповідність запису журналу;
- volumeSignal лише якщо об'єм справді видно на скріні, інакше "not_visible";
- короткі незалежні signals, за якими потім можна групувати закономірності.
Не вигадуй свічки, рівні, об'єм або контекст, яких не видно. Якщо даних замало — insufficient_data.
Основна категорія лише з: ${[...PATTERN_KEYS].join(', ')}.
Поверни ТІЛЬКИ JSON {"patternKey":"...","label":"...","confidence":0.0,"explanation":"...","visualEvidence":"...","journalEvidence":"...","alternativePatternKey":"...","movement":{"phase":"...","direction":"...","strength":0.0,"extension":"...","followThrough":"...","structure":"...","entryLocation":"..."},"execution":{"timing":"...","confirmation":"...","trendAlignment":"...","riskReward":"...","stopQuality":"..."},"context":{"levelInteraction":"...","volumeSignal":"...","volatility":"...","journalAlignment":"..."},"signals":["..."]}.
Угода: ${JSON.stringify(candidate.source_snapshot)}
Результат: ${JSON.stringify(candidate.outcome)}
Підтверджені схожі приклади першого й другого проходу: ${JSON.stringify(similar)}`;
    const parts = [{ text: prompt }];
    if (image) parts.push({ inline_data: image });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${key}`, {
        method: 'POST', headers: geminiRequestHeaders(),
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: STRUCTURE_REVIEW_INSTRUCTION }] },
            contents: [{ parts }],
            generationConfig: { temperature: 0.12, responseMimeType: 'application/json' },
        }),
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
    return JSON.stringify({
        trade: example.source_snapshot,
        visualFeatures: example.analysis_features || example.source_snapshot?.aiFeatures || null,
        visualEvidence: example.visual_evidence || '',
        signals: example.analysis_features?.signals || example.source_snapshot?.aiFeatures?.signals || [],
        result: example.outcome,
        pattern: example.reviewed_pattern_key || example.ai_pattern_key,
        note: example.review_note || '',
    });
}

export function isMemoryEligible(example) {
    return Number(example?.ai_confidence) >= AUTO_MEMORY_CONFIDENCE
        && !MEMORY_EXCLUDED_PATTERNS.has(example?.ai_pattern_key);
}

async function currentMemory(candidate, limit = 5) {
    const queryEmbedding = await createEmbedding(embeddingText(candidate), 'RETRIEVAL_QUERY');
    if (queryEmbedding) {
        try {
            const matches = await supabaseRest('rpc/match_ai_learning_examples', {
                method: 'POST',
                body: JSON.stringify({ query_embedding: queryEmbedding, match_count: Math.min(10, limit + 2) }),
            });
            return (matches || []).filter((item) => !MEMORY_EXCLUDED_PATTERNS.has(item.pattern_key)).slice(0, limit);
        } catch (_) { /* fall back to recent reviewed memory */ }
    }
    const rows = await supabaseRest(`ai_learning_examples?user_id=eq.${candidate.user_id}&is_current=eq.true&review_status=in.(approved,corrected)&select=reviewed_pattern_key,ai_pattern_key,source_snapshot,outcome,review_note,visual_evidence&order=reviewed_at.desc&limit=${Math.min(20, limit + 5)}`);
    return (rows || []).filter((item) => !MEMORY_EXCLUDED_PATTERNS.has(item.reviewed_pattern_key || item.ai_pattern_key)).slice(0, limit);
}

async function promotePendingExamples(limit = 30) {
    const pending = await supabaseRest(`ai_learning_examples?is_current=eq.true&review_status=eq.pending&select=id,source_snapshot,outcome,ai_pattern_key,ai_confidence,review_note&order=created_at.asc&limit=${limit}`);
    let promoted = 0;
    for (const example of pending || []) {
        const canEnterMemory = isMemoryEligible(example);
        const patch = {
            review_status: canEnterMemory ? 'approved' : 'rejected',
            reviewed_pattern_key: canEnterMemory ? example.ai_pattern_key : null,
            review_note: canEnterMemory
                ? '[auto] Підтверджено автономним контуром'
                : '[auto] Не додано в еталонну пам’ять через низьку впевненість',
            reviewed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            embedding: canEnterMemory ? await createEmbedding(embeddingText({ ...example, reviewed_pattern_key: example.ai_pattern_key })) : null,
        };
        await supabaseRest(`ai_learning_examples?id=eq.${example.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        promoted++;
    }
    return promoted;
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
        await promotePendingExamples();
        const [rows, profiles] = await Promise.all([
            supabaseRest('journal_days?select=id,user_id,trade_date,pnl,kf,notes,daily_metrics&order=trade_date.desc&limit=1000'),
            supabaseRest('profiles?select=id,settings'),
        ]);
        const profileContexts = new Map((profiles || []).map((profile) => [profile.id, {
            tickers: profile.settings?.tickers || {},
            screenTags: profile.settings?.screenTags || {},
        }]));
        const candidates = buildCandidates(rows || [], profileContexts);
        scanned = candidates.length;
        const existingRows = candidates.length ? await supabaseRest('ai_learning_examples?select=content_hash&limit=5000') : [];
        const existing = new Set((existingRows || []).map((row) => row.content_hash));
        const fresh = candidates.filter((candidate) => !existing.has(candidate.content_hash));
        skipped = candidates.length - fresh.length;
        const batch = fresh.slice(0, Math.max(1, Math.min(20, batchSize)));
        console.info(`[AI learning] Starting batch: ${batch.length} new trades (${skipped} unchanged)`);
        for (const [index, candidate] of batch.entries()) {
            const progress = `${index + 1}/${batch.length}`;
            console.info(`[AI learning] ${progress} Reviewing screenshot`, {
                ticker: candidate.source_snapshot?.ticker || '—', date: candidate.trade_date,
                screenshot: candidate.screenshot_path || 'missing',
            });
            try {
                const previous = await supabaseRest(`ai_learning_examples?user_id=eq.${candidate.user_id}&trade_key=eq.${encodeURIComponent(candidate.trade_key)}&select=id,source_version&order=source_version.desc&limit=1`);
                console.info(`[AI learning] ${progress} First visual pass`);
                const preliminary = await geminiGenerate(candidate, []);
                const memoryCandidate = {
                    ...candidate,
                    source_snapshot: { ...candidate.source_snapshot, aiFeatures: preliminary.analysis_features },
                    analysis_features: preliminary.analysis_features,
                    visual_evidence: preliminary.visual_evidence,
                };
                console.info(`[AI learning] ${progress} Searching reviewed pattern memory`);
                const memory = await currentMemory(memoryCandidate, 8);
                console.info(`[AI learning] ${progress} Comparing with ${memory.length} remembered examples`);
                const analysis = await geminiGenerate(candidate, { preliminary, reviewedExamples: memory });
                const { analysis_features: analysisFeatures, ...analysisColumns } = analysis;
                const canEnterMemory = isMemoryEligible(analysis);
                const reviewedAt = new Date().toISOString();
                const embedding = canEnterMemory
                    ? await createEmbedding(embeddingText({
                        ...candidate,
                        ...analysis,
                        source_snapshot: { ...candidate.source_snapshot, aiFeatures: analysisFeatures },
                        reviewed_pattern_key: analysis.ai_pattern_key,
                        review_note: '[auto] Підтверджено автономним контуром',
                    }))
                    : null;
                const inserted = await supabaseRest('ai_learning_examples?select=id', {
                    method: 'POST', headers: { Prefer: 'return=representation' },
                    body: JSON.stringify({
                        ...candidate,
                        ...analysisColumns,
                        source_snapshot: { ...candidate.source_snapshot, aiFeatures: analysisFeatures },
                        source_version: Number(previous?.[0]?.source_version || 0) + 1,
                        run_id: run.id,
                        model_name: AI_MODEL,
                        prompt_version: PROMPT_VERSION,
                        review_status: canEnterMemory ? 'approved' : 'rejected',
                        reviewed_pattern_key: canEnterMemory ? analysis.ai_pattern_key : null,
                        review_note: canEnterMemory
                            ? '[auto] Підтверджено автономним контуром'
                            : '[auto] Не додано в еталонну пам’ять через низьку впевненість',
                        reviewed_at: reviewedAt,
                        embedding,
                    }),
                });
                if (previous?.length && inserted?.[0]?.id) {
                    await supabaseRest(`ai_learning_examples?user_id=eq.${candidate.user_id}&trade_key=eq.${encodeURIComponent(candidate.trade_key)}&id=neq.${inserted[0].id}&is_current=eq.true`, {
                        method: 'PATCH', body: JSON.stringify({ is_current: false, updated_at: new Date().toISOString() }),
                    });
                }
                created++; processed++;
                console.info(`[AI learning] ${progress} Completed`, {
                    pattern: analysis.ai_pattern_key, confidence: analysis.ai_confidence, remembered: canEnterMemory,
                });
            } catch (error) {
                console.error(`[AI learning] ${progress} Failed`, candidate.trade_key, error);
                errors.push({ tradeKey: candidate.trade_key, message: String(error?.message || error).slice(0, 300) });
            }
        }
        const failed = errors.length;
        const status = failed ? (processed ? 'partial' : 'failed') : 'completed';
        console.info(`[AI learning] Batch ${status}: ${processed} completed, ${failed} failed, ${skipped} skipped`);
        await supabaseRest(`ai_learning_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status, scanned_count: scanned, created_count: created, processed_count: processed, skipped_count: skipped, failed_count: failed, error_summary: errors, estimated_cost_usd: Number((processed * 0.001).toFixed(4)), finished_at: new Date().toISOString() }) });
        return { ...run, status, scanned_count: scanned, created_count: created, processed_count: processed, skipped_count: skipped, failed_count: failed, errors };
    } catch (error) {
        await supabaseRest(`ai_learning_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', scanned_count: scanned, created_count: created, processed_count: processed, skipped_count: skipped, failed_count: errors.length + 1, error_summary: [...errors, { message: String(error?.message || error).slice(0, 300) }], finished_at: new Date().toISOString() }) });
        throw error;
    }
}
