import { sendJson } from '../../lib/service_bots.js';
import { runLearningBatch } from '../../lib/ai_learning.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const expected = String(process.env.CRON_SECRET || '').trim();
    const authorization = String(req.headers.authorization || '');
    if (!expected || authorization !== `Bearer ${expected}`) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    try {
        const run = await runLearningBatch({ triggerType: 'cron' });
        return sendJson(res, 200, { ok: true, run });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
}
