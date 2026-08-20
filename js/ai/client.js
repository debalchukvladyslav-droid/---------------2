import { supabase, SUPABASE_URL } from '../supabase.js';
import { summarizeAIPayload } from './telemetry.js';

/** Основний проксі: Edge Function (секрет GEMINI_API_KEY у Supabase). Резерв: /api/gemini (Vercel). */
function geminiEdgeUrl() {
    return `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/gemini-proxy`;
}
const PROXY_FALLBACK = '/api/gemini';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 55000;
const UNUSED_LOG_RETENTION_DAYS = 2;
const MAX_LOG_STRING = 1200;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gemini: POST на Supabase Edge `gemini-proxy` (секрет GEMINI_API_KEY у консолі Supabase).
 * Якщо функція не задеплоєна (404) — fallback на /api/gemini.
 */
export function getGeminiKeys() {
    return ['proxy'];
}

export async function callGemini(key, payload) {
    return callGeminiViaProxy(payload);
}

export async function callGeminiJSON(key, payload) {
    return callGeminiViaProxy(payload, DEFAULT_MODEL);
}

export async function callGeminiViaProxy(payload, model = DEFAULT_MODEL) {
    const logId = await createAIRequestLog({ payload, model });
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new Error('AI запит триває надто довго. Спробуйте ще раз або звузьте запит.'));
    }, REQUEST_TIMEOUT_MS);

    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = await getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        // Keep the authenticated Edge Function as the stable primary route for
        // both text and vision. Vercel is a fallback only; using it first caused
        // visible 502 resource errors even when Edge subsequently succeeded.
        const primaryUrl = geminiEdgeUrl();
        const fallbackUrl = PROXY_FALLBACK;
        let res = await fetch(primaryUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ payload, model }),
            signal: controller.signal,
        });
        if (res.status === 404 || res.status === 403 || res.status >= 500) {
            res = await fetch(fallbackUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ payload, model }),
                signal: controller.signal,
            });
        }

        const raw = await res.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error('Invalid JSON from proxy');
        }

        if (!res.ok) throw new Error(data.message || `Proxy error ${res.status}`);
        if (!data.text) throw new Error('Empty response from proxy');

        const text = typeof data.text === 'string' ? data.text : JSON.stringify(data.text);
        await finishAIRequestLog(logId, { status: 'completed', responseText: text });
        return text;
    } catch (error) {
        const normalizedError = normalizeAIProxyError(error);
        await finishAIRequestLog(logId, { status: 'failed', error: normalizedError });
        throw normalizedError;
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeAIProxyError(error) {
    const message = String(error?.message || error || '');
    const name = String(error?.name || '');
    if (
        name === 'AbortError' ||
        name === 'TimeoutError' ||
        /aborted|abort|timeout|timed out/i.test(message)
    ) {
        return new Error('AI не встиг відповісти. Спробуйте ще раз або зробіть запит коротшим.');
    }
    return error instanceof Error ? error : new Error(message || 'AI запит не вдався.');
}

export async function markAIRequestUsed(logId) {
    if (!logId) return;
    try {
        await supabase
            .from('ai_request_logs')
            .update({ used: true, used_at: new Date().toISOString() })
            .eq('id', logId);
    } catch (error) {
        console.warn('[AI log] mark used skipped:', error);
    }
}

export async function cleanupUnusedAIRequests(retentionDays = UNUSED_LOG_RETENTION_DAYS) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    try {
        const { error } = await supabase
            .from('ai_request_logs')
            .delete()
            .eq('used', false)
            .lt('created_at', cutoff);

        if (error) throw error;
    } catch (error) {
        console.warn('[AI cleanup] skipped:', error);
    }
}

async function getAccessToken() {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        return data?.session?.access_token || '';
    } catch (error) {
        console.warn('[AI proxy] auth token unavailable:', error);
        return '';
    }
}

async function getCurrentUserId() {
    try {
        const { data, error } = await supabase.auth.getUser();
        if (error) throw error;
        return data?.user?.id || null;
    } catch {
        return null;
    }
}

async function createAIRequestLog({ payload, model }) {
    try {
        const userId = await getCurrentUserId();
        if (!userId) return null;

        const { data, error } = await supabase
            .from('ai_request_logs')
            .insert({
                user_id: userId,
                request_type: 'gemini',
                model,
                status: 'pending',
                used: false,
                request_payload: summarizeAIPayload(payload),
            })
            .select('id')
            .single();

        if (error) throw error;
        return data?.id || null;
    } catch (error) {
        console.warn('[AI log] create skipped:', error);
        return null;
    }
}

async function finishAIRequestLog(logId, { status, responseText = '', error = null }) {
    if (!logId) return;

    try {
        const patch = {
            status,
            response_preview: responseText ? `[response omitted, ${String(responseText).length} chars]` : '',
            error_message: error ? limitString(error.message || String(error), MAX_LOG_STRING) : null,
        };

        await supabase
            .from('ai_request_logs')
            .update(patch)
            .eq('id', logId);
    } catch (logError) {
        console.warn('[AI log] finish skipped:', logError);
    }
}

function limitString(value, maxLength) {
    const text = String(value ?? '');
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
