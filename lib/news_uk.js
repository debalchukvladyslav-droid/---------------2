const CHUNK_SIZE = 5;
const SEPARATOR = '\n§\n';

export function isUkrainianHeadline(value) {
    const text = String(value || '');
    const cyrillic = (text.match(/[А-Яа-яІіЇїЄєҐґ]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return cyrillic >= 8 && cyrillic >= Math.min(24, latin * 0.45);
}

export function parseGoogleTranslatePayload(data) {
    if (!Array.isArray(data?.[0])) return '';
    return data[0].map((part) => (Array.isArray(part) ? String(part[0] || '') : '')).join('');
}

export function splitTranslatedBatch(joined, count) {
    const parts = String(joined || '').split(/\n\s*§\s*\n/);
    if (parts.length !== count) return null;
    return parts.map((part) => part.replace(/\s+/g, ' ').trim());
}

function normalizeHeadline(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s"'“”'`-]+|[\s"'“”'`-]+$/g, '')
        .replace(/^ринок\s*:\s*/i, '')
        .trim()
        .slice(0, 180);
}

async function translateChunk(chunk, fetchImpl) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'en');
    url.searchParams.set('tl', 'uk');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', chunk.join(SEPARATOR));
    const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Ukrainian news translation failed (${response.status})`);
    const joined = parseGoogleTranslatePayload(await response.json());
    const parts = splitTranslatedBatch(joined, chunk.length);
    if (parts) return parts;
    if (chunk.length === 1) throw new Error('Ukrainian news translation shape mismatch');
    const singles = [];
    for (const text of chunk) singles.push((await translateChunk([text], fetchImpl))[0] || '');
    return singles;
}

export async function translateTextsToUkrainian(texts, fetchImpl = globalThis.fetch) {
    const inputs = texts.map((text) => normalizeHeadline(text).slice(0, 400));
    const output = inputs.slice();
    const groups = [];
    let current = [];
    inputs.forEach((text, index) => {
        if (!text) {
            output[index] = '';
            return;
        }
        current.push({ index, text });
        if (current.length === CHUNK_SIZE) {
            groups.push(current);
            current = [];
        }
    });
    if (current.length) groups.push(current);

    for (const group of groups) {
        const parts = await translateChunk(group.map((item) => item.text), fetchImpl);
        group.forEach((item, offset) => {
            output[item.index] = normalizeHeadline(parts[offset] || '');
        });
    }
    return output;
}

export async function fillUkrainianHeadlines(items, fetchImpl = globalThis.fetch) {
    const next = items.map((item) => ({ ...item }));
    const missing = [];
    next.forEach((item, index) => {
        if (!isUkrainianHeadline(item.titleUk)) missing.push(index);
    });
    if (!missing.length) return next;

    const translated = await translateTextsToUkrainian(
        missing.map((index) => next[index].title || ''),
        fetchImpl,
    );
    missing.forEach((index, slot) => {
        const titleUk = normalizeHeadline(translated[slot]);
        if (isUkrainianHeadline(titleUk)) next[index].titleUk = titleUk;
    });
    return next;
}
