import { supabase } from '../supabase.js';

const PROXY_URL = '/api/gemini';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 20000;
const UNUSED_LOG_RETENTION_DAYS = 2;
const MAX_LOG_STRING = 1200;
const MAX_RESPONSE_PREVIEW = 2000;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Усі виклики Gemini йдуть через POST `/api/gemini` з Bearer-сесією; ключ Google AI задається
 * на сервері як GEMINI_API_KEY (див. api/gemini.js). Поля gemini_key у profiles.settings не використовуються.
 * Повертаємо непорожній масив, щоб наступна логіка не вважала «ключ не додано».
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
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = await getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch(PROXY_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ payload, model }),
            signal: controller.signal,
        });

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
        await finishAIRequestLog(logId, { status: 'failed', error });
        throw error;
    } finally {
        clearTimeout(timeout);
    }
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
                request_payload: compactPayload(payload),
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
            response_preview: limitString(responseText, MAX_RESPONSE_PREVIEW),
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

function compactPayload(value, depth = 0) {
    if (depth > 8) return '[max depth]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return compactString(value);
    if (Array.isArray(value)) return value.map(item => compactPayload(item, depth + 1));
    if (typeof value !== 'object') return String(value);

    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === 'data' && looksLikeBase64(item)) {
            output[key] = `[base64 omitted, ${String(item).length} chars]`;
            continue;
        }
        output[key] = compactPayload(item, depth + 1);
    }
    return output;
}

function compactString(value) {
    if (looksLikeBase64(value)) return `[base64 omitted, ${value.length} chars]`;
    return limitString(value, MAX_LOG_STRING);
}

function limitString(value, maxLength) {
    const text = String(value ?? '');
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function looksLikeBase64(value) {
    return typeof value === 'string'
        && value.length > 400
        && /^[A-Za-z0-9+/=\s]+$/.test(value);
}
