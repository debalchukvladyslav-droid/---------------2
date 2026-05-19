import { supabase } from './supabase.js';

const DEFAULT_SIGNED_URL_TTL = 60 * 60;

function normalizePath(input = '') {
    return decodeURIComponent(String(input || '').trim());
}

function getSupabaseUrlCandidate(value) {
    if (!/^https?:\/\//i.test(value)) return null;
    try {
        const url = new URL(value);
        if (!url.hostname.includes('.supabase.co')) return null;
        const match = url.pathname.match(/\/storage\/v1\/object\/(?:(?:sign|public|authenticated)\/)?([^/]+)\/(.+)$/);
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

    if (path.startsWith('avatars/')) {
        return [
            { bucket: 'avatars', objectPath: path.replace(/^avatars\//, '') },
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

async function createFirstSignedUrl(candidates, ttl = DEFAULT_SIGNED_URL_TTL) {
    for (const candidate of candidates) {
        const { data, error } = await supabase.storage
            .from(candidate.bucket)
            .createSignedUrl(candidate.objectPath, ttl);

        if (!error && data?.signedUrl) {
            return { ...candidate, url: data.signedUrl };
        }
    }

    return null;
}

export async function getSupabaseStorageUrl(pathOrUrl, ttl = DEFAULT_SIGNED_URL_TTL) {
    const value = normalizePath(pathOrUrl);
    if (!value) return '';
    const supabaseUrlCandidate = getSupabaseUrlCandidate(value);
    if (/^https?:\/\//i.test(value) && !value.includes('firebasestorage') && !supabaseUrlCandidate) return value;

    const signed = await createFirstSignedUrl(getPathCandidates(value), ttl);
    if (signed?.url) return signed.url;
    if (supabaseUrlCandidate || value.replace(/^\/+/, '').startsWith('avatars/')) return '';
    return value;
}

export async function uploadToSupabaseStorage(storagePath, file, options = {}) {
    const candidates = applyCandidateOptions(getPathCandidates(storagePath), options);
    if (!candidates.length) throw new Error('Invalid Supabase storage path');

    let lastError = null;
    let lastCandidate = null;
    for (const candidate of candidates) {
        const { error } = await supabase.storage
            .from(candidate.bucket)
            .upload(candidate.objectPath, file, {
                upsert: true,
                contentType: options.contentType || file?.type || undefined,
            });

        if (!error) {
            const signed = await createFirstSignedUrl([candidate], options.ttl || DEFAULT_SIGNED_URL_TTL);
            return signed?.url || storagePath;
        }

        lastError = error;
        lastCandidate = candidate;
        console.warn('[Storage] upload failed', {
            bucket: candidate.bucket,
            objectPath: candidate.objectPath,
            statusCode: error?.statusCode || error?.status,
            message: error?.message || error?.error_description || String(error || ''),
        });
    }

    throw new Error(storageErrorMessage(lastError, lastCandidate));
}

export async function deleteFromSupabaseStorage(storagePathOrUrl) {
    const value = normalizePath(storagePathOrUrl);
    const candidates = getPathCandidates(value);
    let success = false;

    for (const candidate of candidates) {
        const { error } = await supabase.storage
            .from(candidate.bucket)
            .remove([candidate.objectPath]);

        if (!error) success = true;
    }

    if (!success && candidates.length) {
        throw new Error('Supabase storage delete failed');
    }
}
