import { supabase } from '../supabase.js';
import { buildPageContext } from './page_context.js';

const ASSISTANT_URL = '/api/assistant';
const REQUEST_TIMEOUT_MS = 90000;

export async function askJournalAssistant({
    message,
    history = [],
    pageContext = null,
} = {}) {
    const token = await getAccessToken();
    if (!token) throw new Error('Увійдіть у журнал, щоб користуватись AI.');

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new Error('AI запит триває надто довго. Спробуйте ще раз.'));
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(ASSISTANT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                message,
                history: (Array.isArray(history) ? history : []).slice(-12).map((item) => ({
                    role: item.role === 'ai' || item.role === 'model' ? 'assistant' : item.role === 'user' ? 'user' : 'user',
                    text: stripHtml(item.text || item.content || '').slice(0, 2000),
                })),
                pageContext: pageContext || buildPageContext(),
            }),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || `Assistant error ${response.status}`);
        }
        return data;
    } catch (error) {
        if (error?.name === 'AbortError' || /aborted|timeout/i.test(String(error?.message || ''))) {
            throw new Error('AI не встиг відповісти. Спробуйте ще раз або зробіть запит коротшим.');
        }
        throw error instanceof Error ? error : new Error(String(error || 'Assistant failed'));
    } finally {
        clearTimeout(timeout);
    }
}

async function getAccessToken() {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        return data?.session?.access_token || '';
    } catch {
        return '';
    }
}

function stripHtml(value) {
    return String(value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}
