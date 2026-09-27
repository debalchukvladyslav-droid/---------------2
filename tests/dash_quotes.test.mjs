import test from 'node:test';
import assert from 'node:assert/strict';
import { DASH_QUOTES, TRADER_RULES, TRADER_RULE_LABEL, pickDashQuote } from '../js/dash_quotes_core.js';

test('dashboard quotes are unique and attributed', () => {
    assert.ok(DASH_QUOTES.length >= 40);
    const texts = new Set(DASH_QUOTES.map((quote) => quote.text));
    assert.equal(texts.size, DASH_QUOTES.length);
    for (const quote of DASH_QUOTES) {
        assert.match(quote.text, /^«.+»$/);
        assert.ok(quote.author.trim().length > 1);
    }
});

test('the same person keeps one quote for the day', () => {
    const first = pickDashQuote({ userId: 'user-a', date: '2026-09-26' });
    const second = pickDashQuote({ userId: 'user-a', date: '2026-09-26' });
    assert.equal(first.text, second.text);
    assert.equal(first.author, second.author);
});

test('different people see different quotes on the same day', () => {
    const seen = new Set(['alice', 'boris', 'carla', 'dmytro', 'eva', 'farid', 'galia', 'hanna', 'ivan', 'jules', 'kira', 'lev']
        .map((userId) => pickDashQuote({ userId, date: '2026-09-26' }).text));
    assert.ok(seen.size >= 8);
});

test('trader rules are separate from named quotes', () => {
    assert.ok(TRADER_RULES.length >= 10);
    const named = new Set(DASH_QUOTES.map((quote) => quote.text));
    for (const rule of TRADER_RULES) {
        assert.match(rule.text, /^«.+»$/);
        assert.equal(named.has(rule.text), false);
    }
});

test('days alternate between a person and a trader rule', () => {
    const first = pickDashQuote({ userId: 'user-a', date: '2026-09-26' });
    const next = pickDashQuote({ userId: 'user-a', date: '2026-09-27' });
    assert.notEqual(first.kind, next.kind);
    const rule = first.kind === 'rule' ? first : next;
    const person = first.kind === 'person' ? first : next;
    assert.equal(rule.author, TRADER_RULE_LABEL);
    assert.notEqual(person.author, TRADER_RULE_LABEL);
});

test('a person walks through each library on its own days', () => {
    const personDays = [];
    const ruleDays = [];
    for (let offset = 0; personDays.length < DASH_QUOTES.length || ruleDays.length < TRADER_RULES.length; offset += 1) {
        const date = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
        const quote = pickDashQuote({ userId: 'user-a', date });
        if (quote.kind === 'person' && personDays.length < DASH_QUOTES.length) personDays.push(quote.text);
        if (quote.kind === 'rule' && ruleDays.length < TRADER_RULES.length) ruleDays.push(quote.text);
    }
    assert.equal(new Set(personDays).size, DASH_QUOTES.length);
    assert.equal(new Set(ruleDays).size, TRADER_RULES.length);
});
