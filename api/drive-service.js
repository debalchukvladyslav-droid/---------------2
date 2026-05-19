import { GOOGLE_DRIVE_SCOPE, getGoogleAccessToken, verifySupabaseUser } from './_google_sheet_sync_lib.js';

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function cleanDriveId(value) {
    const id = String(value || '').trim();
    return /^[a-zA-Z0-9_-]+$/.test(id) ? id : '';
}

async function driveFetch(path, token, query = {}) {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
    });
    return response;
}

async function listFolder(req, res, token) {
    const folderId = cleanDriveId(req.query.folderId);
    if (!folderId) return sendJson(res, 400, { ok: false, error: 'Missing folderId' });

    const response = await driveFetch('files', token, {
        q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
        fields: 'files(id,name,mimeType,createdTime,modifiedTime,size)',
        orderBy: 'modifiedTime desc',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        return sendJson(res, response.status, {
            ok: false,
            error: data.error?.message || response.statusText,
        });
    }
    return sendJson(res, 200, { ok: true, files: data.files || [] });
}

async function streamFile(req, res, token) {
    const fileId = cleanDriveId(req.query.fileId);
    if (!fileId) return sendJson(res, 400, { ok: false, error: 'Missing fileId' });

    const metaResponse = await driveFetch(`files/${fileId}`, token, {
        fields: 'id,name,mimeType,size',
        supportsAllDrives: 'true',
    });
    const meta = await metaResponse.json().catch(() => ({}));
    if (!metaResponse.ok) {
        return sendJson(res, metaResponse.status, {
            ok: false,
            error: meta.error?.message || metaResponse.statusText,
        });
    }
    if (Number(meta.size || 0) > MAX_FILE_SIZE_BYTES) {
        return sendJson(res, 413, { ok: false, error: 'File is too large' });
    }

    const mediaResponse = await driveFetch(`files/${fileId}`, token, {
        alt: 'media',
        supportsAllDrives: 'true',
    });
    if (!mediaResponse.ok) {
        const data = await mediaResponse.json().catch(() => ({}));
        return sendJson(res, mediaResponse.status, {
            ok: false,
            error: data.error?.message || mediaResponse.statusText,
        });
    }

    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
    if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
        return sendJson(res, 413, { ok: false, error: 'File is too large' });
    }

    res.status(200);
    res.setHeader('Content-Type', meta.mimeType || mediaResponse.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Drive-File-Name', encodeURIComponent(meta.name || fileId));
    res.end(buffer);
}

export default async function handler(req, res) {
    try {
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user?.id) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

        const token = await getGoogleAccessToken(GOOGLE_DRIVE_SCOPE);
        const action = String(req.query.action || 'list');
        if (action === 'list') return listFolder(req, res, token);
        if (action === 'media') return streamFile(req, res, token);
        return sendJson(res, 400, { ok: false, error: 'Unknown action' });
    } catch (error) {
        const message = error?.message || String(error);
        const missingServiceAccount = message.includes('Google service account env is not configured');
        return sendJson(res, missingServiceAccount ? 501 : 500, { ok: false, error: message });
    }
}
