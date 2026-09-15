import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeUpload } from '../js/upload_queue_core.js';

test('a lost TUS response resumes from the server offset without repeating bytes', async () => {
    const endpoint = 'https://project.storage.supabase.co/storage/v1/upload/resumable';
    const blob = new Blob(['abcdef'], { type: 'image/png' });
    let persisted = { id: 'job', blob, bucket: 'screenshots', objectPath: 'user/file.png', contentType: 'image/png', sha256: 'a'.repeat(64) };
    let serverOffset = 0;
    let firstPatch = true;
    const fetchImpl = async (url, options) => {
        if (options.method === 'POST') return new Response(null, { status: 201, headers: { Location: `${endpoint}/session-1` } });
        if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Upload-Offset': String(serverOffset) } });
        if (options.method === 'PATCH') {
            if (firstPatch) {
                firstPatch = false;
                serverOffset = blob.size;
                return new Response(null, { status: 503 });
            }
            throw new Error('The acknowledged bytes were uploaded twice');
        }
        throw new Error(`Unexpected ${options.method} ${url}`);
    };
    const options = { endpoint, getHeaders: async () => ({ 'x-signature': 'token' }),
        persist: async value => { persisted = value; }, fetchImpl };
    await assert.rejects(resumeUpload(persisted, options), /HTTP 503/);
    const completed = await resumeUpload(persisted, options);
    assert.equal(completed.offset, blob.size);
    assert.equal(completed.status, 'uploaded');
});

test('TUS refuses a continuation URL on another origin', async () => {
    const job = { blob: new Blob(['x']), sessionUrl: 'https://attacker.invalid/upload' };
    await assert.rejects(resumeUpload(job, {
        endpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable',
        getHeaders: async () => ({}), persist: async () => {}, fetchImpl: async () => new Response(),
    }), /Неприпустима адреса|continuation/i);
});
