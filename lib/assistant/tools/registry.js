import { createTradeTools, createDayTools, createStatsTools } from './trades.js';
import { createRiskTools } from './risk.js';
import { createMarketTools } from './market.js';

export const ASSISTANT_TOOL_DEFINITIONS = [
    {
        name: 'get_trade',
        description: 'Get one trade by id or by date/ticker/index. Uses page context when args omitted.',
        parameters: {
            type: 'object',
            properties: {
                tradeId: { type: 'string' },
                date: { type: 'string', description: 'YYYY-MM-DD' },
                ticker: { type: 'string' },
                tradeIndex: { type: 'number' },
            },
        },
    },
    {
        name: 'get_trades',
        description: 'List trades with optional filters. Max 100 rows.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                ticker: { type: 'string' },
                setup: { type: 'string' },
                side: { type: 'string' },
                limit: { type: 'number' },
            },
        },
    },
    {
        name: 'get_day',
        description: 'Get journal day summary including trades, notes, errors.',
        parameters: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
            },
        },
    },
    {
        name: 'get_performance_stats',
        description: 'Computed performance aggregates (time buckets, setups, after first loss). Do not recalculate manually.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                ticker: { type: 'string' },
                setup: { type: 'string' },
                side: { type: 'string' },
            },
        },
    },
    {
        name: 'get_market_data',
        description: 'Bounded market bars and criteria snapshot for a ticker/date.',
        parameters: {
            type: 'object',
            properties: {
                ticker: { type: 'string' },
                date: { type: 'string' },
            },
        },
    },
    {
        name: 'get_risk_state',
        description: 'Deterministic drawdown risk level and recommended risk size.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string' },
                to: { type: 'string' },
            },
        },
    },
    {
        name: 'find_similar_trades',
        description: 'Find similar historical trades to a seed trade (page context or args).',
        parameters: {
            type: 'object',
            properties: {
                tradeId: { type: 'string' },
                date: { type: 'string' },
                ticker: { type: 'string' },
                tradeIndex: { type: 'number' },
                setup: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                limit: { type: 'number' },
            },
        },
    },
    {
        name: 'analyze_setup',
        description: 'Analyze performance for one setup name.',
        parameters: {
            type: 'object',
            properties: {
                setup: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
            },
            required: ['setup'],
        },
    },
];

export function createToolHandlers({ db, userId }) {
    const tradeTools = createTradeTools({ db, userId });
    const dayTools = createDayTools({ db, userId });
    const statsTools = createStatsTools({ db, userId });
    const riskTools = createRiskTools({ db, userId });
    const marketTools = createMarketTools({ db, userId });
    return {
        get_trade: tradeTools.get_trade.bind(tradeTools),
        get_trades: tradeTools.get_trades.bind(tradeTools),
        find_similar_trades: tradeTools.find_similar_trades.bind(tradeTools),
        get_day: dayTools.get_day.bind(dayTools),
        get_performance_stats: statsTools.get_performance_stats.bind(statsTools),
        analyze_setup: statsTools.analyze_setup.bind(statsTools),
        get_risk_state: riskTools.get_risk_state.bind(riskTools),
        get_market_data: marketTools.get_market_data.bind(marketTools),
    };
}

export async function dispatchTool(handlers, name, args, ctx) {
    const handler = handlers[name];
    if (!handler) return { error: `unknown_tool:${name}` };
    try {
        return await handler(args || {}, ctx);
    } catch (error) {
        return { error: String(error?.message || 'tool_failed').slice(0, 300) };
    }
}

export function toGeminiFunctionDeclarations(definitions = ASSISTANT_TOOL_DEFINITIONS) {
    return definitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.parameters),
    }));
}

export function toOpenAITools(definitions = ASSISTANT_TOOL_DEFINITIONS) {
    return definitions.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
    const type = String(schema.type || 'object').toUpperCase();
    const out = { type: type === 'OBJECT' || type === 'object' ? 'OBJECT' : type };
    if (schema.description) out.description = schema.description;
    if (schema.properties) {
        out.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            out.properties[key] = {
                type: String(value.type || 'string').toUpperCase(),
                ...(value.description ? { description: value.description } : {}),
            };
        }
    }
    if (Array.isArray(schema.required)) out.required = schema.required;
    return out;
}
