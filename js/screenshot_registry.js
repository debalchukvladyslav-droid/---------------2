import { supabase } from './supabase.js';

const COLUMNS = 'storage_path,source,source_file_id,original_name,mime_type,source_created_at,source_modified_at,created_at,updated_at,ticker,trade_key,screenshot_role,captured_at,pixel_width,pixel_height,byte_size,quality_status,quality_details';

export function inferRegistryRole(name = '') {
    const value = String(name).toLowerCase();
    if (/pre[-_ ]?entry|before|plan|premarket|pre-market/.test(value)) return 'pre_entry';
    if (/post[-_ ]?exit|after|result|close|closed/.test(value)) return 'post_exit';
    if (/exit|cover/.test(value)) return 'exit';
    if (/entry|open/.test(value)) return 'entry';
    return 'unknown';
}

export async function loadScreenshotRegistry(userId) {
    if (!userId) return [];
    const { data, error } = await supabase.from('screenshots').select(COLUMNS)
        .eq('user_id', userId).order('created_at', { ascending: true });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
}

export async function registerDriveScreenshot(userId, storagePath, file, mimeType = '') {
    if (!userId || !storagePath || !file?.id) return;
    const { error } = await supabase.from('screenshots').upsert({
        user_id: userId,
        storage_path: storagePath,
        source: 'drive',
        source_file_id: String(file.id),
        original_name: String(file.name || ''),
        mime_type: String(mimeType || file.mimeType || ''),
        source_created_at: file.createdTime || null,
        source_modified_at: file.modifiedTime || null,
        screenshot_role: inferRegistryRole(file.name),
        captured_at: file.createdTime || file.modifiedTime || null,
        pixel_width: Number(file.imageMediaMetadata?.width) || null,
        pixel_height: Number(file.imageMediaMetadata?.height) || null,
        byte_size: Number(file.size) || null,
        quality_status: Number(file.imageMediaMetadata?.width) && Number(file.imageMediaMetadata?.height)
            ? (Number(file.imageMediaMetadata.width) >= 320 && Number(file.imageMediaMetadata.height) >= 180 ? 'ready' : 'image_too_small')
            : 'unchecked',
        updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,storage_path' });
    if (error) throw error;
}

export function mergeScreenshotRegistry(appData, rows = []) {
    if (!appData || !Array.isArray(rows)) return 0;
    if (!Array.isArray(appData.unassignedImages)) appData.unassignedImages = [];
    if (!appData.screenMeta || typeof appData.screenMeta !== 'object') appData.screenMeta = {};
    const assigned = new Set();
    for (const day of Object.values(appData.journal || {})) {
        for (const paths of Object.values(day?.screenshots || {})) {
            if (Array.isArray(paths)) paths.forEach(path => assigned.add(path));
        }
    }
    const known = new Set([...appData.unassignedImages, ...assigned]);
    let added = 0;
    for (const row of rows) {
        const path = String(row?.storage_path || '');
        if (!path) continue;
        if (!known.has(path)) {
            appData.unassignedImages.push(path);
            known.add(path);
            added++;
        }
        if (row.source === 'drive' && row.source_file_id) {
            appData.screenMeta[path] = {
                ...(appData.screenMeta[path] || {}), source: 'drive',
                driveId: String(row.source_file_id), driveName: row.original_name || '',
                createdAt: row.source_created_at || row.created_at || new Date().toISOString(),
                driveCreatedTime: row.source_created_at || null,
                driveModifiedTime: row.source_modified_at || null,
                ticker: row.ticker || '', tradeKey: row.trade_key || '',
                screenshotRole: row.screenshot_role || 'unknown', capturedAt: row.captured_at || null,
                width: row.pixel_width || null, height: row.pixel_height || null,
                byteSize: row.byte_size || null, qualityStatus: row.quality_status || 'unchecked',
            };
        }
    }
    return added;
}
