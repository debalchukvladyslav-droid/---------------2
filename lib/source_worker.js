import crypto from 'node:crypto';
import { getGoogleAccessToken, getSupabaseEnv, runGoogleSheetSync, supabaseRest, supabaseRestAll } from './google_sheet_sync.js';
import { collectPages, fetchWithRetry } from './integration_io.js';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export async function googleDriveJson(path, token, query = {}) {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
    Object.entries(query).forEach(([key, value]) => { if (value !== '') url.searchParams.set(key, value); });
    const response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error?.message || `Google Drive HTTP ${response.status}`), { status: response.status });
    return data;
}

export function pendingDriveFiles(files, rows) {
    const deleted = new Set(rows.filter(row => row.deleted_at).map(row => row.source_file_id));
    return files.filter(file => {
        if (deleted.has(file.id) || !IMAGE_TYPES.has(file.mimeType)) return false;
        const copies = rows.filter(row => row.source_file_id === file.id && !row.deleted_at);
        return !copies.some(row => row.source_modified_at && Date.parse(row.source_modified_at) === Date.parse(file.modifiedTime));
    });
}

export async function runDriveSourceSync(connection, { deadline = Date.now() + 90_000 } = {}) {
    const token = await getGoogleAccessToken('https://www.googleapis.com/auth/drive.readonly');
    const files = await collectPages(pageToken => googleDriveJson('files', token, {
        q: `'${connection.resource_id}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,imageMediaMetadata(width,height))',
        pageSize: '100', pageToken, orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    }));
    const state = await supabaseRest('rpc/get_data_sync_state', { method: 'POST', body: JSON.stringify({ p_user_id: connection.user_id }) });
    const rows = await supabaseRestAll(`screenshots?user_id=eq.${connection.user_id}&source=eq.drive&select=source_file_id,source_modified_at,deleted_at,storage_path,source_revision&order=created_at.asc`);
    const pending = pendingDriveFiles(files, rows);
    const errors = [];
    let copied = 0;
    let considered = 0;
    const { url, serviceKey } = getSupabaseEnv();
    for (const file of pending) {
        if (Date.now() >= deadline) break;
        considered++;
        try {
            if (Number(file.size) > MAX_IMAGE_BYTES) throw Object.assign(new Error(`${file.name}: файл перевищує 25 МБ`), { status: 413 });
            const media = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
            if (!media.ok) throw Object.assign(new Error(`Drive download HTTP ${media.status}`), { status: media.status });
            const bytes = Buffer.from(await media.arrayBuffer());
            if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Invalid screenshot size'), { status: 413 });
            const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[file.mimeType];
            const objectPath = `${connection.user_id}/drive/${file.id}/${sha256}.${extension}`;
            const uploaded = await fetchWithRetry(`${url}/storage/v1/object/screenshots/${objectPath}`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': file.mimeType, 'x-upsert': 'false', 'x-metadata': Buffer.from(JSON.stringify({ sha256 })).toString('base64') }, body: bytes }, { attempts: 1 });
            if (!uploaded.ok) {
                const errorBody = await uploaded.json().catch(() => ({}));
                if (uploaded.status !== 409 && errorBody.error !== 'Duplicate' && !String(errorBody.message || '').includes('already exists')) throw Object.assign(new Error(`Storage upload HTTP ${uploaded.status}`), { status: uploaded.status });
            }
            const finalized = await supabaseRest('rpc/finalize_drive_screenshot', { method: 'POST', body: JSON.stringify({
                p_connection_id: connection.id, p_epoch: state.epoch, p_storage_path: `screenshots/${objectPath}`,
                p_metadata: { source: 'drive', source_file_id: file.id, original_name: file.name, mime_type: file.mimeType, byte_size: bytes.length, sha256,
                    source_created_at: file.createdTime, source_modified_at: file.modifiedTime, pixel_width: file.imageMediaMetadata?.width, pixel_height: file.imageMediaMetadata?.height },
            }) });
            if (!finalized?.skipped) copied++;
        } catch (error) { errors.push({ fileId: file.id, message: error.message, status: error.status }); }
    }
    if (errors.length) throw Object.assign(new Error(errors.slice(0, 3).map(error => error.message).join('; ')), { status: errors.every(error => [400, 401, 403, 413, 415].includes(error.status)) ? errors[0].status : 503 });
    return { ok: true, copied, total: files.length, remaining: Math.max(0, pending.length - considered), continue: considered < pending.length,
        revision: crypto.createHash('sha256').update(JSON.stringify(files.map(file => [file.id, file.modifiedTime]))).digest('hex') };
}

export async function processSourceJobs({ maxJobs = 4, maxDurationMs = 105_000 } = {}) {
    const deadline = Date.now() + maxDurationMs;
    const results = [];
    for (let i = 0; i < maxJobs && Date.now() < deadline - 15_000; i++) {
        const claimed = await supabaseRest('rpc/claim_source_sync_job', { method: 'POST', body: '{}' });
        if (!claimed?.job) break;
        const { job, connection } = claimed;
        try {
            const result = connection.kind === 'sheets'
                ? await runGoogleSheetSync({ user_id: connection.user_id, spreadsheet_id: connection.resource_id, sheet_title: connection.scope, config: connection.config })
                : await runDriveSourceSync(connection, { deadline: deadline - 5000 });
            const acknowledged = await supabaseRest('rpc/finish_source_sync_job', { method: 'POST', body: JSON.stringify({ p_job_id: job.id, p_lease_token: job.lease_token, p_result: result }) });
            results.push({ jobId: job.id, ok: acknowledged === true, ...result });
        } catch (error) {
            await supabaseRest('rpc/finish_source_sync_job', { method: 'POST', body: JSON.stringify({ p_job_id: job.id, p_lease_token: job.lease_token, p_error: String(error.message || error), p_retryable: ![400, 401, 403, 413, 415].includes(Number(error.status)) }) });
            results.push({ jobId: job.id, ok: false, error: error.message });
        }
    }
    return results;
}
