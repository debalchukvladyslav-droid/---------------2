// File bytes stay on the device until Storage AND the registry acknowledge them.
export const UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function rebaseUploadEpoch(job, epoch, persist) {
    if (!Number.isSafeInteger(Number(epoch)) || Number(epoch) < 1) throw new Error('Некоректна версія журналу.');
    if (String(job.epoch) === String(epoch)) return job;
    const rebased = { ...job, epoch, needsAttention: false, lastError: null, retryAt: 0 };
    await persist(rebased);
    return rebased;
}

export function createUploadStore(indexedDB = globalThis.indexedDB, name = 'strum-upload-data') {
    let connection;
    async function open() {
        if (!indexedDB) throw new Error('Браузер не підтримує надійне збереження файлів.');
        if (!connection) connection = new Promise((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: 'id' });
            request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = null; }; resolve(request.result); };
            request.onerror = () => { connection = null; reject(request.error); };
        });
        return connection;
    }
    async function run(mode, action) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('uploads', mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('Не вдалося зберегти файл на пристрої.'));
            try {
                const request = action(tx.objectStore('uploads'));
                if (request) request.onsuccess = () => { result = request.result; };
            } catch (error) { tx.abort(); reject(error); }
        });
    }
    return {
        put: row => run('readwrite', store => store.put(row)),
        get: id => run('readonly', store => store.get(id)),
        remove: id => run('readwrite', store => store.delete(id)),
        async list(userId) { return (await run('readonly', store => store.getAll())).filter(row => row.userId === userId); },
    };
}

function uploadError(response) {
    const error = new Error(`Завантаження: HTTP ${response.status}`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return error;
}

function encodeMetadata(value) {
    const bytes = new TextEncoder().encode(String(value));
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}

function safeSessionUrl(value, endpoint) {
    const session = new URL(value, endpoint);
    const base = new URL(endpoint);
    if (session.origin !== base.origin || !session.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) {
        throw new Error('Неприпустима адреса продовження завантаження.');
    }
    return session.href;
}

// TUS offset is read from the server; a lost PATCH response never repeats bytes.
export async function resumeUpload(job, { endpoint, getHeaders, persist, fetchImpl = fetch, onProgress = () => {} }) {
    let sessionUrl = job.sessionUrl;
    let offset = 0;
    if (sessionUrl) {
        sessionUrl = safeSessionUrl(sessionUrl, endpoint);
        const head = await fetchImpl(sessionUrl, { method: 'HEAD', headers: { ...(await getHeaders()), 'Tus-Resumable': '1.0.0' }, signal: AbortSignal.timeout(30000) });
        if (head.status === 404 || head.status === 410) sessionUrl = null;
        else {
            if (!head.ok) throw uploadError(head);
            offset = Number(head.headers.get('Upload-Offset'));
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.blob.size) throw new Error('Некоректний стан завантаження.');
        }
    }
    if (!sessionUrl) {
        const metadata = { bucketName: job.bucket, objectName: job.objectPath, contentType: job.contentType, cacheControl: '31536000', metadata: JSON.stringify({ sha256: job.sha256, uploadId: job.id }) };
        const created = await fetchImpl(endpoint, {
            method: 'POST', signal: AbortSignal.timeout(30000),
            headers: { ...(await getHeaders()), 'Tus-Resumable': '1.0.0', 'Upload-Length': String(job.blob.size), 'Upload-Metadata': Object.entries(metadata).map(([key, value]) => `${key} ${encodeMetadata(value)}`).join(',') },
        });
        if (!created.ok) throw uploadError(created);
        if (!created.headers.get('Location')) throw new Error('Сервер не повернув адресу завантаження.');
        sessionUrl = safeSessionUrl(created.headers.get('Location'), endpoint);
        await persist({ ...job, sessionUrl, offset: 0, status: 'uploading' });
    }
    while (offset < job.blob.size) {
        const chunk = job.blob.slice(offset, offset + UPLOAD_CHUNK_BYTES);
        const response = await fetchImpl(sessionUrl, {
            method: 'PATCH', signal: AbortSignal.timeout(60000), body: chunk,
            headers: { ...(await getHeaders()), 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
        });
        if (!response.ok) throw uploadError(response);
        const acknowledged = Number(response.headers.get('Upload-Offset'));
        if (acknowledged !== offset + chunk.size) throw new Error('Сервер не підтвердив усі байти файлу.');
        offset = acknowledged;
        await persist({ ...job, sessionUrl, offset, status: 'uploading' });
        onProgress(offset, job.blob.size);
    }
    const uploaded = { ...job, sessionUrl, offset, status: 'uploaded' };
    await persist(uploaded);
    return uploaded;
}

export async function hashUpload(blob) {
    if (!blob?.size || blob.size > MAX_UPLOAD_BYTES) throw new Error('Файл порожній або перевищує 25 МБ.');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}
