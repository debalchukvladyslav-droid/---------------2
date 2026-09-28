export function normalizeStopExitReason(value) {
    return String(value ?? '').trim().toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ');
}

export function isStopExitReason(value) {
    return normalizeStopExitReason(value) === 'стоп';
}

function symbolOf(value) {
    return String(value || '').trim().toUpperCase();
}

export function googleDriveFileId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        const queryId = url.searchParams.get('id');
        if (queryId) return queryId;
        return url.pathname.match(/\/(?:file\/)?d\/([a-zA-Z0-9_-]+)/)?.[1] || '';
    } catch (_) {
        return '';
    }
}

function linkedScreenshotPaths(url, paths, screenMeta = {}) {
    const driveId = googleDriveFileId(url);
    if (!driveId) return [];
    return paths.filter(path => String(screenMeta?.[path]?.driveId || '') === driveId);
}

function registryDate(row) {
    return String(row?.source_created_at || row?.captured_at || '').slice(0, 10);
}

function screenshotLookup(appData = {}) {
    const byDriveId = new Map();
    const byTickerDate = new Map();
    const remember = (driveId, path, symbol = '', date = '') => {
        const fileId = String(driveId || '');
        const storagePath = String(path || '');
        if (fileId && storagePath && !byDriveId.has(fileId)) byDriveId.set(fileId, storagePath);
        const ticker = symbolOf(symbol);
        if (ticker && date && storagePath) {
            const key = `${ticker}|${date}`;
            const paths = byTickerDate.get(key) || [];
            if (!paths.includes(storagePath)) paths.push(storagePath);
            byTickerDate.set(key, paths);
        }
    };
    Object.entries(appData.screenMeta || {}).forEach(([path, meta]) => {
        remember(meta?.driveId, path, meta?.ticker, String(meta?.driveCreatedTime || meta?.capturedAt || '').slice(0, 10));
    });
    (Array.isArray(appData.screenshotRegistry) ? appData.screenshotRegistry : []).forEach(row => {
        remember(row?.source_file_id, row?.storage_path, row?.ticker, registryDate(row));
    });
    return { byDriveId, byTickerDate };
}

function currentSheetSource(sheetStore = {}) {
    const sourceIds = Object.keys(sheetStore).filter(id => {
        const byDay = sheetStore[id];
        return byDay && typeof byDay === 'object'
            && Object.values(byDay).some(rows => Array.isArray(rows) && rows.length);
    });
    const spreadsheetId = sourceIds[sourceIds.length - 1] || '';
    return spreadsheetId ? { id: spreadsheetId, byDay: sheetStore[spreadsheetId] } : null;
}

function cumulativeSheetSources(sheetStore = {}) {
    return Object.entries(sheetStore).filter(([, byDay]) => byDay && typeof byDay === 'object')
        .map(([id, byDay]) => ({ id, byDay }));
}

function screenshotMatchesSymbol(path, symbol, appData = {}) {
    if (symbolOf(appData?.tickers?.[path]) === symbol) return true;
    const tags = Array.isArray(appData?.screenTags?.[path]) ? appData.screenTags[path] : [];
    if (tags.some((tag) => symbolOf(tag) === symbol)) return true;
    const filename = symbolOf(String(path || '').split(/[\\/]/).pop());
    return filename.includes(symbol);
}

export function buildStopReviewCandidates(appData = {}, from = '', to = '') {
    const groups = new Map();
    const journal = appData?.journal || {};
    const lookup = screenshotLookup(appData);
    const sources = [
        currentSheetSource(appData?.sheetRows || {}),
        ...cumulativeSheetSources(appData?.cumulativeSheetRows || {}),
    ].filter(Boolean);

    sources.forEach(({ id: spreadsheetId, byDay }) => {
        Object.keys(byDay).sort().forEach(date => {
            if ((from && date < from) || (to && date > to)) return;
            const day = journal[date] || {};
            const screens = day.screenshots || {};
            const allPaths = ['good', 'normal', 'bad', 'error'].flatMap(key => Array.isArray(screens[key]) ? screens[key] : []);
            const availablePaths = [...new Set([...allPaths, ...(Array.isArray(appData?.unassignedImages) ? appData.unassignedImages : [])])];
            const sheetRows = Array.isArray(byDay[date]) ? byDay[date] : [];
            sheetRows.forEach((trade, index) => {
                if (!isStopExitReason(trade?.sheet?.exit)) return;
                const symbol = symbolOf(trade?.symbol);
                if (!symbol) return;
                const key = `${date}|${symbol}`;
                const sheet = trade?.sheet || {};
                const screenshotUrl = String(sheet.screenshotUrl || '');
                const driveId = googleDriveFileId(screenshotUrl);
                const linkedPath = driveId ? lookup.byDriveId.get(driveId) : '';
                const directPaths = [
                    ...linkedScreenshotPaths(screenshotUrl, availablePaths, appData?.screenMeta || {}),
                    ...(linkedPath ? [linkedPath] : []),
                    ...(lookup.byTickerDate.get(`${symbol}|${date}`) || []),
                ];
                if (!groups.has(key)) {
                    groups.set(key, {
                        key,
                        trade_date: date,
                        symbol,
                        trade_refs: [],
                        refKeys: new Set(),
                        screenshot_paths: [...new Set([
                            ...directPaths,
                            ...allPaths.filter(path => screenshotMatchesSymbol(path, symbol, appData)),
                        ])],
                    });
                }
                const group = groups.get(key);
                directPaths.forEach(path => {
                    if (path && !group.screenshot_paths.includes(path)) group.screenshot_paths.push(path);
                });
                const sheetRow = Number.isInteger(Number(sheet.sheetRow)) ? Number(sheet.sheetRow) : index;
                const refKey = `${spreadsheetId}|${sheetRow}|${Number(trade?.net) || 0}|${String(sheet.exit || '')}`;
                if (group.refKeys.has(refKey)) return;
                group.refKeys.add(refKey);
                group.trade_refs.push({
                    sheetRow,
                    spreadsheetId: String(sheet.spreadsheetId || spreadsheetId),
                    net: Number(trade?.net) || 0,
                    type: String(trade?.type || sheet.tradeType || ''),
                    stop: trade?.stop ?? sheet.stopPrice ?? null,
                    exitReason: String(sheet.exit || ''),
                    screenshotUrl,
                });
            });
        });
    });
    return [...groups.values()]
        .map(({ refKeys, ...group }) => group)
        .sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.symbol.localeCompare(b.symbol));
}
