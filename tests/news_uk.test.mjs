import test from 'node:test';
import assert from 'node:assert/strict';
import { fillUkrainianHeadlines, isUkrainianHeadline, parseGoogleTranslatePayload, splitTranslatedBatch } from '../lib/news_uk.js';

test('google translate payload keeps the batch separator', () => {
    const joined = parseGoogleTranslatePayload([[
        ['Apple повідомляє про рекордні доходи\n§\nFDA схвалив новий препарат проти раку', 'source', null, null, 1],
    ]]);
    const parts = splitTranslatedBatch(joined, 2);
    assert.deepEqual(parts, [
        'Apple повідомляє про рекордні доходи',
        'FDA схвалив новий препарат проти раку',
    ]);
    assert.equal(isUkrainianHeadline(parts[0]), true);
    assert.equal(isUkrainianHeadline('Apple reports record revenue'), false);
});

test('english headlines are replaced with Ukrainian titles', async () => {
    const fetchImpl = async (url) => {
        const query = new URL(url).searchParams.get('q') || '';
        const text = query.includes('FDA')
            ? 'FDA схвалив новий препарат проти раку'
            : 'Apple повідомляє про рекордні доходи';
        return { ok: true, json: async () => [[[text, '', null, null, 1]]] };
    };
    const items = await fillUkrainianHeadlines([
        { title: 'Apple reports record revenue', titleUk: '' },
        { title: 'FDA approves new cancer drug', titleUk: 'FDA схвалив новий препарат проти раку' },
    ], fetchImpl);
    assert.equal(items[0].titleUk, 'Apple повідомляє про рекордні доходи');
    assert.equal(items[1].titleUk, 'FDA схвалив новий препарат проти раку');
});
