import { fetchWithRetry } from './integration_io.js';
import { getGoogleAccessToken, supabaseRest } from './google_sheet_sync.js';
import {
    SHS_ARCHIVE_ENDPOINTS,
    archiveFileName,
    archiveQuery,
    archiveSlot,
    nyClock,
    summarizeArchive,
} from './shs_day_archive.js';

const SHS_BASE = 'https://shsbot-production.up.railway.app/api/service-bots';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GAP_MS = 400;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanFolderId(value) {
    return /^[a-zA-Z0-9_-]+$/.test(String(value || '')) ? String(value) : '';
}

async function readShs(path, key) {
    const response = await fetchWithRetry(`${SHS_BASE}/${path.replace(/^\/+/, '')}`, {
        headers: { 'X-Bot-Key': key },
    }, { attempts: 2, timeoutMs: 20_000 });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text.slice(0, 500) }; }
    if (!response.ok) {
        const error = new Error(`Стрічка бота відповіла ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body;
}

export async function fetchDeskSnapshot(date, key) {
    const endpoints = {};
    for (let index = 0; index < SHS_ARCHIVE_ENDPOINTS.length; index += 1) {
        const name = SHS_ARCHIVE_ENDPOINTS[index];
        if (index) await sleep(GAP_MS);
        try {
            endpoints[name] = { ok: true, body: await readShs(archiveQuery(name, date), key) };
        } catch (error) {
            endpoints[name] = {
                ok: false,
                status: error?.status || 0,
                message: String(error?.message || error).slice(0, 300),
            };
        }
    }
    return endpoints;
}

async function driveJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.error?.message || `Google Drive HTTP ${response.status}`);
    }
    return body;
}

export async function checkArchiveDriveFolder(env = process.env) {
    const folderId = cleanFolderId(env.SHS_ARCHIVE_DRIVE_FOLDER_ID);
    if (!folderId) return { ok: false, error: 'folder-not-configured' };
    try {
        const token = await getGoogleAccessToken(DRIVE_SCOPE);
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${folderId}`);
        url.searchParams.set('fields', 'id,mimeType,trashed,capabilities');
        url.searchParams.set('supportsAllDrives', 'true');
        const folder = await driveJson(await fetchWithRetry(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
        }, { attempts: 2, timeoutMs: 20_000 }));
        if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') {
            return { ok: false, error: 'not-a-folder' };
        }
        if (!folder.capabilities?.canAddChildren) return { ok: false, error: 'no-edit-access' };
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 300) };
    }
}

export async function saveArchiveFile(folderId, name, payload) {
    const token = await getGoogleAccessToken(DRIVE_SCOPE);
    const headers = { Authorization: `Bearer ${token}` };
    const query = new URL('https://www.googleapis.com/drive/v3/files');
    query.searchParams.set('q', `name='${name}' and '${folderId}' in parents and trashed=false`);
    query.searchParams.set('fields', 'files(id,name)');
    query.searchParams.set('pageSize', '1');
    query.searchParams.set('supportsAllDrives', 'true');
    query.searchParams.set('includeItemsFromAllDrives', 'true');
    const found = await driveJson(await fetchWithRetry(query.toString(), { headers }, { attempts: 2, timeoutMs: 20_000 }));
    const existingId = found.files?.[0]?.id || '';
    const bytes = JSON.stringify(payload);
    if (existingId) {
        const update = new URL(`https://www.googleapis.com/upload/drive/v3/files/${existingId}`);
        update.searchParams.set('uploadType', 'media');
        update.searchParams.set('supportsAllDrives', 'true');
        const saved = await driveJson(await fetchWithRetry(update.toString(), {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' },
            body: bytes,
        }, { attempts: 2, timeoutMs: 30_000 }));
        return saved.id || existingId;
    }
    const boundary = `shs-${Date.now()}`;
    const create = new URL('https://www.googleapis.com/upload/drive/v3/files');
    create.searchParams.set('uploadType', 'multipart');
    create.searchParams.set('supportsAllDrives', 'true');
    const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${bytes}\r\n--${boundary}--`;
    const saved = await driveJson(await fetchWithRetry(create.toString(), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
    }, { attempts: 2, timeoutMs: 30_000 }));
    if (!saved.id) throw new Error('Google Drive не повернув id файла');
    return saved.id;
}

export async function runShsDayArchive({ now = new Date(), force = false, slot = '', env = process.env } = {}) {
    const clock = nyClock(now);
    const chosen = slot === '1200' || slot === '1550' ? slot : archiveSlot(now);
    if (!chosen && !force) return { ok: true, skipped: true, reason: 'outside-window', ny: clock };
    if (!chosen) return { ok: true, skipped: true, reason: 'slot-required', ny: clock };

    const key = String(env.SHS_SERVICE_BOT_KEY || '').trim();
    if (!key) return { ok: false, error: 'SHS_SERVICE_BOT_KEY is not configured', date: clock.date, slot: chosen };

    const endpoints = await fetchDeskSnapshot(clock.date, key);
    const summary = summarizeArchive(endpoints);
    const capturedAt = now.toISOString();
    const payload = {
        tradeDate: clock.date,
        slot: chosen,
        capturedAt,
        timeZone: 'America/New_York',
        summary,
        endpoints,
    };

    let drive = { ok: false, skipped: true };
    const folderId = cleanFolderId(env.SHS_ARCHIVE_DRIVE_FOLDER_ID);
    if (folderId) {
        try {
            const fileId = await saveArchiveFile(folderId, archiveFileName(clock.date, chosen), payload);
            drive = { ok: true, fileId, name: archiveFileName(clock.date, chosen) };
        } catch (error) {
            drive = { ok: false, error: String(error?.message || error).slice(0, 300) };
        }
    }

    await supabaseRest('shs_desk_archives?on_conflict=trade_date,slot', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
            trade_date: clock.date,
            slot: chosen,
            captured_at: capturedAt,
            summary,
            payload,
            drive_file_id: drive.fileId || null,
        }),
    });

    const tapeSaved = summary.orders?.ok || summary.locates?.ok;
    return {
        ok: tapeSaved,
        date: clock.date,
        slot: chosen,
        summary,
        drive,
        stored: true,
    };
}
