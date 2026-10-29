// Service-only reservation, shared with manual uploads and workbook exports.
// A zero UUID identifies shared derived data; this is never a user's folder.
export async function reserveSharedCacheStorage(rest, path, bytes) {
    const response = await rest('rpc/reserve_storage_capacity', { method: 'POST', body: JSON.stringify({
        p_user_id: '00000000-0000-0000-0000-000000000000', p_bucket: 'polygon-cache', p_path: path, p_bytes: bytes,
    }) });
    if (!response.ok) throw new Error(`Storage capacity check ${response.status}`);
    const result = await response.json();
    if (result?.allowed !== true) throw new Error('STORAGE_BUDGET_LIMIT: cache storage is full');
}
