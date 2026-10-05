import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesToGeminiContents, toGeminiResponseObject, selectAssistantProvider } from '../lib/assistant/providers.js';

test('Gemini tool results from one round are bundled into a single user turn', () => {
    const contents = messagesToGeminiContents([
        { role: 'user', content: 'analyze' },
        {
            role: 'assistant',
            toolCalls: [
                { id: '1', name: 'get_trades', args: { from: '2026-09-01' } },
                { id: '2', name: 'get_risk_state', args: {} },
            ],
        },
        { role: 'tool', name: 'get_trades', toolCallId: '1', content: { count: 2 } },
        { role: 'tool', name: 'get_risk_state', toolCallId: '2', content: { level: 'caution' } },
    ]);
    assert.equal(contents.length, 3);
    assert.equal(contents[1].role, 'model');
    assert.equal(contents[1].parts.length, 2);
    assert.equal(contents[2].role, 'user');
    assert.equal(contents[2].parts.length, 2);
    assert.equal(contents[2].parts[0].functionResponse.name, 'get_trades');
    assert.equal(contents[2].parts[1].functionResponse.name, 'get_risk_state');
});

test('selectAssistantProvider uses free cascade and ignores global AI_PROVIDER', () => {
    assert.equal(selectAssistantProvider({
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'sk-test',
        GEMINI_API_KEY: 'AIza-valid-looking',
    }), 'gemini');

    assert.equal(selectAssistantProvider({
        ASSISTANT_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'sk-test',
        GEMINI_API_KEY: 'AIza-valid-looking',
    }), 'openrouter');
});

test('Gemini function responses wrap primitives', () => {
    assert.deepEqual(toGeminiResponseObject('ok'), { result: 'ok' });
    assert.deepEqual(toGeminiResponseObject({ level: 'normal' }), { level: 'normal' });
});
