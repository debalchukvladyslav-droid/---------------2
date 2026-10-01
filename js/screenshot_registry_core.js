export function normalizeScreenshotTimestamp(value, fallback = null) {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function screenshotPathVariants(path) {
    const value = String(path || '').trim();
    if (!value) return [];
    const withBucket = value.startsWith('screenshots/') ? value : `screenshots/${value.replace(/^\/+/, '')}`;
    const withoutBucket = withBucket.replace(/^screenshots\//, '');
    return [...new Set([value, withBucket, withoutBucket])];
}

export function driveIdFromScreenshot(path, meta = null) {
    const explicit = String(meta?.driveId || '').trim();
    if (explicit) return explicit;
    const match = String(path || '').match(/\/drive\/([A-Za-z0-9_-]+)\//);
    return match ? match[1] : '';
}

export function removeScreenshotFromAppData(appData, path) {
    if (!appData || typeof appData !== 'object') return [];
    const variants = new Set(screenshotPathVariants(path));
    if (!variants.size) return [];
    const matches = value => variants.has(String(value || ''));
    const dirtyDates = [];

    if (Array.isArray(appData.unassignedImages)) {
        appData.unassignedImages = appData.unassignedImages.filter(item => !matches(item));
    }

    Object.entries(appData.journal || {}).forEach(([date, day]) => {
        const screens = day?.screenshots;
        if (!screens || typeof screens !== 'object') return;
        let changed = false;
        Object.keys(screens).forEach(category => {
            if (!Array.isArray(screens[category])) return;
            const next = screens[category].filter(item => !matches(item));
            if (next.length !== screens[category].length) {
                screens[category] = next;
                changed = true;
            }
        });
        if (changed && /^\d{4}-\d{2}-\d{2}$/.test(date)) dirtyDates.push(date);
    });

    const driveIds = [];
    ['screenMeta', 'screenTags', 'screenDiscipline'].forEach(key => {
        const bag = appData[key];
        if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return;
        variants.forEach(variant => {
            if (key === 'screenMeta') {
                const driveId = driveIdFromScreenshot(variant, bag[variant]);
                if (driveId) driveIds.push(driveId);
            }
            delete bag[variant];
        });
    });

    if (!appData.settings || typeof appData.settings !== 'object' || Array.isArray(appData.settings)) {
        appData.settings = {};
    }
    if (!Array.isArray(appData.settings.driveDeletedIds)) appData.settings.driveDeletedIds = [];
    driveIds.forEach(id => {
        if (!appData.settings.driveDeletedIds.includes(id)) appData.settings.driveDeletedIds.push(id);
    });
    if (!Array.isArray(appData.settings.driveIgnored)) appData.settings.driveIgnored = [];
    variants.forEach(variant => {
        if (variant.includes('/') && !appData.settings.driveIgnored.includes(variant)) {
            appData.settings.driveIgnored.push(variant);
        }
    });
    return dirtyDates;
}

export function screenshotStillListed(appData, path) {
    const variants = new Set(screenshotPathVariants(path));
    if (!variants.size) return false;
    const matches = value => variants.has(String(value || ''));
    if ((appData?.unassignedImages || []).some(matches)) return true;
    return Object.values(appData?.journal || {}).some(day =>
        Object.values(day?.screenshots || {}).some(list => Array.isArray(list) && list.some(matches)));
}

export function selectRegistryBackfills(fileRecords = [], registryRows = [], ignoredPaths = []) {
    const registeredPaths = new Set(
        registryRows.map(row => String(row?.storage_path || '')).filter(Boolean),
    );
    const ignored = ignoredPaths instanceof Set ? ignoredPaths : new Set(ignoredPaths);
    return fileRecords.filter(record => {
        const path = String(record?.existingPath || '');
        return path && !registeredPaths.has(path) && !ignored.has(path);
    });
}
