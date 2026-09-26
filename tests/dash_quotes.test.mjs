import test from 'node:test';
import assert from 'node:assert/strict';
import { DASH_QUOTES, pickDashQuote } from '../js/dash_quotes_core.js';

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

test('a person walks through the library across days', () => {
    const seen = new Set();
    for (let offset = 0; offset < DASH_QUOTES.length; offset += 1) {
        const date = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
        seen.add(pickDashQuote({ userId: 'user-a', date }).text);
    }
    assert.equal(seen.size, DASH_QUOTES.length);
});
