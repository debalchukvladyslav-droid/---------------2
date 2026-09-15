import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(process.env.BACKUP_WORKDIR || '.recovery');
const storageRoot = join(root, 'storage');
const manifestPath = join(root, 'storage-manifest.json');
const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const previous = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => ({ objects: [] }));
const previousByKey = new Map((previous.objects || []).map(item => [`${item.bucket}/${item.path}`, item]));

async function json(endpoint, options = {}) {
    const response = await fetch(`${url}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(60_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${body.message || body.error || response.statusText}`);
    return body;
}

async function listObjects(bucket, prefix = '') {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
        const page = await json(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
            method: 'POST', body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        for (const item of page) {
            if (!item?.name) continue;
            const path = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.id) rows.push({ ...item, name: path });
            else rows.push(...await listObjects(bucket, path));
        }
        if (page.length < 1000) return rows;
    }
}

function localPath(bucket, objectPath) {
    const normalized = String(objectPath).replaceAll('\\', '/').split('/').filter(Boolean);
    if (!normalized.length || normalized.some(part => part === '..')) throw new Error(`Unsafe storage path: ${objectPath}`);
    const path = resolve(storageRoot, bucket, ...normalized);
    if (!path.startsWith(resolve(storageRoot) + sep)) throw new Error(`Unsafe storage path: ${objectPath}`);
    return path;
}

async function sha256(path) {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
}

async function download(item) {
    const path = localPath(item.bucket, item.path);
    const old = previousByKey.get(`${item.bucket}/${item.path}`);
    const expectedSize = Number(item.size || 0);
    const existing = await stat(path).catch(() => null);
    if (old && old.updatedAt === item.updatedAt && existing?.isFile() && (!expectedSize || existing.size === expectedSize)) {
        return { ...item, sha256: old.sha256, size: existing.size, reused: true };
    }
    const encoded = item.path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(item.bucket)}/${encoded}`, {
        headers, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Download ${item.bucket}/${item.path}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (expectedSize && bytes.length !== expectedSize) throw new Error(`Size mismatch: ${item.bucket}/${item.path}`);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.partial`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    return { ...item, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, reused: false };
}

await mkdir(storageRoot, { recursive: true });
const buckets = await json('/storage/v1/bucket');
const inventory = [];
for (const bucket of buckets) {
    for (const object of await listObjects(bucket.id)) {
        inventory.push({ bucket: bucket.id, path: object.name, updatedAt: object.updated_at || object.updatedAt || '',
            size: Number(object.metadata?.size || 0), contentType: object.metadata?.mimetype || object.metadata?.contentType || '' });
    }
}

const objects = [];
for (let index = 0; index < inventory.length; index += 4) {
    objects.push(...await Promise.all(inventory.slice(index, index + 4).map(download)));
}
for (const item of objects) {
    const actual = await sha256(localPath(item.bucket, item.path));
    if (actual !== item.sha256) throw new Error(`Checksum mismatch: ${item.bucket}/${item.path}`);
}
const manifest = { version: 1, createdAt: new Date().toISOString(), objectCount: objects.length,
    totalBytes: objects.reduce((sum, item) => sum + item.size, 0), downloaded: objects.filter(item => !item.reused).length,
    reused: objects.filter(item => item.reused).length, objects: objects.map(({ reused, ...item }) => item) };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify({ objectCount: manifest.objectCount, totalBytes: manifest.totalBytes,
    downloaded: manifest.downloaded, reused: manifest.reused }));
