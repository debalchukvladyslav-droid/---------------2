import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const root = resolve(process.argv[2] || '.recovery');
const checksum = await readFile(resolve(root, 'database.sha256'), 'utf8');
const expectedDatabaseHash = checksum.trim().match(/^([a-f0-9]{64})\s+\*?(?:\.recovery\/)?database\.dump$/i)?.[1]?.toLowerCase();
if (!expectedDatabaseHash) throw new Error('Invalid database checksum manifest');
const databaseHash = createHash('sha256').update(await readFile(resolve(root, 'database.dump'))).digest('hex');
if (databaseHash !== expectedDatabaseHash) throw new Error('Database archive checksum mismatch');
const manifest = JSON.parse(await readFile(resolve(root, 'storage-manifest.json'), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.objects)) throw new Error('Invalid storage manifest');
let bytes = 0;
for (const item of manifest.objects || []) {
    const path = resolve(root, 'storage', item.bucket, ...String(item.path).split('/'));
    if (!path.startsWith(resolve(root, 'storage') + sep)) throw new Error(`Unsafe manifest path: ${item.path}`);
    const info = await stat(path);
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== item.sha256 || info.size !== Number(item.size)) throw new Error(`Invalid backup object: ${item.bucket}/${item.path}`);
    bytes += info.size;
}
if (bytes !== Number(manifest.totalBytes) || (manifest.objects || []).length !== Number(manifest.objectCount)) {
    throw new Error('Storage manifest totals do not match restored files');
}
process.stdout.write(JSON.stringify({ verifiedObjects: manifest.objectCount, verifiedBytes: bytes, databaseSha256: databaseHash }));
