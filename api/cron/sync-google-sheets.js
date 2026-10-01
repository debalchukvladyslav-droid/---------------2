import { runGoogleSheetSync, supabaseRest } from '../../lib/google_sheet_sync.js';
import { processNextLearningJob, runLearningBatch } from '../../lib/ai_learning.js';
import { runGrandmasterDailyReviews } from '../../lib/grandmaster_review.js';
import { processSourceJobs } from '../../lib/source_worker.js';
import { buildGauge } from '../../lib/aggressiveness_service.js';
import { createAggressivenessStore } from '../../lib/aggressiveness_http.js';
import { createBreadthProvider } from '../../lib/market_data_provider.js';
import { buildLiveNextSession, loadMechanicalSignals } from '../../lib/next_session_service.js';
import { checkArchiveDriveFolder, runShsDayArchive } from '../../lib/shs_day_archive_run.js';

export const config = { maxDuration: 300 };

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

const NEXT_SESSION_ENABLED = false;

async function storeAggressiveness() {
    try {
        const payload = await buildGauge({
            now: new Date(),
            env: process.env,
            store: createAggressivenessStore(),
            breadthProvider: createBreadthProvider(process.env),
            loadSignals: () => loadMechanicalSignals(),
        });
        return {
            ok: payload.status === 'ok',
            sessionDate: payload.sessionDate || null,
            infoThrough: payload.infoThrough || null,
            score: payload.displayScore ?? null,
            confidence: payload.confidence ?? null,
            breadthUnavailable: Boolean(payload.breadthUnavailable),
            incomplete: Boolean(payload.incomplete),
        };
    } catch (error) {
        console.error('[Aggressiveness]', error);
        return { ok: false, error: error?.message || String(error) };
    }
}

async function storeNextSession() {
    if (!NEXT_SESSION_ENABLED) return { ok: false, disabled: true };
    try {
        const payload = await buildLiveNextSession();
        return {
            ok: payload.complete === true,
            targetDate: payload.targetDate || null,
            finalScore: payload.finalScore ?? null,
            message: payload.message || null,
        };
    } catch (error) {
        console.error('[Next session]', error);
        return { ok: false, error: error?.message || String(error) };
    }
}

function requestBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return {}; }
    }
    return {};
}

async function claimWorkerWake(req) {
    if (String(req.query?.task || '') !== 'ai-learning' || String(req.query?.mode || '') !== 'job-only') return false;
    const wakeToken = String(requestBody(req).wakeToken || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(wakeToken)) return false;
    const claimed = await supabaseRest('rpc/claim_ai_worker_wake', {
        method: 'POST', body: JSON.stringify({ wake_token: wakeToken }),
    });
    return claimed === true;
}

async function claimShsArchiveWake(req) {
    if (String(req.query?.task || '') !== 'shs-archive') return false;
    const wakeToken = String(requestBody(req).wakeToken || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(wakeToken)) return false;
    const claimed = await supabaseRest('rpc/claim_shs_archive_wake', {
        method: 'POST', body: JSON.stringify({ wake_token: wakeToken }),
    });
    return claimed === true;
}

export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET || '';
    if (!cronSecret) {
        console.error('[Google Sheets cron] CRON_SECRET is not configured');
        return sendJson(res, 503, { ok: false, error: 'Cron authentication is not configured' });
    }
    const vercelCronAuthorized = req.headers.authorization === `Bearer ${cronSecret}`;
    const supabaseWorkerAuthorized = vercelCronAuthorized ? false : await claimWorkerWake(req).catch(() => false);
    const shsArchiveAuthorized = vercelCronAuthorized || supabaseWorkerAuthorized
        ? false
        : await claimShsArchiveWake(req).catch(() => false);
    if (!vercelCronAuthorized && !supabaseWorkerAuthorized && !shsArchiveAuthorized) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
        if (String(req.query?.task || '') === 'shs-archive' && String(req.query?.probe || '') === 'drive') {
            const drive = await checkArchiveDriveFolder();
            return sendJson(res, drive.ok ? 200 : 502, { task: 'shs-archive', probe: 'drive', drive });
        }
        if (String(req.query?.task || '') === 'shs-archive') {
            const force = vercelCronAuthorized && String(req.query?.force || '') === '1';
            const requested = String(req.query?.slot || '');
            const archive = await runShsDayArchive({
                now: new Date(),
                force,
                slot: force && ['1200', '1550', '0900'].includes(requested) ? requested : '',
            });
            return sendJson(res, archive.ok ? 200 : 502, { task: 'shs-archive', ...archive });
        }
        if (String(req.query?.task || '') === 'source-sync') {
            const results = await processSourceJobs({ maxJobs: 8, maxDurationMs: 270_000 });
            return sendJson(res, 200, {
                ok: results.every(result => result.ok !== false),
                task: 'source-sync',
                count: results.length,
                results,
            });
        }
        if (String(req.query?.task || '') === 'end-of-day') {
            const grandmaster = await runGrandmasterDailyReviews({ tradeDate: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.date || '')) ? String(req.query.date) : undefined });
            const queued = await processNextLearningJob().catch(() => ({ job: null, run: null, status: 'idle' }));
            const nextSession = await storeNextSession();
            const aggressiveness = await storeAggressiveness();
            return sendJson(res, 200, { ok: grandmaster.failed === 0, task: 'end-of-day', grandmaster, aiLearning: queued, nextSession, aggressiveness });
        }
        if (String(req.query?.task || '') === 'ai-learning') {
            const queued = await processNextLearningJob();
            if (String(req.query?.mode || '') === 'job-only') {
                return sendJson(res, 200, {
                    ok: true,
                    task: 'ai-learning',
                    mode: 'job-only',
                    aiLearning: queued.job ? queued : { job: null, run: null, status: 'idle' },
                });
            }
            const aiLearning = queued.job ? queued : await runLearningBatch({ triggerType: 'cron' });
            return sendJson(res, 200, { ok: true, task: 'ai-learning', aiLearning });
        }

        const configs = await supabaseRest(
            'google_sheet_sync_configs?enabled=eq.true&select=*&order=updated_at.asc',
        );
        const results = [];

        for (const config of configs || []) {
            try {
                results.push(await runGoogleSheetSync(config));
            } catch (error) {
                const message = error?.message || String(error);
                results.push({
                    ok: false,
                    id: config.id,
                    userId: config.user_id,
                    spreadsheetId: config.spreadsheet_id,
                    error: message,
                });
                await supabaseRest(`google_sheet_sync_configs?id=eq.${encodeURIComponent(config.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        last_sync_at: new Date().toISOString(),
                        last_sync_status: 'error',
                        last_sync_error: message.slice(0, 1000),
                    }),
                }).catch(() => {});
            }
        }

        const nextSession = await storeNextSession();
        return sendJson(res, 200, {
            ok: true,
            count: results.length,
            results,
            nextSession,
        });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
}
