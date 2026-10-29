import test from 'node:test';
import assert from 'node:assert/strict';
import { driveScreenshotResponse } from '../lib/drive_screenshot_media.js';

const row = { user_id: 'owner', source_file_id: 'file-1', quality_details: { connectionId: 'connection' } };
test('Drive media requires the exact owner connection and membership of its folder', async () => {
    const calls = [];
    const dependencies = {
        rest: async path => { assert.match(path, /user_id=eq.owner/); return [{ resource_id: 'allowed' }]; },
        getToken: async () => 'service-token',
        fetcher: async url => { calls.push(url); return Response.json({ parents: ['different'], mimeType: 'image/png' }); },
    };
    await assert.rejects(driveScreenshotResponse(row, dependencies), error => error.status === 403);
    assert.equal(calls.length, 1);
    await assert.rejects(driveScreenshotResponse(row, { ...dependencies, rest: async () => [] }), error => error.status === 403);
    assert.equal(calls.length, 1);
});
test('authorized Drive media is streamed directly from Google without a Storage download', async () => {
    const calls = [];
    const result = await driveScreenshotResponse(row, {
        rest: async () => [{ resource_id: 'allowed' }], getToken: async () => 'service-token',
        fetcher: async url => {
            calls.push(url);
            return url.includes('alt=media') ? new Response('image-data', { headers: { 'Content-Type': 'image/png' } })
                : Response.json({ parents: ['allowed'], mimeType: 'image/png', size: 10 });
        },
    });
    assert.equal(await result.response.text(), 'image-data');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.startsWith('https://www.googleapis.com/')));
});
