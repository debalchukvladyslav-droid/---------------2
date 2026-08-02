import { requireAdmin, sendJson } from './service_bots.js';
import { supabaseRest } from './google_sheet_sync.js';
import { assignChronologicalSplits, candidateIdentity, createEmbedding, derivePersonalPatterns, embeddingText, PATTERN_KEYS, processNextLearningJob, runEvaluationSuite, runLearningBatch } from './ai_learning.js';
import { diversifyReviewExamples } from './ai_review_priority.js';

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

export function validateHumanReview({ example = {}, action = 'approve', evidenceReviewed = false, note = '' } = {}) {
    const cleanNote = String(note || '').trim().slice(0, 1000);
    if (!example.screenshot_path && action !== 'reject') {
        throw Object.assign(new Error('A screenshot is required before an example can enter visual AI memory'), { status: 400 });
    }
    if (example.screenshot_path && action !== 'reject' && evidenceReviewed !== true) {
        throw Object.assign(new Error('Confirm that the screenshot was reviewed before adding this example to AI memory'), { status: 400 });
    }
    if (action === 'correct' && cleanNote.length < 5) {
        throw Object.assign(new Error('Explain the correction so the AI can learn from it'), { status: 400 });
    }
    return cleanNote;
}

async function queuePayload(query = {}) {
    const page = pageNumber(query.page);
    const limit = Math.min(30, pageNumber(query.limit, 12));
    const offset = (page - 1) * limit;
    const status = ['pending', 'approved', 'corrected', 'rejected'].includes(String(query.status)) ? String(query.status) : 'pending';
    const screenshotFilter = status === 'pending' ? '&screenshot_path=not.is.null' : '';
    const rawExamples = await supabaseRest(`ai_learning_examples?is_current=eq.true&review_status=eq.${status}${screenshotFilter}&select=id,user_id,trade_date,trade_key,source_snapshot,outcome,screenshot_path,ai_pattern_key,ai_label,ai_confidence,ai_explanation,visual_evidence,journal_evidence,alternative_pattern_key,review_status,reviewed_pattern_key,review_note,reviewed_at,error_message,created_at&order=created_at.desc&limit=${status === 'pending' ? 500 : limit}&offset=${status === 'pending' ? 0 : offset}`);
    const examples = status === 'pending'
        ? diversifyReviewExamples(rawExamples || []).slice(offset, offset + limit)
        : (rawExamples || []);
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
    const [examples, runs, versions, journalRows, profiles, personalPatterns, jobs, evaluationCases, goldExamples] = await Promise.all([
        supabaseRest('ai_learning_examples?is_current=eq.true&select=id,user_id,journal_day_id,trade_date,trade_key,review_status,review_note,reviewed_by,ai_pattern_key,reviewed_pattern_key,ai_confidence,screenshot_path,source_snapshot,outcome,created_at,reviewed_at'),
        supabaseRest('ai_learning_runs?select=*&order=started_at.desc&limit=12'),
        supabaseRest('ai_learning_versions?active=eq.true&select=*&limit=1'),
        supabaseRest('journal_days?select=id,daily_metrics&limit=1000'),
        supabaseRest('profiles?select=id,nick,first_name,last_name'),
        supabaseRest('ai_user_patterns?active=eq.true&select=*&order=sample_size.desc&limit=50'),
        supabaseRest('ai_learning_jobs?select=*&order=started_at.desc&limit=5'),
        supabaseRest('ai_evaluation_cases?active=eq.true&select=dataset_split,example_id&limit=1000'),
        supabaseRest('ai_learning_examples?review_status=in.(approved,corrected)&reviewed_by=not.is.null&screenshot_path=not.is.null&select=id,user_id,journal_day_id,trade_date,trade_key,review_note,outcome,screenshot_path&order=reviewed_at.desc&limit=1000'),
    ]);
    const rows = examples || [];
    const reviewed = rows.filter((row) => ['approved', 'corrected'].includes(row.review_status));
    const adminReviewed = reviewed.filter((row) => row.reviewed_pattern_key && !String(row.review_note || '').startsWith('[auto]'));
    const activeGoldIds = new Set((evaluationCases || []).map((row) => row.example_id).filter(Boolean));
    const visualGoldByTrade = new Map();
    (goldExamples || []).filter((row) => activeGoldIds.has(row.id) && !String(row.review_note || '').startsWith('[auto]')).forEach((row) => {
        const identity = candidateIdentity(row);
        if (!visualGoldByTrade.has(identity)) visualGoldByTrade.set(identity, row);
    });
    const visualGold = [...visualGoldByTrade.values()];
    const goldPositive = visualGold.filter((row) => Number(row.outcome?.pnl) > 0).length;
    const goldNegative = visualGold.filter((row) => Number(row.outcome?.pnl) < 0).length;
    const goldUnknown = visualGold.length - goldPositive - goldNegative;
    const agreed = adminReviewed.filter((row) => row.reviewed_pattern_key === row.ai_pattern_key).length;
    const byPattern = {};
    reviewed.forEach((row) => {
        const key = row.reviewed_pattern_key || row.ai_pattern_key || 'unclear';
        const bucket = byPattern[key] || { key, total: 0, agreed: 0 };
        bucket.total++;
        if (row.reviewed_pattern_key === row.ai_pattern_key && row.reviewed_by) bucket.agreed++;
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
            agreement: adminReviewed.length ? agreed / adminReviewed.length : null,
            goldCases: (evaluationCases || []).length,
            testCases: (evaluationCases || []).filter((row) => row.dataset_split === 'test').length,
            minimumGoldCases: 30,
            goldRemaining: Math.max(0, 30 - (evaluationCases || []).length),
            goldPositive,
            goldNegative,
            goldUnknown,
        },
        version: versions?.[0] || null,
        campaign: versions?.[0]?.metrics?.trainingCampaign || null,
        lastRun,
        nextRunAt: nextRun.toISOString(),
        runs: runs || [],
        patterns: Object.values(byPattern).map((item) => ({ ...item, accuracy: item.total ? item.agreed / item.total : null })).sort((a, b) => b.total - a.total),
        personalPatterns: personalPatterns || [],
        currentJob: jobs?.[0] || null,
        jobs: jobs || [],
        traders: Object.entries(byTrader).map(([userId, count]) => ({ userId, name: profileMap.get(userId) || 'Трейдер', count })).sort((a, b) => b.count - a.count).slice(0, 12),
        qualityHistory: [...adminReviewed].sort((a, b) => String(a.reviewed_at).localeCompare(String(b.reviewed_at))).map((row, index, all) => {
            const slice = all.slice(0, index + 1);
            return { date: row.reviewed_at, accuracy: slice.filter((item) => item.reviewed_pattern_key === item.ai_pattern_key).length / slice.length };
        }),
    };
}

async function syncGoldCases(userId) {
    const reviewed = await supabaseRest('ai_learning_examples?review_status=in.(approved,corrected)&reviewed_by=not.is.null&reviewed_pattern_key=not.is.null&select=id,user_id,journal_day_id,trade_date,trade_key,reviewed_pattern_key,source_snapshot,outcome,screenshot_path,review_note,reviewed_by,reviewed_at&order=reviewed_at.desc&limit=1000');
    const byTrade = new Map();
    for (const example of reviewed || []) {
        if (String(example.review_note || '').startsWith('[auto]')) continue;
        if (!example.screenshot_path) continue;
        const identity = candidateIdentity(example);
        if (!byTrade.has(identity)) byTrade.set(identity, example);
    }
    const eligible = [...byTrade.values()];
    const eligibleIds = new Set(eligible.map((example) => example.id));
    const existingCases = await supabaseRest('ai_evaluation_cases?example_id=not.is.null&select=id,example_id,user_id,active&limit=2000');
    const staleCases = (existingCases || []).filter((item) => item.active && !eligibleIds.has(item.example_id));
    await Promise.all(staleCases.map((item) => supabaseRest(`ai_evaluation_cases?id=eq.${encodeURIComponent(item.id)}`, {
        method: 'PATCH', body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
    })));
    if (eligible.length) {
        await supabaseRest('ai_evaluation_cases?on_conflict=example_id', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify(eligible.map((example) => ({
                example_id: example.id,
                user_id: example.user_id,
                expected_pattern_key: example.reviewed_pattern_key,
                expected_features: example.source_snapshot?.aiFeatures || {},
                trade_date: example.trade_date,
                reviewer_note: example.review_note,
                active: true,
                created_by: example.reviewed_by || userId,
                updated_at: new Date().toISOString(),
            }))),
        });
    }
    for (const reviewedUserId of new Set([...eligible.map((example) => example.user_id), ...staleCases.map((item) => item.user_id)])) {
        await rebalanceEvaluationSplits(reviewedUserId);
    }
    return { synced: eligible.length, deactivated: staleCases.length };
}

async function setTrainingCampaign(action, userId) {
    const versions = await supabaseRest('ai_learning_versions?active=eq.true&select=id,metrics&limit=1');
    const version = versions?.[0];
    if (!version) throw Object.assign(new Error('Active AI version not found'), { status: 404 });
    const now = new Date();
    const current = version.metrics?.trainingCampaign || {};
    const campaign = action === 'start-day'
        ? {
            status: 'running',
            startedAt: now.toISOString(),
            endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
            startedBy: userId,
            batches: Number(current.batches || 0),
            processed: Number(current.processed || 0),
            failures: Number(current.failures || 0),
            lastError: '',
        }
        : { ...current, status: 'stopped', stoppedAt: now.toISOString() };
    const metrics = { ...(version.metrics || {}), trainingCampaign: campaign };
    await supabaseRest(`ai_learning_versions?id=eq.${version.id}`, { method: 'PATCH', body: JSON.stringify({ metrics }) });
    return campaign;
}

async function refreshPersonalPatterns(userId) {
    const examples = await supabaseRest(`ai_learning_examples?user_id=eq.${encodeURIComponent(userId)}&is_current=eq.true&screenshot_path=not.is.null&reviewed_by=not.is.null&review_status=in.(approved,corrected)&select=ai_pattern_key,reviewed_pattern_key,review_status,reviewed_by,outcome,screenshot_path`);
    const patterns = derivePersonalPatterns(examples || []);
    await supabaseRest(`ai_user_patterns?user_id=eq.${encodeURIComponent(userId)}&active=eq.true`, {
        method: 'PATCH', body: JSON.stringify({ active: false, calculated_at: new Date().toISOString() }),
    });
    for (const pattern of patterns) {
        await supabaseRest('ai_user_patterns?on_conflict=user_id,dimension,pattern_key', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({
                user_id: userId, dimension: pattern.dimension, pattern_key: pattern.patternKey,
                sample_size: pattern.sampleSize, outcome_sample_size: pattern.outcomeSampleSize,
                wins: pattern.wins, losses: pattern.losses, win_rate: pattern.winRate,
                baseline_win_rate: pattern.baselineWinRate, lift: pattern.lift,
                average_pnl: pattern.averagePnl, reliability: pattern.reliability,
                statistics: { interval: pattern.interval, baselineInterval: pattern.baselineInterval, comparisonSampleSize: pattern.comparisonSampleSize, liftInterval95: pattern.liftInterval95 },
                active: true, calculated_at: new Date().toISOString(),
            }),
        });
    }
    return patterns;
}

async function rebalanceEvaluationSplits(userId) {
    const cases = await supabaseRest(`ai_evaluation_cases?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,trade_date,created_at`);
    const assigned = assignChronologicalSplits(cases || []);
    await Promise.all(assigned.map((item) => supabaseRest(`ai_evaluation_cases?id=eq.${item.id}`, {
        method: 'PATCH', body: JSON.stringify({ dataset_split: item.dataset_split, updated_at: new Date().toISOString() }),
    })));
    return assigned;
}

async function updateCampaignAfterRun(run) {
    const versions = await supabaseRest('ai_learning_versions?active=eq.true&select=id,metrics&limit=1');
    const version = versions?.[0];
    const campaign = version?.metrics?.trainingCampaign;
    if (!version || campaign?.status !== 'running') return campaign || null;
    const expired = Date.parse(campaign.endsAt || 0) <= Date.now();
    const noWork = Number(run?.processed_count || 0) === 0 && Number(run?.failed_count || 0) === 0;
    const next = {
        ...campaign,
        status: expired ? 'completed' : noWork ? 'idle' : 'running',
        batches: Number(campaign.batches || 0) + 1,
        processed: Number(campaign.processed || 0) + Number(run?.processed_count || 0),
        failures: Number(campaign.failures || 0) + Number(run?.failed_count || 0),
        lastRunAt: new Date().toISOString(),
        lastError: run?.errors?.[0]?.message || '',
        completedAt: expired || noWork ? new Date().toISOString() : null,
    };
    await supabaseRest(`ai_learning_versions?id=eq.${version.id}`, {
        method: 'PATCH', body: JSON.stringify({ metrics: { ...(version.metrics || {}), trainingCampaign: next } }),
    });
    return next;
}

async function reviewExample(id, body, userId) {
    const action = String(body.action || 'approve');
    if (!['approve', 'correct', 'reject'].includes(action)) throw Object.assign(new Error('Unknown review action'), { status: 400 });
    const rows = await supabaseRest(`ai_learning_examples?id=eq.${encodeURIComponent(id)}&is_current=eq.true&select=*&limit=1`);
    const example = rows?.[0];
    if (!example) throw Object.assign(new Error('Example not found'), { status: 404 });
    const note = validateHumanReview({ example, action, evidenceReviewed: body.evidenceReviewed, note: body.note });
    let reviewStatus = action === 'approve' ? 'approved' : action === 'correct' ? 'corrected' : 'rejected';
    let pattern = action === 'approve' ? example.ai_pattern_key : String(body.patternKey || '');
    if (action !== 'reject' && !PATTERN_KEYS.has(pattern)) throw Object.assign(new Error('Invalid pattern category'), { status: 400 });
    const patch = {
        review_status: reviewStatus,
        reviewed_pattern_key: action === 'reject' ? null : pattern,
        review_note: note,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        embedding: null,
    };
    if (action !== 'reject') patch.embedding = await createEmbedding(embeddingText({ ...example, ...patch }));
    const updated = await supabaseRest(`ai_learning_examples?id=eq.${encodeURIComponent(id)}&select=id,review_status,reviewed_pattern_key,review_note,reviewed_at`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
    });
    try {
        if (action === 'reject') {
            await supabaseRest(`ai_evaluation_cases?example_id=eq.${encodeURIComponent(id)}`, {
                method: 'PATCH', body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
            });
        } else {
            await supabaseRest('ai_evaluation_cases?on_conflict=example_id', {
                method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
                body: JSON.stringify({
                    example_id: id,
                    user_id: example.user_id,
                    expected_pattern_key: pattern,
                    expected_features: example.source_snapshot?.aiFeatures || {},
                    trade_date: example.trade_date,
                    reviewer_note: patch.review_note,
                    active: true,
                    created_by: userId,
                    updated_at: new Date().toISOString(),
                }),
            });
        }
    } catch (error) {
        console.warn('[AI evaluation] Gold-case sync skipped; apply the evaluation migration', error);
    }
    if (action !== 'reject') {
        const versions = await supabaseRest('ai_learning_versions?active=eq.true&select=id,memory_version&limit=1');
        if (versions?.[0]) {
            await supabaseRest(`ai_learning_versions?id=eq.${versions[0].id}`, {
                method: 'PATCH', body: JSON.stringify({ memory_version: Number(versions[0].memory_version || 0) + 1 }),
            });
        }
    }
    try {
        await rebalanceEvaluationSplits(example.user_id);
        await refreshPersonalPatterns(example.user_id);
    } catch (error) {
        console.warn('[AI patterns] Refresh skipped; apply the evidence migration', error);
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
            if (body.action === 'start-day' || body.action === 'stop-day') {
                return sendJson(res, 200, { ok: true, campaign: await setTrainingCampaign(body.action, user.id) });
            }
            if (body.action === 'evaluate') {
                const gold = await syncGoldCases(user.id);
                const versions = await supabaseRest('ai_learning_versions?active=eq.true&select=prompt_version&limit=1');
                const evaluation = await runEvaluationSuite({ version: versions?.[0]?.prompt_version });
                return sendJson(res, 200, { ok: true, gold, evaluation });
            }
            if (body.action === 'refresh-patterns') {
                const patterns = await refreshPersonalPatterns(user.id);
                return sendJson(res, 200, { ok: true, patterns });
            }
            if (!['run', 'new-training', 'continue-training', 'resume-training'].includes(body.action)) return sendJson(res, 400, { ok: false, error: 'Unknown action' });
            if (body.action === 'resume-training') {
                const jobs = await supabaseRest('ai_learning_jobs?status=in.(failed,stopped)&select=*&order=started_at.desc&limit=1');
                if (!jobs?.[0]) return sendJson(res, 404, { ok: false, error: 'Training job not found' });
                await supabaseRest(`ai_learning_jobs?id=eq.${jobs[0].id}`, {
                    method: 'PATCH', body: JSON.stringify({ status: 'running', consecutive_failures: 0, completed_at: null, updated_at: new Date().toISOString() }),
                });
                const result = await processNextLearningJob({ userId: user.id });
                return sendJson(res, 200, { ok: true, ...result });
            }
            if (body.action === 'continue-training') {
                const result = await processNextLearningJob({ userId: user.id });
                return sendJson(res, 200, { ok: true, ...result });
            }
            const versions = await supabaseRest('ai_learning_versions?active=eq.true&select=id,memory_version,prompt_version&limit=1');
            const active = versions?.[0];
            let version = active?.prompt_version || undefined;
            if (body.action === 'new-training') {
                const memoryVersion = Number(active?.memory_version || 0) + 1;
                version = `outcome-structure-criteria-v4.${memoryVersion}`;
                if (active?.id) {
                    await supabaseRest(`ai_learning_versions?id=eq.${active.id}`, {
                        method: 'PATCH', body: JSON.stringify({ memory_version: memoryVersion, prompt_version: version }),
                    });
                }
                const now = new Date().toISOString();
                await supabaseRest('ai_learning_jobs?status=in.(running,processing)', {
                    method: 'PATCH', body: JSON.stringify({ status: 'stopped', completed_at: now, updated_at: now }),
                });
                await supabaseRest('ai_learning_jobs', {
                    method: 'POST', body: JSON.stringify({ prompt_version: version, created_by: user.id, include_saved_examples: true }),
                });
                const result = await processNextLearningJob({ userId: user.id });
                return sendJson(res, 200, { ok: true, ...result });
            }
            const run = await runLearningBatch({
                triggerType: 'manual', userId: user.id,
                forceReanalyze: body.action === 'new-training', version,
                includeSavedExamples: body.action === 'new-training' || body.includeSavedExamples === true,
            });
            return sendJson(res, 200, { ok: true, run, campaign: await updateCampaignAfterRun(run) });
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
