import { runGoogleSheetSync, supabaseRest } from '../../lib/google_sheet_sync.js';
import { processNextLearningJob, runLearningBatch } from '../../lib/ai_learning.js';
import { runGrandmasterDailyReviews } from '../../lib/grandmaster_review.js';

export const config = { maxDuration: 300 };

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
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

export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET || '';
    if (!cronSecret) {
        console.error('[Google Sheets cron] CRON_SECRET is not configured');
        return sendJson(res, 503, { ok: false, error: 'Cron authentication is not configured' });
    }
    const vercelCronAuthorized = req.headers.authorization === `Bearer ${cronSecret}`;
    const supabaseWorkerAuthorized = vercelCronAuthorized ? false : await claimWorkerWake(req).catch(() => false);
    if (!vercelCronAuthorized && !supabaseWorkerAuthorized) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
        if (String(req.query?.task || '') === 'end-of-day') {
            const grandmaster = await runGrandmasterDailyReviews({ tradeDate: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.date || '')) ? String(req.query.date) : undefined });
            const queued = await processNextLearningJob().catch(() => ({ job: null, run: null, status: 'idle' }));
            return sendJson(res, 200, { ok: grandmaster.failed === 0, task: 'end-of-day', grandmaster, aiLearning: queued });
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

        return sendJson(res, 200, {
            ok: true,
            count: results.length,
            results,
        });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
}
