import { handleServiceBotEndpoint, sendJson } from '../../lib/service_bots.js';

const ALLOWED_ENDPOINTS = new Set(['summary', 'tickers', 'locates', 'orders', 'snapshot']);

export default function handler(req, res) {
    const endpoint = String(req.query?.endpoint || '').trim();
    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
        return sendJson(res, 404, { ok: false, error: 'Service bot endpoint not found' });
    }
    return handleServiceBotEndpoint(req, res, endpoint);
}
