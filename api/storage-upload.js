import { getSupabaseEnv, verifySupabaseUser } from './_google_sheet_sync_lib.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const OWNER_BUCKETS = new Set(['screenshots', 'backgrounds', 'avatars']);
const AUTO_CREATE_BUCKETS = new Set(['screenshots', 'backgrounds', 'avatars']);

export const config = {
    api: {
        bodyParser: false,
    },
};

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function cleanBucket(value) {
    const bucket = String(value || '').trim();
    return /^[a-z0-9._-]+$/i.test(bucket) ? bucket : '';
}

function cleanObjectPath(value) {
    let decoded = '';
    try {
        decoded = decodeURIComponent(String(value || '').trim());
    } catch (_) {
        decoded = String(value || '').trim();
    }
    const path = decoded.replace(/^\/+/, '');
    if (!path || path.includes('..') || /[\r\n]/.test(path)) return '';
    return path;
}

function encodeStoragePath(path) {
    return String(path || '')
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

function normalizeSignedUrl(baseUrl, signed) {
    const value = String(signed || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/storage/v1/')) return `${baseUrl}${value}`;
    if (value.startsWith('/object/')) return `${baseUrl}/storage/v1${value}`;
    return `${baseUrl}/storage/v1/${value.replace(/^\/+/, '')}`;
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function cleanExpiresIn(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 3600;
    return Math.max(60, Math.min(24 * 60 * 60, Math.floor(n)));
}

async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
            const error = new Error('File is too large');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function createSignedUrl({ url, serviceKey, bucket, objectPath, expiresIn = 3600 }) {
    const encodedPath = encodeStoragePath(objectPath);
    const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encodedPath}`, {
        method: 'POST',
        headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn }),
    });
    const data = await response.json().catch(() => ({}));
    const signed = data.signedURL || data.signedUrl || data.signed_url || '';
    if (!response.ok || !signed) return '';
    return normalizeSignedUrl(url, signed);
}

async function ensureBucketExists({ url, serviceKey, bucket }) {
    if (!AUTO_CREATE_BUCKETS.has(bucket)) return;
    const getResponse = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
        headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
        },
    });
    if (getResponse.ok) return;

    const createResponse = await fetch(`${url}/storage/v1/bucket`, {
        method: 'POST',
        headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            id: bucket,
            name: bucket,
            public: false,
            file_size_limit: MAX_UPLOAD_BYTES,
        }),
    });
    if (!createResponse.ok && createResponse.status !== 409) {
        const text = await createResponse.text().catch(() => '');
        throw new Error(`Could not create storage bucket ${bucket}: ${text || createResponse.statusText}`);
    }
}

function shouldRetryAfterEnsuringBucket(status, message = '') {
    const text = String(message || '').toLowerCase();
    return status === 400 || status === 404 || text.includes('bucket') || text.includes('not found');
}

export default async function handler(req, res) {
    try {
        if (req.method !== 'POST' && req.method !== 'GET') {
            res.setHeader('Allow', 'GET, POST');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

        const bucket = cleanBucket(req.query.bucket);
        const objectPath = cleanObjectPath(req.query.objectPath);
        if (!bucket || !objectPath) return sendJson(res, 400, { ok: false, error: 'Missing bucket or objectPath' });

        const ownerKey = objectPath.split('/')[0] || '';
        if (req.method !== 'GET' && OWNER_BUCKETS.has(bucket) && (!isUuid(ownerKey) || ownerKey !== user.id)) {
            return sendJson(res, 403, { ok: false, error: 'Storage owner mismatch' });
        }

        const { url, serviceKey } = getSupabaseEnv();
        if (!serviceKey) return sendJson(res, 501, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' });
        await ensureBucketExists({ url, serviceKey, bucket });

        if (req.method === 'GET') {
            const signedUrl = await createSignedUrl({
                url,
                serviceKey,
                bucket,
                objectPath,
                expiresIn: cleanExpiresIn(req.query.expiresIn),
            });
            if (!signedUrl) return sendJson(res, 404, { ok: false, error: 'Storage object not found or cannot be signed' });
            return sendJson(res, 200, { ok: true, bucket, objectPath, signedUrl });
        }

        const body = await readBody(req);
        if (!body.length) return sendJson(res, 400, { ok: false, error: 'Empty upload body' });

        const contentType = req.headers['content-type'] || 'application/octet-stream';
        const encodedPath = encodeStoragePath(objectPath);
        let uploadResponse = await fetch(`${url}/storage/v1/object/${bucket}/${encodedPath}`, {
            method: 'POST',
            headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
                'Content-Type': contentType,
                'x-upsert': 'true',
            },
            body,
        });

        let uploadText = await uploadResponse.text().catch(() => '');
        if (!uploadResponse.ok && shouldRetryAfterEnsuringBucket(uploadResponse.status, uploadText)) {
            await ensureBucketExists({ url, serviceKey, bucket });
            uploadResponse = await fetch(`${url}/storage/v1/object/${bucket}/${encodedPath}`, {
                method: 'POST',
                headers: {
                    apikey: serviceKey,
                    Authorization: `Bearer ${serviceKey}`,
                    'Content-Type': contentType,
                    'x-upsert': 'true',
                },
                body,
            });
            uploadText = await uploadResponse.text().catch(() => '');
        }
        if (!uploadResponse.ok) {
            console.warn('[Storage upload service] upload failed', {
                bucket,
                objectPath,
                status: uploadResponse.status,
                message: uploadText || uploadResponse.statusText,
            });
            return sendJson(res, uploadResponse.status, {
                ok: false,
                error: uploadText || uploadResponse.statusText,
            });
        }

        const signedUrl = await createSignedUrl({ url, serviceKey, bucket, objectPath });
        return sendJson(res, 200, { ok: true, bucket, objectPath, signedUrl });
    } catch (error) {
        const status = error?.status || 500;
        const message = error?.message || String(error);
        console.error('[Storage upload service] fatal', { status, message });
        return sendJson(res, status, { ok: false, error: message });
    }
}
