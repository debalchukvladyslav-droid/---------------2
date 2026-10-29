import { getGoogleAccessToken, getSupabaseEnv, supabaseRest } from './google_sheet_sync.js';
import { fetchWithRetry } from './integration_io.js';

const imageType = value => /^image\/(?:png|jpeg|webp|gif)$/.test(String(value || ''));
const denied = () => Object.assign(new Error('Немає доступу до скріншота Google Drive.'), { status: 403 });

// Use the caller's JWT for the manifest lookup: existing screenshot RLS decides
// whether an owner, mentor or administrator may view this particular image.
export async function authorizedDriveScreenshot(path, authorization) {
    const { url, anonKey } = getSupabaseEnv();
    const query = new URLSearchParams({ storage_path: `eq.${path}`, source: 'eq.drive', deleted_at: 'is.null',
        select: 'user_id,source_file_id,quality_details,source_modified_at,mime_type', limit: '1' });
    const response = await fetchWithRetry(`${url}/rest/v1/screenshots?${query}`, { headers: { apikey: anonKey, Authorization: authorization } });
    if (!response.ok) throw Object.assign(new Error('Не вдалося перевірити доступ до скріншота.'), { status: response.status });
    const row = (await response.json())?.[0];
    if (!row) throw denied();
    return row;
}

export async function driveScreenshotResponse(row, { rest = supabaseRest, getToken = getGoogleAccessToken, fetcher = fetchWithRetry } = {}) {
    const connectionId = row?.quality_details?.connectionId;
    const fileId = String(row?.source_file_id || '');
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw denied();
    const query = new URLSearchParams({ user_id: `eq.${row.user_id}`, kind: 'eq.drive', enabled: 'eq.true', select: 'resource_id', limit: '50' });
    if (connectionId) query.set('id', `eq.${connectionId}`);
    const connections = await rest(`integration_connections?${query}`);
    if (!connections?.length) throw denied();
    const token = await getToken('https://www.googleapis.com/auth/drive.readonly');
    const headers = { Authorization: `Bearer ${token}` };
    const metadataResponse = await fetcher(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,mimeType,size,parents,trashed,modifiedTime,md5Checksum&supportsAllDrives=true`, { headers });
    if (!metadataResponse.ok) throw Object.assign(new Error('Оригінал скріншота недоступний у Google Drive.'), { status: metadataResponse.status });
    const metadata = await metadataResponse.json();
    if (metadata.trashed || !connections.some(connection=>metadata.parents?.includes(connection.resource_id)) || !imageType(metadata.mimeType)) throw denied();
    if (Number(metadata.size) > 25 * 1024 * 1024) throw Object.assign(new Error('Скріншот перевищує 25 MB.'), { status: 413 });
    const response = await fetcher(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers });
    if (!response.ok) throw Object.assign(new Error('Не вдалося прочитати скріншот Google Drive.'), { status: response.status });
    return { response, metadata };
}

export async function findRemoteDriveScreenshot(path, userId) {
    if (!userId || !path) return null;
    const query = new URLSearchParams({ user_id: `eq.${userId}`, storage_path: `eq.${path}`, source: 'eq.drive', deleted_at: 'is.null',
        select: 'user_id,source_file_id,quality_details', limit: '1' });
    const row = (await supabaseRest(`screenshots?${query}`))?.[0];
    return row || null;
}
