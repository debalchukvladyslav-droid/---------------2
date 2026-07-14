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
export const SHEET_TRADE_TYPE_VALUES = [
    'шорт',
    'не брав',
    'виключення',
    'виключення візуально',
    'візуально',
    'виключення не брав',
    'фіолетова не брав',
    'не брав візуально',
    'фіолетова',
    'виключення-фіолетова',
    'шортНС',
    'РПвиключ',
    'РПфіолетова',
    'РПвізуально',
    'Свій підхід',
    'не брав свій підхід',
    'RV підхід',
    'виключення%',
    'не брав OLD-трейд',
    'виключення-OLD-трейд',
    'Виключення Інплей',
    'ЛП з відкриття',
    'тренд-шорт',
    'Візуально Потенціал',
    'памп-тренд',
    'Не брав памп-тренд',
    'візуально-маркет',
    'СИСТ-виключення',
    'СИСТ-виключення не брав',
    'памп-лонг',
];

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

function findTradeTypeColumnByValues(grid, startIndex, maxCols, excludedColumns = []) {
    const allowed = new Set(SHEET_TRADE_TYPE_VALUES.map(normalizeExactSheetHeader));
    const excluded = new Set(excludedColumns.filter((column) => Number.isInteger(column)));
    let bestColumn = null;
    let bestScore = 0;
    for (let col = 0; col < maxCols; col += 1) {
        if (excluded.has(col)) continue;
        let score = 0;
        for (let row = startIndex; row < grid.length; row += 1) {
            if (allowed.has(normalizeExactSheetHeader(grid[row]?.[col]))) score += 1;
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

    if (mapped.tradeType == null) {
        const tradeTypeColumn = findTradeTypeColumnByValues(rows, tickerRow, maxCols, [
            mapped.date,
            mapped.symbol,
            mapped.exceptions,
        ]);
        if (tradeTypeColumn != null) mapped.tradeType = tradeTypeColumn;
    }

    if (mapped.exit == null) {
        const exitColumn = findExitColumnByValues(rows, tickerRow, maxCols);
        if (exitColumn != null) mapped.exit = exitColumn;
    }

    return { ok: true, mapped, headerRows, headers, startRow: tickerRow + 1 };
}

function columnLetterToIndex(value) {
    const match = /^([A-Z]+)(?:\d+)?$/i.exec(String(value || '').trim());
    if (!match) return -1;
    let index = 0;
    for (const char of match[1].toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64;
    return index - 1;
}

function splitMappingValues(value) {
    return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

export function migrateLegacyClassificationMapping(config = {}, headersOverride = null) {
    const cfg = config && typeof config === 'object' ? config : {};
    const smartColumns = cfg.smartColumns && typeof cfg.smartColumns === 'object' ? cfg.smartColumns : null;
    if (!smartColumns?.tradeType) return { config: cfg, changed: false };

    const headers = Array.isArray(headersOverride) ? headersOverride : [];
    const headerGrid = Array.isArray(headers[0]) ? headers : null;
    const typeValues = splitMappingValues(smartColumns.tradeType);
    const moved = [];
    const retained = [];
    typeValues.forEach((value) => {
        const index = columnLetterToIndex(value);
        const header = index >= 0
            ? (headerGrid
                ? headerGrid.map((row) => row?.[index]).find((cell) => normalizeExactSheetHeader(cell) === normalizeExactSheetHeader('Класифікація'))
                : headers[index])
            : value;
        if (normalizeExactSheetHeader(header) === normalizeExactSheetHeader('Класифікація')) moved.push(value);
        else retained.push(value);
    });
    if (!moved.length) return { config: cfg, changed: false };

    const exceptions = [...splitMappingValues(smartColumns.exceptions), ...moved]
        .filter((value, index, all) => all.findIndex((item) => item.toUpperCase() === value.toUpperCase()) === index);
    const next = {
        ...cfg,
        version: Math.max(Number(cfg.version) || 0, 7),
        smartColumns: {
            ...smartColumns,
            tradeType: retained.join(', '),
            exceptions: exceptions.join(', '),
        },
        smartAnchors: { ...(cfg.smartAnchors || {}) },
    };

    const tradeAnchor = String(next.smartAnchors.tradeType || '').trim();
    if (tradeAnchor && moved.some((value) => columnLetterToIndex(value) === columnLetterToIndex(tradeAnchor))) {
        if (!next.smartAnchors.exceptions) next.smartAnchors.exceptions = tradeAnchor;
        delete next.smartAnchors.tradeType;
    }
    return { config: next, changed: true };
}
