export async function fetchExcelDownload(token, fetchImpl = fetch) {
    const response = await fetchImpl('/api/export', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Export HTTP ${response.status}`);
    }
    if ((response.headers.get('content-type') || '').includes('application/json')) {
        const payload = await response.json();
        if (!payload.ok || !payload.downloadUrl) throw new Error('Сервер не повернув посилання на Excel.');
        const url = new URL(payload.downloadUrl);
        if (url.protocol !== 'https:') throw new Error('Некоректне посилання на Excel.');
        // Signed URLs authorize the download; never forward the user's JWT.
        const file = await fetchImpl(url.href, { signal: AbortSignal.timeout(60000) });
        if (!file.ok) throw new Error(`Excel download HTTP ${file.status}`);
        return { blob: await file.blob(), filename: payload.filename || 'STRUM-trading-journal.xlsx' };
    }
    return { blob: await response.blob(), filename: (response.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/i)?.[1] || 'STRUM-trading-journal.xlsx' };
}
