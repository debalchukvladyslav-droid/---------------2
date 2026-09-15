import { supabase } from './supabase.js';
import { buildScreenshotPathVariants } from './storage_paths.js';
import { uploadDurably } from './durable_uploads.js';

const DEFAULT_SIGNED_URL_TTL = 60 * 60;
const AVATAR_SIGNED_URL_TTL = 24 * 60 * 60;
const SIGNED_URL_CACHE_SAFETY_MS = 60 * 1000;
const signedUrlCache = new Map();

function normalizePath(input = '') {
    return decodeURIComponent(String(input || '').trim());
}

function getSupabaseUrlCandidate(value) {
    if (!/^https?:\/\//i.test(value)) return null;
    try {
        const url = new URL(value);
        if (!url.hostname.includes('.supabase.co')) return null;
        const match = url.pathname.match(/(?:\/storage\/v1)?\/object\/(?:(?:sign|public|authenticated)\/)?([^/]+)\/(.+)$/);
        if (!match) return null;
        return {
            bucket: decodeURIComponent(match[1]),
            objectPath: decodeURIComponent(match[2])
        };
    } catch (_) {
        return null;
    }
}

function getPathCandidates(storagePath) {
    const value = normalizePath(storagePath);
    const urlCandidate = getSupabaseUrlCandidate(value);
    if (urlCandidate) return [urlCandidate];

    const path = value.replace(/^\/+/, '');
    if (!path) return [];
    const isBareImageName = !path.includes('/')
        && /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(path);

    if (path.startsWith('screenshots/')) {
        return [
            { bucket: 'screenshots', objectPath: path.replace(/^screenshots\//, '') },
            { bucket: 'assets', objectPath: path },
            { bucket: 'files', objectPath: path },
        ];
    }

    if (path.startsWith('backgrounds/')) {
        return [
            { bucket: 'backgrounds', objectPath: path.replace(/^backgrounds\//, '') },
            { bucket: 'assets', objectPath: path },
            { bucket: 'files', objectPath: path },
        ];
    }

    if (path.startsWith('trade-charts/')) return [{ bucket: 'trade-charts', objectPath: path.slice(13) }];

    if (path.startsWith('avatars/')) {
        return [
            { bucket: 'avatars', objectPath: path.replace(/^avatars\//, '') },
        ];
    }

    if (isBareImageName) {
        const screenshotCandidates = buildScreenshotPathVariants(path)
            .map(candidatePath => ({
                bucket: 'screenshots',
                objectPath: candidatePath.replace(/^screenshots\//, ''),
            }));
        return [
            ...screenshotCandidates,
            { bucket: 'assets', objectPath: path },
            { bucket: 'files', objectPath: path },
        ];
    }

    return [
        { bucket: 'assets', objectPath: path },
        { bucket: 'files', objectPath: path },
    ];
}

function applyCandidateOptions(candidates, options = {}) {
    let filtered = candidates;
    if (options.bucket) {
        filtered = filtered.filter(candidate => candidate.bucket === options.bucket);
    }
    if (options.primaryOnly) {
        filtered = filtered.slice(0, 1);
    }
    return filtered;
}

function storageErrorMessage(error, candidate) {
    const detail = error?.message || error?.error_description || error?.name || 'unknown error';
    const status = error?.statusCode || error?.status || '';
    const where = candidate ? `${candidate.bucket}/${candidate.objectPath}` : 'unknown path';
    return `Supabase storage upload failed (${where}${status ? `, ${status}` : ''}): ${detail}`;
}

function shouldFallbackToServerUpload(error) {
    const status = String(error?.statusCode || error?.status || '');
    const message = String(error?.message || error?.error_description || '');
    return status === '403'
        || message.includes('row-level security')
        || message.includes('violates row-level security');
}

async function uploadViaServer(candidate, file, options = {}) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const token = data?.session?.access_token || '';
    if (!token) throw new Error('Supabase session expired. Sign in again before uploading files.');

    const query = new URLSearchParams({
        bucket: candidate.bucket,
        objectPath: candidate.objectPath,
    });
    const response = await fetch(`/api/storage-upload?${query.toString()}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': options.contentType || file?.type || 'application/octet-stream',
        },
        body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `Server storage upload failed (${response.status})`);
    }
    return payload.signedUrl || '';
}

async function createSignedUrlViaServer(candidate, ttl = DEFAULT_SIGNED_URL_TTL) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const token = data?.session?.access_token || '';
    if (!token) return '';

    const query = new URLSearchParams({
        bucket: candidate.bucket,
        objectPath: candidate.objectPath,
        expiresIn: String(ttl),
    });
    const response = await fetch(`/api/storage-upload?${query.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) return '';
    return payload.signedUrl || '';
}

async function createFirstSignedUrl(candidates, ttl = DEFAULT_SIGNED_URL_TTL) {
    for (const candidate of candidates) {
        const cacheKey = `${candidate.bucket}/${candidate.objectPath}`;
        const cached = signedUrlCache.get(cacheKey);
        if (cached?.url && cached.expiresAt > Date.now() + SIGNED_URL_CACHE_SAFETY_MS) {
            return { ...candidate, url: cached.url };
        }

        if (candidate.bucket === 'avatars') {
            const serverSignedUrl = await createSignedUrlViaServer(candidate, ttl);
            if (serverSignedUrl) {
                signedUrlCache.set(cacheKey, {
                    url: serverSignedUrl,
                    expiresAt: Date.now() + ttl * 1000,
                });
                return { ...candidate, url: serverSignedUrl };
            }
        }

        const { data, error } = await supabase.storage
            .from(candidate.bucket)
            .createSignedUrl(candidate.objectPath, ttl);

        if (!error && data?.signedUrl) {
            signedUrlCache.set(cacheKey, {
                url: data.signedUrl,
                expiresAt: Date.now() + ttl * 1000,
            });
            return { ...candidate, url: data.signedUrl };
        }

        const serverSignedUrl = await createSignedUrlViaServer(candidate, ttl);
        if (serverSignedUrl) {
            signedUrlCache.set(cacheKey, {
                url: serverSignedUrl,
                expiresAt: Date.now() + ttl * 1000,
            });
            return { ...candidate, url: serverSignedUrl };
        }
    }

    return null;
}

export async function ensureSupabaseStorageUser() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const user = data.session?.user;
    if (!user?.id) {
        throw new Error('Supabase session expired. Sign in again before uploading files.');
    }
    return user;
}

export async function getSupabaseStorageUrl(pathOrUrl, ttl = DEFAULT_SIGNED_URL_TTL) {
    const value = normalizePath(pathOrUrl);
    if (!value) return '';
    const supabaseUrlCandidate = getSupabaseUrlCandidate(value);
    if (/^https?:\/\//i.test(value) && !value.includes('firebasestorage') && !supabaseUrlCandidate) return value;

    const candidates = getPathCandidates(value);
    const effectiveTtl = candidates.some((candidate) => candidate.bucket === 'avatars')
        ? Math.max(ttl, AVATAR_SIGNED_URL_TTL)
        : ttl;
    const signed = await createFirstSignedUrl(candidates, effectiveTtl);
    if (signed?.url) return signed.url;
    const normalizedPath = value.replace(/^\/+/, '');
    if (supabaseUrlCandidate
        || normalizedPath.startsWith('screenshots/')
        || normalizedPath.startsWith('backgrounds/')
        || normalizedPath.startsWith('avatars/')) {
        return '';
    }
    return value;
}

export async function uploadToSupabaseStorage(storagePath, file, options = {}) {
    const candidates = applyCandidateOptions(getPathCandidates(storagePath), options);
    if (!candidates.length) throw new Error('Invalid Supabase storage path');
    const candidate = candidates[0];
    await uploadDurably(candidate, file, { path: storagePath, metadata: options.metadata || {}, epoch: options.epoch });
    const signed = await createFirstSignedUrl([candidate], options.ttl || DEFAULT_SIGNED_URL_TTL);
    return signed?.url || storagePath;
}

export async function deleteFromSupabaseStorage(storagePathOrUrl) {
    const candidate = getPathCandidates(normalizePath(storagePathOrUrl))[0];
    if (!candidate) throw new Error('Invalid Supabase storage path');
    if (candidate.bucket === 'screenshots') {
        const { error } = await supabase.rpc('soft_delete_screenshot', { p_storage_path: 'screenshots/' + candidate.objectPath });
        if (error) throw error;
    }
    // Only retention maintenance may remove file bytes after a verified independent backup.
    signedUrlCache.delete(candidate.bucket + '/' + candidate.objectPath);
}

supabase.auth.onAuthStateChange(() => signedUrlCache.clear());
