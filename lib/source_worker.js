import crypto from 'node:crypto';
import { getGoogleAccessToken, runGoogleSheetSync, supabaseRest, supabaseRestAll } from './google_sheet_sync.js';
import { collectPages, fetchWithRetry } from './integration_io.js';

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
    const revisions = new Map();
    for (const row of rows) {
        if (row.deleted_at || !row.source_modified_at) continue;
        if (!revisions.has(row.source_file_id)) revisions.set(row.source_file_id, new Set());
        revisions.get(row.source_file_id).add(Date.parse(row.source_modified_at));
    }
    return files.filter(file => {
        if (deleted.has(file.id) || !IMAGE_TYPES.has(file.mimeType)) return false;
        const modified = Date.parse(file.modifiedTime);
        return !Number.isFinite(modified) || !revisions.get(file.id)?.has(modified);
    });
}

export async function runDriveSourceSync(connection, { deadline = Date.now() + 90_000,
    getToken = getGoogleAccessToken, driveJson = googleDriveJson, rest = supabaseRest, restAll = supabaseRestAll } = {}) {
    const token = await getToken('https://www.googleapis.com/auth/drive.readonly');
    const files = await collectPages(pageToken => driveJson('files', token, {
        q: `'${connection.resource_id}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,createdTime,modifiedTime,imageMediaMetadata(width,height))',
        pageSize: '1000', pageToken, orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    }));
    const state = await rest('rpc/get_source_sync_state', { method: 'POST', body: JSON.stringify({ p_user_id: connection.user_id }) });
    const inventory = files.map(file => [file.id,file.modifiedTime,file.name,file.mimeType,file.size,file.imageMediaMetadata?.width,file.imageMediaMetadata?.height])
        .sort((a,b) => a[0]<b[0] ? -1 : a[0]>b[0] ? 1 : 0);
    const revision = 'drive-v2:' + crypto.createHash('sha256').update(JSON.stringify([state.epoch,connection.resource_id,inventory])).digest('hex');
    if (connection.last_revision === revision) return { ok: true, unchanged: true, copied: 0, total: files.length, remaining: 0, continue: false, revision };
    const rows = await restAll(`screenshots?user_id=eq.${connection.user_id}&source=eq.drive&select=source_file_id,source_modified_at,deleted_at&order=created_at.asc`);
    const pending = pendingDriveFiles(files, rows);
    const errors = [];
    let copied = 0;
    let considered = 0;
    for (const file of pending) {
        if (Date.now() >= deadline) break;
        considered++;
        try {
            const finalized = await rest('rpc/register_drive_screenshot_reference', { method: 'POST', body: JSON.stringify({
                p_connection_id: connection.id, p_epoch: state.epoch,
                p_metadata: { source: 'drive', source_file_id: file.id, original_name: file.name, mime_type: file.mimeType, byte_size: Number(file.size) || null,
                    source_created_at: file.createdTime, source_modified_at: file.modifiedTime, pixel_width: file.imageMediaMetadata?.width, pixel_height: file.imageMediaMetadata?.height },
            }) });
            if (!finalized?.skipped) copied++;
        } catch (error) { errors.push({ fileId: file.id, message: error.message, status: error.status }); }
    }
    if (errors.length) throw Object.assign(new Error(errors.slice(0, 3).map(error => error.message).join('; ')), { status: errors.every(error => [400, 401, 403, 413, 415].includes(error.status)) ? errors[0].status : 503 });
    return { ok: true, copied, total: files.length, remaining: Math.max(0, pending.length - considered), continue: considered < pending.length,
        // An incomplete pass must never be saved as a fully indexed revision.
        revision: considered < pending.length ? null : revision };
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
                ? await runGoogleSheetSync({ user_id: connection.user_id, spreadsheet_id: connection.resource_id, sheet_title: connection.scope, config: connection.config }, { previousRevision: connection.last_revision })
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
