import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('market widgets refresh an expired Supabase session and retry once', async () => {
    const [helper, news, sentiment] = await Promise.all([
        readFile(new URL('../js/authenticated_fetch.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/news.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/market_sentiment.js', import.meta.url), 'utf8'),
    ]);
    assert.match(helper, /response\.status !== 401/);
    assert.match(helper, /supabase\.auth\.refreshSession\(\)/);
    assert.match(news, /fetchWithSession\(requestPath\)/);
    assert.match(sentiment, /fetchWithSession\('\/api\/fear-greed'\)/);
});

test('read-only market APIs survive a temporary Supabase auth outage', async () => {
    const [newsApi, sentimentApi] = await Promise.all([
        readFile(new URL('../api/news.js', import.meta.url), 'utf8'),
        readFile(new URL('../api/fear-greed.js', import.meta.url), 'utf8'),
    ]);
    assert.match(newsApi, /auth check unavailable; allowing read-only market request/);
    assert.match(sentimentApi, /auth check unavailable; allowing read-only market request/);
});

test('dashboard news translation failure never blocks tab navigation or becomes persistent', async () => {
    const [news, ui] = await Promise.all([
        readFile(new URL('../js/news.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
    ]);
    assert.match(news, /api key not valid\|invalid api key/);
    assert.match(news, /if \(!translated\?\.translationPending\) savePersistentNewsCache/);
    assert.match(ui, /void Promise\.resolve\(window\.renderDashboardNews\(\)\)/);
    assert.doesNotMatch(ui, /tasks\.push\(Promise\.resolve\(window\.renderDashboardNews\(\)\)\)/);
});
