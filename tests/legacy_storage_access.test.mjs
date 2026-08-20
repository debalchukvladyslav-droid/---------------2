import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('legacy files screenshots are read-only and ownership is taken from the nested user folder', async () => {
    const source = await readFile(new URL('../api/storage-upload.js', import.meta.url), 'utf8');
    assert.match(source, /LEGACY_READ_BUCKETS = new Set\(\['files'\]\)/);
    assert.match(source, /req\.method === 'GET'.*LEGACY_READ_BUCKETS\.has\(bucket\)/);
    assert.match(source, /bucket === 'files'.*parts\[0\] === 'screenshots'.*isUuid\(parts\[1\]\)/s);
    assert.doesNotMatch(source, /ALLOWED_BUCKETS = new Set\([^\n]*'files'/);
    assert.match(source, /missing: true, bucket, objectPath, signedUrl: ''/);
});

test('missing screenshot URLs persist to avoid repeated requests after reload', async () => {
    const source = await readFile(new URL('../js/gallery.js', import.meta.url), 'utf8');
    assert.match(source, /MISSING_STORAGE_URL_TTL_MS = 24 \* 60 \* 60 \* 1000/);
    assert.match(source, /MISSING_STORAGE_CACHE_PREFIX = 'sc-missing:'/);
    assert.match(source, /_getMissingStorageAt\(storagePath\)/);
    assert.match(source, /_clearMissingStorage\(storagePath\)/);
});
