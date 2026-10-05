import test from 'node:test';
import assert from 'node:assert/strict';
import { runAssistantAgent } from '../lib/assistant/agent.js';

function createDb() {
    return {
        async getProfileSettings() {
            return { nick: 'trader', settings: { defaultDayloss: -140, deposit: 10000 } };
        },
        async getRecentCoachInsight() {
            return null;
        },
        async getTrades() {
            return [{
                id: '1',
                user_id: 'u1',
                trade_date: '2026-09-20',
                ticker: 'AIMD',
                side: 'short',
                pnl: -50,
                setup: 'pump-and-dump',
                entry_price: 5,
                exit_price: 5.2,
                payload: { opened: '08:20', stop: 5.4 },
            }];
        },
        async getTradeById() { return null; },
        async getDay() { return null; },
        async getDays() { return []; },
        async getCriteriaSnapshot() { return []; },
    };
}

test('agent loop stops on final text and records tool trace', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) {
            return {
                ok: true,
                async json() {
                    return {
                        candidates: [{
                            content: {
                                parts: [{
                                    functionCall: {
                                        name: 'get_performance_stats',
                                        args: { from: '2026-09-01', to: '2026-09-30' },
                                    },
                                }],
                            },
                        }],
                    };
                },
            };
        }
        return {
            ok: true,
            async json() {
                return {
                    candidates: [{
                        content: { parts: [{ text: 'Після 08:00 результат гірший. n=1 — лише спостереження.' }] },
                    }],
                };
            },
        };
    };

    const result = await runAssistantAgent({
        db: createDb(),
        user: { id: 'u1' },
        message: 'Чому я торгую гірше?',
        pageContext: { tab: 'stats' },
        history: [],
        fetchImpl,
        env: {
            GEMINI_API_KEY: 'test-key',
            AI_PROVIDER: 'gemini',
        },
    });

    assert.match(result.answer, /08:00|спостереження/i);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.toolTrace.length, 1);
    assert.equal(result.toolTrace[0].name, 'get_performance_stats');
    assert.equal(result.rounds, 2);
});

test('agent respects maxRounds cap', async () => {
    const fetchImpl = async () => ({
        ok: true,
        async json() {
            return {
                candidates: [{
                    content: {
                        parts: [{ functionCall: { name: 'get_risk_state', args: {} } }],
                    },
                }],
            };
        },
    });

    const result = await runAssistantAgent({
        db: createDb(),
        user: { id: 'u1' },
        message: 'ризик?',
        fetchImpl,
        env: { GEMINI_API_KEY: 'test-key', AI_PROVIDER: 'gemini' },
        maxRounds: 2,
    });

    assert.equal(result.truncated, true);
    assert.equal(result.rounds, 2);
    assert.match(result.answer, /ліміт/i);
});

test('empty message fails with 400', async () => {
    await assert.rejects(
        () => runAssistantAgent({
            db: createDb(),
            user: { id: 'u1' },
            message: '   ',
            env: { GEMINI_API_KEY: 'test-key' },
        }),
        (error) => error.status === 400,
    );
});

test('agent strips HTML from chat history before prompting', async () => {
    let body = null;
    const fetchImpl = async (_url, options) => {
        body = JSON.parse(options.body);
        return {
            ok: true,
            async json() {
                return { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
            },
        };
    };
    await runAssistantAgent({
        db: createDb(),
        user: { id: 'u1' },
        message: 'підсумок',
        history: [{ role: 'ai', text: '<strong>AI</strong><br>попередня відповідь' }],
        fetchImpl,
        env: { GEMINI_API_KEY: 'test-key', AI_PROVIDER: 'gemini' },
    });
    const historyText = JSON.stringify(body.contents);
    assert.equal(historyText.includes('<strong>'), false);
    assert.match(historyText, /попередня відповідь/);
});
