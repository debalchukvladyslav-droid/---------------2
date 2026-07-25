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

export function buildStopReviewCandidates(appData = {}, from = '', to = '') {
    const groups = new Map();
    const journal = appData?.journal || {};
    const sheetStore = appData?.sheetRows && typeof appData.sheetRows === 'object' ? appData.sheetRows : {};
    const sourceIds = Object.keys(sheetStore).filter(id => {
        const byDay = sheetStore[id];
        return byDay && typeof byDay === 'object'
            && Object.values(byDay).some(rows => Array.isArray(rows) && rows.length);
    });
    const spreadsheetId = sourceIds[sourceIds.length - 1] || '';
    const rowsByDay = spreadsheetId ? sheetStore[spreadsheetId] : {};

    Object.keys(rowsByDay).sort().forEach(date => {
        if ((from && date < from) || (to && date > to)) return;
        const day = journal[date] || {};
        const screens = day.screenshots || {};
        const allPaths = ['good', 'normal', 'bad', 'error'].flatMap(key => Array.isArray(screens[key]) ? screens[key] : []);
        const availablePaths = [...new Set([...allPaths, ...(Array.isArray(appData?.unassignedImages) ? appData.unassignedImages : [])])];
        const sheetRows = Array.isArray(rowsByDay[date]) ? rowsByDay[date] : [];
        sheetRows.forEach((trade, index) => {
            if (!isStopExitReason(trade?.sheet?.exit)) return;
            const symbol = symbolOf(trade?.symbol);
            if (!symbol) return;
            const key = `${date}|${symbol}`;
            const directPaths = linkedScreenshotPaths(trade?.sheet?.screenshotUrl, availablePaths, appData?.screenMeta || {});
            if (!groups.has(key)) {
                groups.set(key, {
                    key,
                    trade_date: date,
                    symbol,
                    trade_refs: [],
                    screenshot_paths: [...new Set([
                        ...directPaths,
                        ...allPaths.filter(path => symbolOf(appData?.tickers?.[path]) === symbol),
                    ])],
                });
            }
            directPaths.forEach(path => {
                if (!groups.get(key).screenshot_paths.includes(path)) groups.get(key).screenshot_paths.push(path);
            });
            const sheet = trade?.sheet || {};
            groups.get(key).trade_refs.push({
                sheetRow: Number.isInteger(Number(sheet.sheetRow)) ? Number(sheet.sheetRow) : index,
                spreadsheetId: String(sheet.spreadsheetId || spreadsheetId),
                net: Number(trade?.net) || 0,
                type: String(trade?.type || sheet.tradeType || ''),
                stop: trade?.stop ?? sheet.stopPrice ?? null,
                exitReason: String(sheet.exit || ''),
                screenshotUrl: String(sheet.screenshotUrl || ''),
            });
        });
    });
    return [...groups.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.symbol.localeCompare(b.symbol));
}
