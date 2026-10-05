import { buildAssistantSystemPrompt, buildLiveContextMessage } from './system_prompt.js';
import { buildAssistantContext, sanitizePageContext } from './context.js';
import {
    ASSISTANT_TOOL_DEFINITIONS,
    createToolHandlers,
    dispatchTool,
    toGeminiFunctionDeclarations,
    toOpenAITools,
} from './tools/registry.js';
import { callAssistantLlm, selectAssistantProvider, listAssistantProviders } from './providers.js';

const MAX_ROUNDS = 6;
const MAX_HISTORY = 12;
const MAX_MESSAGE = 4000;

export async function runAssistantAgent({
    db,
    user,
    message,
    pageContext,
    history = [],
    fetchImpl = fetch,
    env = process.env,
    maxRounds = MAX_ROUNDS,
} = {}) {
    const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
    if (text.length < 1) {
        const error = new Error('Empty message');
        error.status = 400;
        throw error;
    }

    const providers = listAssistantProviders(env);
    const preferred = selectAssistantProvider(env);
    const providerQueue = preferred
        ? [preferred, ...providers.filter((item) => item !== preferred)]
        : providers;
    if (!providerQueue.length) {
        const error = new Error('No AI provider configured');
        error.status = 503;
        throw error;
    }

    const context = await buildAssistantContext(db, user, pageContext);
    const handlers = createToolHandlers({ db, userId: user.id });
    const systemPrompt = buildAssistantSystemPrompt();
    const toolsGemini = toGeminiFunctionDeclarations(ASSISTANT_TOOL_DEFINITIONS);
    const toolsOpenAI = toOpenAITools(ASSISTANT_TOOL_DEFINITIONS);

    const messages = [];
    for (const item of (Array.isArray(history) ? history : []).slice(-MAX_HISTORY)) {
        const role = item?.role === 'assistant' || item?.role === 'ai' || item?.role === 'model' ? 'assistant' : 'user';
        const content = stripHtml(item?.text || item?.content || '').slice(0, 2000);
        if (content) messages.push({ role, content });
    }
    messages.push({
        role: 'user',
        content: `${buildLiveContextMessage(context)}\n\nЗапит користувача: ${text}`,
    });

    const toolTrace = [];
    const uiHints = [];
    let modelName = '';
    let usedProvider = providerQueue[0];
    let providerIndex = 0;

    for (let round = 0; round < maxRounds; round += 1) {
        let result;
        try {
            result = await callAssistantLlm({
                provider: providerQueue[providerIndex],
                systemPrompt,
                messages,
                toolsGemini,
                toolsOpenAI,
                fetchImpl,
                env,
            });
        } catch (error) {
            if (isProviderFailoverError(error) && providerIndex < providerQueue.length - 1) {
                providerIndex += 1;
                round -= 1;
                continue;
            }
            throw error;
        }
        usedProvider = result.provider || providerQueue[providerIndex];
        modelName = result.model || modelName;

        if (result.type === 'text' || !result.toolCalls?.length) {
            let answer = String(result.text || '').trim();
            if (!answer && toolTrace.length && round < maxRounds - 1) {
                messages.push({
                    role: 'user',
                    content: 'На основі результатів tools дай коротку відповідь українською з цифрами та n. Без нових tool calls.',
                });
                const synth = await callAssistantLlm({
                    provider: providerQueue[providerIndex],
                    systemPrompt,
                    messages,
                    toolsGemini: [],
                    toolsOpenAI: [],
                    fetchImpl,
                    env,
                });
                usedProvider = synth.provider || usedProvider;
                modelName = synth.model || modelName;
                answer = String(synth.text || '').trim();
            }
            return {
                answer: answer || 'Немає відповіді від моделі.',
                provider: usedProvider,
                model: modelName,
                toolTrace,
                uiHints: uniqueHints(uiHints),
                pageContext: context.pageContext,
                rounds: round + 1,
            };
        }

        messages.push({
            role: 'assistant',
            content: result.text || '',
            toolCalls: result.toolCalls,
            rawModelContent: result.rawModelContent || null,
            rawAssistantMessage: result.rawAssistantMessage || null,
        });

        for (const call of result.toolCalls) {
            const toolResult = await dispatchTool(handlers, call.name, call.args, {
                pageContext: context.pageContext,
            });
            toolTrace.push({
                name: call.name,
                args: boundArgs(call.args),
                ok: !toolResult?.error,
            });
            if (toolResult?.ui_hint) uiHints.push(toolResult.ui_hint);
            messages.push({
                role: 'tool',
                name: call.name,
                toolCallId: call.id,
                content: toolResult,
            });
        }
    }

    return {
        answer: 'Досягнуто ліміт кроків аналізу. Уточни запит або звузь період.',
        provider: usedProvider,
        model: modelName,
        toolTrace,
        uiHints: uniqueHints(uiHints),
        pageContext: context.pageContext,
        rounds: maxRounds,
        truncated: true,
    };
}

export { sanitizePageContext, ASSISTANT_TOOL_DEFINITIONS };

function boundArgs(args) {
    try {
        return JSON.parse(JSON.stringify(args || {}, (_key, value) => {
            if (typeof value === 'string') return value.slice(0, 120);
            return value;
        }));
    } catch {
        return {};
    }
}

function uniqueHints(hints) {
    const seen = new Set();
    const out = [];
    for (const hint of hints) {
        const key = JSON.stringify(hint);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hint);
    }
    return out.slice(0, 8);
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

function isProviderFailoverError(error) {
    const status = Number(error?.status) || 0;
    const message = String(error?.message || '');
    if ([401, 403, 429, 503].includes(status)) return true;
    return /api key|not valid|invalid|rate limit|quota|unavailable|overloaded/i.test(message);
}
