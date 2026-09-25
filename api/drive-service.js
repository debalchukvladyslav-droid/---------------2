import { getGoogleAccessToken, supabaseRest, verifySupabaseUser } from '../lib/google_sheet_sync.js';
import { fetchWithRetry } from '../lib/integration_io.js';
import { resolveSourceConnection, saveVerifiedConnection, sourceProfile, sourceAccessError, shouldProvisionDriveConnection } from '../lib/source_access.js';

const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const cleanId = value => /^[a-zA-Z0-9_-]+$/.test(String(value || '')) ? String(value) : '';
const sendJson = (res, status, body) => { res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'private, no-store'); res.end(JSON.stringify(body)); };

export async function driveFetch(path, token, query = {}, options = {}) {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
    return fetchWithRetry(url.toString(), { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
}
async function googleJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error?.message || `Google Drive HTTP ${response.status}`), { status: response.status });
    return body;
}
async function defaultFolder(userId) {
    const profiles = await supabaseRest(`profiles?id=eq.${encodeURIComponent(userId)}&select=settings&limit=1`);
    return cleanId(profiles?.[0]?.settings?.driveFolderId);
}

async function assertServiceCanReadFolder(folderId) {
    const serviceToken = await getGoogleAccessToken('https://www.googleapis.com/auth/drive.readonly');
    try {
        const folder = await googleJson(await driveFetch(`files/${folderId}`, serviceToken, { fields: 'id,mimeType,trashed', supportsAllDrives: 'true' }));
        if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') throw sourceAccessError('Потрібна доступна папка Google Drive.');
        return serviceToken;
    } catch (error) {
        if (error?.code === 'SOURCE_CONNECTION_REQUIRED') throw error;
        if (error?.status === 403 || error?.status === 404) throw sourceAccessError('Поширте папку на service account, щоб синхронізація могла її читати.');
        throw error;
    }
}

async function driveConnection(user, folderId, { connectionId = '', write = false } = {}) {
    try {
        return await resolveSourceConnection(user, 'drive', folderId, { connectionId, write });
    } catch (error) {
        if (!shouldProvisionDriveConnection(error, { folderId, write, connectionId })) throw error;
        await assertServiceCanReadFolder(folderId);
        return await saveVerifiedConnection({ userId: user.id, kind: 'drive', resourceId: folderId });
    }
}

export default async function handler(req, res) {
    try {
        if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        const action = String(req.query?.action || 'list');
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
        if (action === 'connect' && req.method === 'POST') {
            const folderId = cleanId(body.folderId);
            if (!folderId) return sendJson(res, 400, { ok: false, error: 'Missing folderId' });
            const admin = (await sourceProfile(user.id)).role === 'admin';
            const userGoogleToken = String(req.headers['x-google-access-token'] || '');
            if (userGoogleToken) {
                const folder = await googleJson(await driveFetch(`files/${folderId}`, userGoogleToken, { fields: 'id,mimeType,trashed', supportsAllDrives: 'true' }));
                if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') throw sourceAccessError('Потрібна доступна папка Google Drive.');
            }
            await assertServiceCanReadFolder(folderId);
            const connection = await saveVerifiedConnection({ userId: admin && body.userId ? body.userId : user.id, kind: 'drive', resourceId: folderId });
            const job = await supabaseRest('rpc/enqueue_source_sync', { method: 'POST', body: JSON.stringify({ p_connection_id: connection.id }) });
            return sendJson(res, 202, { ok: true, connectionId: connection.id, job });
        }
        const folderId = cleanId(req.query?.folderId || body.folderId) || await defaultFolder(user.id);
        const connection = await driveConnection(user, folderId, { connectionId: req.query?.connectionId || body.connectionId || '', write: req.method === 'POST' });
        if (action === 'queue' && req.method === 'POST') {
            if (!connection.id) throw sourceAccessError('Спочатку підтвердьте підключення папки.');
            const job = await supabaseRest('rpc/enqueue_source_sync', { method: 'POST', body: JSON.stringify({ p_connection_id: connection.id }) });
            return sendJson(res, 202, { ok: true, queued: true, job });
        }
        if (action === 'disconnect' && req.method === 'POST') {
            if (connection.id) await supabaseRest(`integration_connections?id=eq.${connection.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
            return sendJson(res, 200, { ok: true });
        }
        // Ordinary screenshot deletion is reversible and never mutates Google.
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Unsupported action' });
        if (action === 'status') {
            const jobs = connection.id ? await supabaseRest(`source_sync_jobs?connection_id=eq.${connection.id}&select=id,status,last_error,progress,updated_at&limit=1`) : [];
            return sendJson(res, 200, { ok: true, connectionId: connection.id, lastSyncAt: connection.last_sync_at, job: jobs?.[0] || null });
        }
        const token = await getGoogleAccessToken('https://www.googleapis.com/auth/drive.readonly');
        if (action === 'list') {
            const data = await googleJson(await driveFetch('files', token, {
                q: `'${connection.resource_id}' in parents and mimeType contains 'image/' and trashed=false`,
                fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,md5Checksum,size,imageMediaMetadata(width,height))',
                orderBy: 'modifiedTime desc', pageSize: '100', pageToken: String(req.query?.pageToken || ''), supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
            }));
            return sendJson(res, 200, { ok: true, ...data });
        }
        if (action === 'media') {
            const fileId = cleanId(req.query?.fileId);
            if (!fileId) return sendJson(res, 400, { ok: false, error: 'Missing fileId' });
            const meta = await googleJson(await driveFetch(`files/${fileId}`, token, { fields: 'id,name,mimeType,size,parents,trashed', supportsAllDrives: 'true' }));
            if (meta.trashed || !meta.parents?.includes(connection.resource_id)) throw sourceAccessError('Файл не належить дозволеній папці.');
            if (Number(meta.size) > MAX_PROXY_BYTES) return sendJson(res, 413, { ok: false, code: 'USE_BACKGROUND_SYNC', error: 'Великий файл скопіює фоновий процес.' });
            const response = await driveFetch(`files/${fileId}`, token, { alt: 'media', supportsAllDrives: 'true' });
            if (!response.ok) await googleJson(response);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > MAX_PROXY_BYTES) return sendJson(res, 413, { ok: false, error: 'Use background sync' });
            res.status(200).setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
            res.setHeader('Cache-Control', 'private, no-store');
            return res.end(bytes);
        }
        return sendJson(res, 400, { ok: false, error: 'Unknown action' });
    } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.message || String(error), code: error.code || '' });
    }
}
