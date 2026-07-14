export const EXACT_SHEET_HEADER_ALIASES = {
    date: ['дата'],
    symbol: ['Ticker'],
    tradeType: ['Тип сдєлки', 'trade type', 'Тип угоди'],
    profit: ['Профіт факт'],
    profitRisk: ['профіт в ризиках'],
    pv: ['PV=PV'],
    exceptions: ['Класифікація'],
    altPv: ['Alt PV'],
    traderComment: ['Коментар трейдера'],
    exit: ['Вихід з позиції'],
    teamLeadComment: ['Коментар TEAMleader'],
    paperType: ['Тип бумаги'],
    period: ['Перiод'],
    growthPct: ['Виросла.%'],
    riskUsd: ['Ризик в дол. на трейд'],
    consolidateCents: ['Консол.в цц.'],
    entryPrice: ['Цiна входу (нижня границя консолідації)'],
    qtyShares: ['Скільки шер брав'],
    qtySharesCalc: ['Розрахункова к-ть шер'],
};

const EXCEPTION_HEADER_PHRASES = ['в чому виключення', 'у чому виключення'];
const EXIT_VALUE_PHRASES = ['стоп', 'тейк', 'по часу'];

export function normalizeExactSheetHeader(value) {
    return String(value ?? '')
        .trim()
        .toLocaleLowerCase('uk-UA')
        .replace(/[\s\n\r\t]+/g, ' ')
        .trim();
}

function exactHeaderMatches(field, value) {
    const normalized = normalizeExactSheetHeader(value);
    if (!normalized) return false;
    if (field === 'exceptions' && EXCEPTION_HEADER_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
    return (EXACT_SHEET_HEADER_ALIASES[field] || [])
        .some((alias) => normalizeExactSheetHeader(alias) === normalized);
}

function findExitColumnByValues(grid, startIndex, maxCols) {
    let bestColumn = null;
    let bestScore = 0;
    for (let col = 0; col < maxCols; col += 1) {
        let score = 0;
        for (let row = startIndex; row < grid.length; row += 1) {
            const value = normalizeExactSheetHeader(grid[row]?.[col]);
            if (value && EXIT_VALUE_PHRASES.some((phrase) => value.includes(phrase))) score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            bestColumn = col;
        }
    }
    return bestScore > 0 ? bestColumn : null;
}

export function detectExactSheetAutoMapping(grid = [], options = {}) {
    const rows = Array.isArray(grid) ? grid : [];
    const headerScanRows = Math.max(1, Number(options.headerScanRows) || 20);
    const maxCols = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0), 0);
    const mapped = {};
    const headerRows = {};
    const headers = Array(maxCols).fill('');

    for (let row = 0; row < Math.min(headerScanRows, rows.length); row += 1) {
        for (let col = 0; col < maxCols; col += 1) {
            const value = rows[row]?.[col];
            if (value == null || !String(value).trim()) continue;
            for (const field of Object.keys(EXACT_SHEET_HEADER_ALIASES)) {
                if (mapped[field] != null || !exactHeaderMatches(field, value)) continue;
                mapped[field] = col;
                headerRows[field] = row;
                if (!headers[col]) headers[col] = String(value).trim();
            }
        }
    }

    if (mapped.symbol == null) {
        return { ok: false, reason: 'ticker-header-not-found', mapped: {}, headers: [], startRow: null };
    }

    let tickerRow = null;
    for (let row = headerRows.symbol + 1; row < rows.length; row += 1) {
        if (/^[A-Za-z]/.test(String(rows[row]?.[mapped.symbol] ?? '').trim())) {
            tickerRow = row;
            break;
        }
    }
    if (tickerRow == null) {
        return { ok: false, reason: 'ticker-data-not-found', mapped: {}, headers: [], startRow: null };
    }

    if (mapped.exit == null) {
        const exitColumn = findExitColumnByValues(rows, tickerRow, maxCols);
        if (exitColumn != null) mapped.exit = exitColumn;
    }

    return { ok: true, mapped, headerRows, headers, startRow: tickerRow + 1 };
}
