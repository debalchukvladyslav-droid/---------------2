export function normalizeStopExitReason(value) {
    return String(value ?? '').trim().toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ');
}

export function isStopExitReason(value) {
    return normalizeStopExitReason(value) === 'стоп';
}

function symbolOf(value) {
    return String(value || '').trim().toUpperCase();
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
        const sheetRows = Array.isArray(rowsByDay[date]) ? rowsByDay[date] : [];
        sheetRows.forEach((trade, index) => {
            if (!isStopExitReason(trade?.sheet?.exit)) return;
            const symbol = symbolOf(trade?.symbol);
            if (!symbol) return;
            const key = `${date}|${symbol}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    key,
                    trade_date: date,
                    symbol,
                    trade_refs: [],
                    screenshot_paths: [...new Set(allPaths.filter(path => symbolOf(appData?.tickers?.[path]) === symbol))],
                });
            }
            const sheet = trade?.sheet || {};
            groups.get(key).trade_refs.push({
                sheetRow: Number.isInteger(Number(sheet.sheetRow)) ? Number(sheet.sheetRow) : index,
                spreadsheetId: String(sheet.spreadsheetId || spreadsheetId),
                net: Number(trade?.net) || 0,
                type: String(trade?.type || sheet.tradeType || ''),
                stop: trade?.stop ?? sheet.stopPrice ?? null,
                exitReason: String(sheet.exit || ''),
            });
        });
    });
    return [...groups.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.symbol.localeCompare(b.symbol));
}
