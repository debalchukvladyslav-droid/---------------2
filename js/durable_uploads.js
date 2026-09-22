import { supabase, SUPABASE_URL } from './supabase.js';
import { createUploadStore, hashUpload, resumeUpload, rebaseUploadEpoch } from './upload_queue_core.js';

const store = createUploadStore();
let initialized = false;
let retryTimer;
let drainPromise;
let fallbackTransfer = Promise.resolve();
const active = new Map();

async function currentSession(userId) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session || (userId && data.session.user.id !== userId)) {
        const failure = new Error('Завантаження очікує входу у свій обліковий запис.');
        failure.status = 401;
        throw failure;
    }
    return data.session;
}

function emit(job, status, detail = {}) {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('strum:upload-state', {
        detail: { id: job.id, userId: job.userId, path: job.path, status, ...detail },
    }));
}

async function transfer(job) {
    const session = await currentSession(job.userId);
    const state = await supabase.rpc('get_data_sync_state', { p_user_id: job.userId }).abortSignal(AbortSignal.timeout(25000));
    if (state.error) throw state.error;
    await currentSession(job.userId);
    job = await rebaseUploadEpoch(job, state.data.epoch, value => store.put(value));
    let token;
    const headers = async () => {
        const auth = await currentSession(job.userId);
        return { Authorization: `Bearer ${auth.access_token}`, ...(token ? { 'x-signature': token } : {}) };
    };
    if (job.status !== 'uploaded') {
        const query = new URLSearchParams({ action: 'sign-upload', bucket: job.bucket, objectPath: job.objectPath });
        const response = await fetch(`/api/storage-upload?${query}`, {
            method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ size: job.blob.size, contentType: job.contentType, sha256: job.sha256 }),
            signal: AbortSignal.timeout(25000),
        });
        const signed = await response.json();
        if (!response.ok) throw Object.assign(new Error(signed.error || 'Не вдалося почати завантаження.'), { status: response.status });
        token = signed.token;
        const direct = new URL(SUPABASE_URL);
        direct.hostname = direct.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co');
        job = await resumeUpload(job, {
            endpoint: `${direct.origin}/storage/v1/upload/resumable`, getHeaders: headers,
            persist: value => store.put(value), onProgress: (bytes, total) => emit(job, 'uploading', { bytes, total }),
        });
    }
    await currentSession(job.userId);
    if (job.bucket === 'screenshots') {
        const { error } = await supabase.rpc('finalize_screenshot_upload', {
            p_storage_path: job.path, p_user_id: job.userId, p_expected_epoch: job.epoch,
            p_metadata: { ...job.metadata, original_name: job.name, mime_type: job.contentType, byte_size: job.blob.size, sha256: job.sha256 },
        });
        if (error) throw error;
    }
    await store.remove(job.id);
    emit(job, 'complete');
    return job.path;
}

function scheduleDrain(delay = 5000) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { void resumePendingUploads().catch(() => {}); }, delay);
}

async function processJob(job) {
    if (active.has(job.id)) return active.get(job.id);
    const task = (async () => {
        try {
            const run = async () => { const latest = await store.get(job.id); return latest ? transfer(latest) : job.path; };
            if (globalThis.navigator?.locks) return await navigator.locks.request(`strum-uploads:${job.userId}`, run);
            const task = fallbackTransfer.catch(() => {}).then(run);
            fallbackTransfer = task;
            return await task;
        } catch (error) {
            const latest = await store.get(job.id);
            if (latest) {
                const attempts = (latest.attempts || 0) + 1;
                const needsAttention = [400, 401, 403, 409, 413, 415].includes(Number(error.status)) || error.code === 'STALE_EPOCH';
                await store.put({ ...latest, attempts, lastError: error.message, lastStatus: Number(error.status), needsAttention, retryAt: Date.now() + Math.min(300000, 2000 * 2 ** Math.min(attempts, 7)) });
                emit(job, needsAttention ? 'attention' : 'queued', { message: error.message });
                if (!needsAttention) scheduleDrain(Math.min(300000, 2000 * 2 ** Math.min(attempts, 7)));
            }
            throw error;
        } finally { active.delete(job.id); }
    })();
    active.set(job.id, task);
    return task;
}

export async function uploadDurably(candidate, blob, { path, metadata = {}, epoch } = {}) {
    const session = await currentSession();
    if (candidate.objectPath.split('/')[0] !== session.user.id) throw new Error('Файл належить іншому обліковому запису.');
    const id = `${session.user.id}:${candidate.bucket}/${candidate.objectPath}`;
    const sha256 = await hashUpload(blob);
    const previous = await store.get(id);
    if (previous && previous.sha256 !== sha256) throw new Error('Для нової версії файлу потрібна нова адреса.');
    let knownEpoch = epoch;
    if (knownEpoch == null) {
        const { getCachedSyncEpoch } = await import('./storage.js');
        knownEpoch = await getCachedSyncEpoch(session.user.id);
    }
    const job = previous || { id, userId: session.user.id, bucket: candidate.bucket, objectPath: candidate.objectPath, path, blob, sha256, contentType: blob.type, name: blob.name || candidate.objectPath.split('/').pop(), epoch: knownEpoch, metadata, status: 'queued', createdAt: Date.now() };
    await store.put(job);
    emit(job, 'queued', { bytes: 0, total: blob.size });
    initDurableUploads();
    return processJob(job);
}

export async function resumePendingUploads() {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
        const session = await currentSession();
        const jobs = (await store.list(session.user.id)).filter(job => (!job.needsAttention || [401, 409].includes(job.lastStatus)) && (!job.retryAt || job.retryAt <= Date.now()));
        // Two transfers per tab; Web Locks also coordinate matching uploads across tabs.
        for (let i = 0; i < jobs.length; i += 2) await Promise.allSettled(jobs.slice(i, i + 2).map(processJob));
    })().finally(() => { drainPromise = null; });
    return drainPromise;
}

export async function listPendingUploads() {
    const session = await currentSession();
    return (await store.list(session.user.id)).map(({ blob, ...job }) => ({ ...job, size: blob.size }));
}

export function initDurableUploads() {
    if (initialized || typeof window === 'undefined') return;
    initialized = true;
    window.addEventListener('online', () => scheduleDrain(0));
    window.addEventListener('focus', () => scheduleDrain(0));
    supabase.auth.onAuthStateChange(() => scheduleDrain(0));
    scheduleDrain(500);
}
