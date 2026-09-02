import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const localStore = await readFile(new URL('../js/local_data_store.js', import.meta.url), 'utf8');
const storage = await readFile(new URL('../js/storage.js', import.meta.url), 'utf8');
const realtime = await readFile(new URL('../js/realtime_sync.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260902113810_local_first_sync.sql', import.meta.url), 'utf8');

test('journal uses a durable IndexedDB cache and dirty queue', () => {
    assert.match(localStore, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
    assert.match(localStore, /user_dirty/);
    assert.match(storage, /cacheJournalRows\(userId, rows, \{ dirty: true \}\)/);
    assert.match(storage, /readDirtyJournalRows\(userId\)/);
    assert.match(storage, /markJournalRowsSynced\(userId, confirmedDates\)/);
});

test('startup hydrates cached months and then uses one bootstrap request', () => {
    assert.match(storage, /hydrateLocalJournal\(viewedUserId, \[prevMk, currentMk\]\)/);
    assert.match(storage, /supabase\.rpc\('get_app_bootstrap'/);
    assert.match(storage, /loadBootstrapJournal\(nick, viewedUserId, \[prevMk, currentMk\]\)/);
});

test('writes are coalesced, version-safe, and sent in batches', () => {
    assert.match(storage, /const delay = opts\.immediate === true \|\| elapsed >= 800 \? 0 : 180/);
    assert.match(storage, /revisionsAtSave/);
    assert.match(storage, /sync_journal_days_batch/);
    assert.match(migration, /sync_version bigint not null default 1/i);
    assert.match(migration, /create index if not exists idx_journal_days_user_updated/i);
    assert.match(migration, /security invoker/gi);
});

test('realtime ignores the echo of a just-confirmed local write', () => {
    assert.match(realtime, /wasDayRecentlySaved\(tradeDate\)/);
    assert.ok(realtime.indexOf(".on('postgres_changes'") < realtime.indexOf('.subscribe('));
});
