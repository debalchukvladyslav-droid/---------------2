import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function serverlessFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return serverlessFiles(target);
        return /\.(?:js|mjs|ts)$/.test(entry.name) ? [target] : [];
    }));
    return nested.flat();
}

test('Vercel Hobby deployment stays within twelve serverless functions', async () => {
    const files = await serverlessFiles(fileURLToPath(new URL('../api', import.meta.url)));
    assert.ok(files.length <= 12, `Found ${files.length} Serverless Functions: ${files.join(', ')}`);
});

test('client config and server time share the service-bot dynamic function', async () => {
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    const routes = new Map(config.rewrites.map((route) => [route.source, route.destination]));
    assert.equal(routes.get('/config.js'), '/api/service-bots/client-config');
    assert.match(routes.get('/api/server-time'), /^\/api\/service-bots\/client-config/);
});
