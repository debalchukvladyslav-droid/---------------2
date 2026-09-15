import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('startup loads core months and light dashboard feeds while keeping heavy analysis lazy', async () => {
    const [storage, main, realtime, ui] = await Promise.all([
        readFile(new URL('../js/storage.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/main.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/realtime_sync.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
    ]);
    const initializeBody = storage.slice(storage.indexOf('export async function initializeApp()'));
    assert.doesNotMatch(initializeBody, /await loadTradeDays\(nick, viewedUserId\)/);
    assert.doesNotMatch(initializeBody, /window\.loadImages\(\)/);
    assert.doesNotMatch(initializeBody, /loadScreenshotRegistry/);
    assert.match(initializeBody, /loadMonth\(nick, currentMk, viewedUserId\)/);
    assert.match(main, /setTimeout\(async \(\) => \{/);
    assert.match(main, /\}, 5000\)/);
    assert.doesNotMatch(realtime, /loadTradeDays/);
    assert.match(realtime, /await syncDataNow\(\)/);
    const tabWork = ui.slice(ui.indexOf('async function runMainTabWork'), ui.indexOf('function getDashboardGreetingName'));
    assert.match(tabWork, /renderDashboardNews/);
    assert.doesNotMatch(tabWork, /renderDashboardAI/);
    assert.match(tabWork, /renderMarketSentiment/);
    assert.doesNotMatch(tabWork, /loadTradeDays/);
    assert.doesNotMatch(tabWork, /Polygon/);
});

test('ordinary journal saves do not create backups and embeddings are gently deferred', async () => {
    const storage = await readFile(new URL('../js/storage.js', import.meta.url), 'utf8');
    const saveBody = storage.slice(storage.indexOf('async function _doSave'), storage.indexOf('function _computeAggregation'));
    assert.doesNotMatch(saveBody, /createCompressedBackup/);
    assert.match(saveBody, /commitLocalChanges/);
    assert.match(storage, /tradeEmbeddingTimer = setTimeout/);
    assert.match(storage, /\}, 30000\)/);
    assert.match(storage, /setTimeout\(resolve, 2000\)/);
});

test('opening screenshots resets its daily inbox to the local current date', async () => {
    const ui = await readFile(new URL('../js/ui.js', import.meta.url), 'utf8');
    const tabWork = ui.slice(ui.indexOf('async function runMainTabWork'), ui.indexOf('function getDashboardGreetingName'));
    const screensBlock = tabWork.slice(tabWork.indexOf("if (tab === 'screens')"));
    assert.match(screensBlock, /const today = new Date\(\)/);
    assert.match(screensBlock, /state\.selectedDateStr = `\$\{today\.getFullYear\(\)\}/);
    assert.doesNotMatch(screensBlock.slice(0, screensBlock.indexOf("if (tab === 'stop-errors')")), /toISOString\(\)/);
});

test('Polygon durable cron remains disabled after migrations', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20260824152000_disable_polygon_cron.sql', import.meta.url), 'utf8');
    assert.match(migration, /cron\.unschedule/);
    assert.match(migration, /polygon-durable-worker/);
});
