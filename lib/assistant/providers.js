const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';

/**
 * Free-first provider order for Journal AI.
 * ASSISTANT_PROVIDER overrides. Global AI_PROVIDER is ignored here so the rest of the app
 * can stay on OpenRouter while the assistant prefers Gemini/Groq when keys exist.
 */
export function selectAssistantProvider(env = process.env) {
    const forced = String(env.ASSISTANT_PROVIDER || '').trim().toLowerCase();
    if (forced === 'gemini' && getGeminiApiKey(env)) return 'gemini';
    if (forced === 'groq' && String(env.GROQ_API_KEY || '').trim()) return 'groq';
    if (forced === 'openrouter' && getOpenRouterApiKey(env)) return 'openrouter';
    if (forced) return '';

    for (const provider of listAssistantProviders(env)) return provider;
    return '';
}

export function listAssistantProviders(env = process.env) {
    const ordered = [];
    if (getGeminiApiKey(env)) ordered.push('gemini');
    if (String(env.GROQ_API_KEY || '').trim()) ordered.push('groq');
    if (getOpenRouterApiKey(env)) ordered.push('openrouter');
    return ordered;
}

export function getGeminiApiKey(env = process.env) {
    return [
        env.GEMINI_API_KEY,
        env.GOOGLE_GENERATIVE_AI_API_KEY,
        env.GOOGLE_AI_API_KEY,
        env.GEMINI_KEY,
    ].map((v) => String(v || '').trim()).find(Boolean) || '';
}

function getOpenRouterApiKey(env = process.env) {
    return String(env.OPENROUTER_API_KEY || env.OPENROUTER_KEY || '').trim();
}

export async function callAssistantLlm({
    provider,
    systemPrompt,
    messages,
    toolsGemini,
    toolsOpenAI,
    fetchImpl = fetch,
    env = process.env,
}) {
    if (provider === 'groq') {
        return callOpenAICompatibleTools({
            label: 'Groq',
            url: GROQ_CHAT_URL,
            apiKey: String(env.GROQ_API_KEY || '').trim(),
            model: String(env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim(),
            providerName: 'groq',
            systemPrompt,
            messages,
            tools: toolsOpenAI,
            fetchImpl,
            env,
            timeoutMs: 40000,
        });
    }
    if (provider === 'openrouter') {
        return callOpenAICompatibleTools({
            label: 'OpenRouter',
            url: OPENROUTER_CHAT_URL,
            apiKey: getOpenRouterApiKey(env),
            model: String(env.ASSISTANT_OPENROUTER_MODEL || env.OPENROUTER_MODEL || env.AI_MODEL || DEFAULT_OPENROUTER_MODEL).trim(),
            providerName: 'openrouter',
            systemPrompt,
            messages,
            tools: toolsOpenAI,
            fetchImpl,
            env,
            timeoutMs: 50000,
            extraHeaders: {
                'HTTP-Referer': String(env.APP_PUBLIC_URL || env.GEMINI_REFERER || 'https://traderjournal-six.vercel.app').trim(),
                'X-Title': 'Trading Journal Assistant',
            },
        });
    }
    if (provider === 'gemini') {
        return callGeminiTools({ systemPrompt, messages, tools: toolsGemini, fetchImpl, env });
    }
    const error = new Error('No AI provider configured for assistant');
    error.status = 503;
    throw error;
}

async function callGeminiTools({ systemPrompt, messages, tools, fetchImpl, env }) {
    const key = getGeminiApiKey(env);
    if (!key) {
        const error = new Error('GEMINI_API_KEY not configured');
        error.status = 500;
        throw error;
    }
    const model = String(env.GEMINI_TEXT_MODEL || env.ASSISTANT_MODEL || DEFAULT_GEMINI_MODEL).trim();
    const contents = messagesToGeminiContents(messages);
    const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
    };
    if (Array.isArray(tools) && tools.length) {
        payload.tools = [{ functionDeclarations: tools }];
        payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const response = await fetchImpl(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(50000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data?.error?.message || `Gemini error ${response.status}`);
        error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
        throw error;
    }
    return {
        provider: 'gemini',
        model,
        ...parseGeminiAssistantResponse(data),
        rawModelContent: data?.candidates?.[0]?.content || null,
    };
}

async function callOpenAICompatibleTools({
    label,
    url,
    apiKey,
    model,
    providerName,
    systemPrompt,
    messages,
    tools,
    fetchImpl,
    timeoutMs = 40000,
    extraHeaders = {},
}) {
    if (!apiKey) {
        const error = new Error(`${label} API key not configured`);
        error.status = 500;
        throw error;
    }
    const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...messagesToOpenAI(messages),
    ];
    const body = {
        model,
        messages: openaiMessages,
        temperature: 0.2,
    };
    if (Array.isArray(tools) && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    if (providerName === 'groq') body.max_completion_tokens = 1200;
    else body.max_tokens = 1200;

    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data?.error?.message || `${label} error ${response.status}`);
        error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
        throw error;
    }
    const message = data?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length) {
        return {
            provider: providerName,
            model: data?.model || model,
            type: 'tool_calls',
            text: typeof message.content === 'string' ? message.content : '',
            toolCalls: toolCalls.map((call) => ({
                id: call.id || `call_${call.function?.name || 'tool'}`,
                name: call.function?.name || '',
                args: safeJsonParse(call.function?.arguments),
            })),
            rawAssistantMessage: message,
        };
    }
    const text = typeof message.content === 'string'
        ? message.content.trim()
        : Array.isArray(message.content)
            ? message.content.map((part) => part?.text || '').join('').trim()
            : '';
    return { provider: providerName, model: data?.model || model, type: 'text', text, toolCalls: [] };
}

function parseGeminiAssistantResponse(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const toolCalls = [];
    const textParts = [];
    for (const part of parts) {
        if (part?.functionCall?.name) {
            toolCalls.push({
                id: `call_${part.functionCall.name}_${toolCalls.length}`,
                name: part.functionCall.name,
                args: part.functionCall.args || {},
            });
        } else if (typeof part?.text === 'string' && part.text.trim()) {
            textParts.push(part.text);
        }
    }
    if (toolCalls.length) {
        return { type: 'tool_calls', text: textParts.join('\n').trim(), toolCalls };
    }
    return { type: 'text', text: textParts.join('\n').trim(), toolCalls: [] };
}

function messagesToGeminiContents(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const contents = [];
    for (let i = 0; i < list.length;) {
        const message = list[i];
        if (message.role === 'tool') {
            const parts = [];
            while (i < list.length && list[i].role === 'tool') {
                const toolMsg = list[i];
                parts.push({
                    functionResponse: {
                        name: toolMsg.name,
                        response: toGeminiResponseObject(toolMsg.content),
                    },
                });
                i += 1;
            }
            contents.push({ role: 'user', parts });
            continue;
        }
        if (message.role === 'assistant' && message.rawModelContent) {
            contents.push(message.rawModelContent);
            i += 1;
            continue;
        }
        if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
            contents.push({
                role: 'model',
                parts: message.toolCalls.map((call) => ({
                    functionCall: { name: call.name, args: call.args || {} },
                })),
            });
            i += 1;
            continue;
        }
        contents.push({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(message.content || '') }],
        });
        i += 1;
    }
    return contents;
}

function toGeminiResponseObject(content) {
    if (content && typeof content === 'object' && !Array.isArray(content)) return content;
    return { result: content ?? null };
}

function messagesToOpenAI(messages) {
    const out = [];
    for (const message of messages) {
        if (message.role === 'tool') {
            out.push({
                role: 'tool',
                tool_call_id: message.toolCallId || message.id,
                content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            });
            continue;
        }
        if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
            out.push({
                role: 'assistant',
                content: message.content || null,
                tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
                })),
            });
            continue;
        }
        out.push({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: String(message.content || ''),
        });
    }
    return out;
}

function safeJsonParse(value) {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(String(value || '{}'));
    } catch {
        return {};
    }
}

export { messagesToGeminiContents, toGeminiResponseObject };
