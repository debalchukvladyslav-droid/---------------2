import { requireAdmin, sendJson } from './service_bots.js';
import { supabaseRest } from './google_sheet_sync.js';
import { createEmbedding, embeddingText, PATTERN_KEYS, runLearningBatch } from './ai_learning.js';

export const config = { maxDuration: 300 };

function parseBody(req) {
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    return req.body || {};
}

function pageNumber(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : fallback;
}

function profileName(profile = {}) {
    return [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || profile.nick || 'Трейдер';
}

async function queuePayload(query = {}) {
    const page = pageNumber(query.page);
    const limit = Math.min(30, pageNumber(query.limit, 12));
    const offset = (page - 1) * limit;
    const status = ['pending', 'approved', 'corrected', 'rejected'].includes(String(query.status)) ? String(query.status) : 'pending';
    const examples = await supabaseRest(`ai_learning_examples?is_current=eq.true&review_status=eq.${status}&select=id,user_id,trade_date,trade_key,source_snapshot,outcome,screenshot_path,ai_pattern_key,ai_label,ai_confidence,ai_explanation,visual_evidence,journal_evidence,alternative_pattern_key,review_status,reviewed_pattern_key,review_note,reviewed_at,error_message,created_at&order=created_at.desc&limit=${limit}&offset=${offset}`);
    const userIds = [...new Set((examples || []).map((row) => row.user_id))];
    let profiles = [];
    if (userIds.length) {
        profiles = await supabaseRest(`profiles?id=in.(${userIds.map((id) => encodeURIComponent(`"${id}"`)).join(',')})&select=id,nick,first_name,last_name,team`);
    }
    const byId = new Map((profiles || []).map((profile) => [profile.id, profile]));
    return (examples || []).map((example) => ({
        ...example,
        trader: { ...(byId.get(example.user_id) || {}), display_name: profileName(byId.get(example.user_id)) },
    }));
}

async function overviewPayload() {
    const [examples, runs, versions, journalRows, profiles] = await Promise.all([
        supabaseRest('ai_learning_examples?is_current=eq.true&select=user_id,review_status,ai_pattern_key,reviewed_pattern_key,ai_confidence,screenshot_path,source_snapshot,created_at,reviewed_at'),
        supabaseRest('ai_learning_runs?select=*&order=started_at.desc&limit=12'),
        supabaseRest('ai_learning_versions?active=eq.true&select=*&limit=1'),
        supabaseRest('journal_days?select=id,daily_metrics&limit=1000'),
        supabaseRest('profiles?select=id,nick,first_name,last_name'),
    ]);
    const rows = examples || [];
    const reviewed = rows.filter((row) => ['approved', 'corrected'].includes(row.review_status));
    const agreed = reviewed.filter((row) => row.review_status === 'approved').length;
    const byPattern = {};
    reviewed.forEach((row) => {
        const key = row.reviewed_pattern_key || row.ai_pattern_key || 'unclear';
        const bucket = byPattern[key] || { key, total: 0, agreed: 0 };
        bucket.total++;
        if (row.review_status === 'approved') bucket.agreed++;
        byPattern[key] = bucket;
    });
    const byTrader = {};
    rows.forEach((row) => { byTrader[row.user_id] = (byTrader[row.user_id] || 0) + 1; });
    const profileMap = new Map((profiles || []).map((profile) => [profile.id, profileName(profile)]));
    let candidateTrades = 0;
    for (const row of journalRows || []) candidateTrades += Array.isArray(row.daily_metrics?.trades) ? row.daily_metrics.trades.length : 0;
    const lastRun = runs?.[0] || null;
    const nextRun = new Date();
    nextRun.setUTCHours(21, 0, 0, 0);
    if (nextRun <= new Date()) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    return {
        summary: {
            candidateTrades,
            processed: rows.length,
            pending: rows.filter((row) => row.review_status === 'pending').length,
            approved: reviewed.length,
            rejected: rows.filter((row) => row.review_status === 'rejected').length,
            screenshotCoverage: rows.length ? rows.filter((row) => row.screenshot_path).length / rows.length : null,
            journalCoverage: rows.length ? rows.filter((row) => Object.values(row.source_snapshot || {}).some(Boolean)).length / rows.length : null,
            agreement: reviewed.length ? agreed / reviewed.length : null,
        },
        version: versions?.[0] || null,
        lastRun,
        nextRunAt: nextRun.toISOString(),
        runs: runs || [],
        patterns: Object.values(byPattern).map((item) => ({ ...item, accuracy: item.total ? item.agreed / item.total : null })).sort((a, b) => b.total - a.total),
        traders: Object.entries(byTrader).map(([userId, count]) => ({ userId, name: profileMap.get(userId) || 'Трейдер', count })).sort((a, b) => b.count - a.count).slice(0, 12),
        qualityHistory: [...reviewed].sort((a, b) => String(a.reviewed_at).localeCompare(String(b.reviewed_at))).map((row, index, all) => {
            const slice = all.slice(0, index + 1);
            return { date: row.reviewed_at, accuracy: slice.filter((item) => item.review_status === 'approved').length / slice.length };
        }),
    };
}

async function reviewExample(id, body, userId) {
    const action = String(body.action || 'approve');
    if (!['approve', 'correct', 'reject'].includes(action)) throw Object.assign(new Error('Unknown review action'), { status: 400 });
    const rows = await supabaseRest(`ai_learning_examples?id=eq.${encodeURIComponent(id)}&is_current=eq.true&select=*&limit=1`);
    const example = rows?.[0];
    if (!example) throw Object.assign(new Error('Example not found'), { status: 404 });
    let reviewStatus = action === 'approve' ? 'approved' : action === 'correct' ? 'corrected' : 'rejected';
    let pattern = action === 'approve' ? example.ai_pattern_key : String(body.patternKey || '');
    if (action !== 'reject' && !PATTERN_KEYS.has(pattern)) throw Object.assign(new Error('Invalid pattern category'), { status: 400 });
    const patch = {
        review_status: reviewStatus,
        reviewed_pattern_key: action === 'reject' ? null : pattern,
        review_note: String(body.note || '').trim().slice(0, 1000),
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        embedding: null,
    };
    if (action !== 'reject') patch.embedding = await createEmbedding(embeddingText({ ...example, ...patch }));
    const updated = await supabaseRest(`ai_learning_examples?id=eq.${encodeURIComponent(id)}&select=id,review_status,reviewed_pattern_key,review_note,reviewed_at`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
    });
    if (action !== 'reject') {
        const versions = await supabaseRest('ai_learning_versions?active=eq.true&select=id,memory_version&limit=1');
        if (versions?.[0]) {
            await supabaseRest(`ai_learning_versions?id=eq.${versions[0].id}`, {
                method: 'PATCH', body: JSON.stringify({ memory_version: Number(versions[0].memory_version || 0) + 1 }),
            });
        }
    }
    return updated?.[0] || null;
}

export default async function aiLearningAdminHandler(req, res) {
    try {
        const user = await requireAdmin(req);
        if (req.method === 'GET') {
            const resource = String(req.query?.section || 'overview');
            if (resource === 'overview') return sendJson(res, 200, { ok: true, ...(await overviewPayload()) });
            if (resource === 'queue') return sendJson(res, 200, { ok: true, examples: await queuePayload(req.query || {}) });
            return sendJson(res, 404, { ok: false, error: 'Unknown resource' });
        }
        if (req.method === 'POST') {
            const body = parseBody(req);
            if (body.action !== 'run') return sendJson(res, 400, { ok: false, error: 'Unknown action' });
            return sendJson(res, 200, { ok: true, run: await runLearningBatch({ triggerType: 'manual', userId: user.id }) });
        }
        if (req.method === 'PATCH') {
            const id = String(req.query?.id || '').trim();
            if (!id) return sendJson(res, 400, { ok: false, error: 'Missing example id' });
            return sendJson(res, 200, { ok: true, example: await reviewExample(id, parseBody(req), user.id) });
        }
        res.setHeader('Allow', 'GET, POST, PATCH');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
        return sendJson(res, error?.status || 500, { ok: false, error: error?.message || String(error) });
    }
}
