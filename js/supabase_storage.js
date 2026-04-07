import { supabase } from './supabase.js';

const DEFAULT_SIGNED_URL_TTL = 60 * 60;

function normalizePath(input = '') {
    return decodeURIComponent(String(input || '').trim());
}

function getPathCandidates(storagePath) {
    const path = normalizePath(storagePath).replace(/^\/+/, '');
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

    return [
        { bucket: 'assets', objectPath: path },
        { bucket: 'files', objectPath: path },
    ];
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
    if (/^https?:\/\//i.test(value) && !value.includes('firebasestorage')) return value;

    const signed = await createFirstSignedUrl(getPathCandidates(value), ttl);
    return signed?.url || value;
}

export async function uploadToSupabaseStorage(storagePath, file, options = {}) {
    const candidates = getPathCandidates(storagePath);
    if (!candidates.length) throw new Error('Invalid Supabase storage path');

    let lastError = null;
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
    }

    throw lastError || new Error('Supabase storage upload failed');
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
