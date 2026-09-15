export async function fetchWithRetry(url, options = {}, { attempts = 3, timeoutMs = 25_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
            if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt + 1 >= attempts) return response;
            const delay = Number(response.headers.get('retry-after')) * 1000;
            await response.body?.cancel();
            await sleep(Number.isFinite(delay) && delay > 0 ? Math.min(delay, 15_000) : Math.min(1000 * 2 ** attempt, 8000));
        } catch (error) {
            if (options.signal?.aborted || attempt + 1 >= attempts) throw error;
            await sleep(Math.min(1000 * 2 ** attempt, 8000));
        }
    }
}

export async function collectPages(readPage) {
    const values = [];
    const seen = new Set();
    let token = '';
    do {
        const page = await readPage(token);
        if (page.incompleteSearch) throw new Error('Source returned an incomplete result; reconciliation was not applied');
        values.push(...(page.files || page.values || []));
        token = String(page.nextPageToken || '');
        if (token && seen.has(token)) throw new Error('Source returned a repeated page token');
        seen.add(token);
    } while (token);
    return values;
}
