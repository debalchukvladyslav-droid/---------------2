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
