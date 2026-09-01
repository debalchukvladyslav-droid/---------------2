// === js/data_utils.js ===
import { parseDecimalInput } from './utils.js';

export function getDefaultSettings() {
    return {
        screenshot_folder: "",
        gemini_key: "",
        gemini_keys: [],
        theme: "dark",
        font: "inter",
        customTheme: {
            bgMain: '#0f172a', bgPanel: '#1e293b', textMain: '#f8fafc', 
            accent: '#3b82f6', profit: '#10b981', loss: '#ef4444',
            gradient: false, gradientColor: '#7c3aed'
        },
        checklist: [],
        sliders: [],
        ocrPos: 'left',
        ocrRect: { top: 0, left: 0, width: 250, height: 80 },
        defaultDayloss: -1000,
        monthlyDayloss: {},
        cumulativeMonthlyDayloss: {},
        cumulativeIncludeDemo: true,
        fondexxMonthlyAdjustments: {},
        sheetTradeTypesSyncEnabled: false,
        dashboardLayout: null
    };
}

export function getDefaultDayEntry() {
    return {
        pnl: null, gross_pnl: null, commissions: null, locates: null, kf: null,
        notes: '', errors: [],
        nextSessionImprovement: '', sessionReviewDone: false, sessionReviewCompletedAt: '',
        sessionStartRecorded: false, sessionEndRecorded: false,
        screenshots: { good: [], normal: [], bad: [], error: [] },
        checkedParams: [], sliders: {}, ai_advice: "", traded_tickers: [],
        fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        fondexxSource: '',
        pproSource: '',
        traderAbsent: false,
        demoTrading: false,
        trades: [],
        tradeTypesData: {},
        review_requests: {},
    };
}

export const DEFAULT_TRADE_TYPES = ['Синя', 'Зелена', 'Фіолетова', 'Візуально'];

export function getDefaultAppData() {
    return {
        journal: {},
        errorTypes: ["Взяв дві позиції в одному місці", "Фомо", "Тільт"],
        weeklyComments: {},
        settings: getDefaultSettings(),
        tickers: {},
        screenMeta: {},
        unassignedImages: [],
        sheetRows: {},
        cumulativeSheetRows: {},
        tradeTypes: [...DEFAULT_TRADE_TYPES]
    };
}
export function sanitizeStringArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function sanitizeNumberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    return parseDecimalInput(value);
}

export function resolveMonthlyDayloss(settings = {}, monthKey = '', fallback = -1000) {
    const monthly = settings?.monthlyDayloss && typeof settings.monthlyDayloss === 'object' ? settings.monthlyDayloss : {};
    const exact = Number(monthly[monthKey]);
    if (Number.isFinite(exact) && exact !== 0) return exact;
    const previousKey = Object.keys(monthly)
        .filter((key) => /^\d{4}-\d{2}$/.test(key) && key < monthKey && Number.isFinite(Number(monthly[key])) && Number(monthly[key]) !== 0)
        .sort((a, b) => b.localeCompare(a))[0];
    if (previousKey) return Number(monthly[previousKey]);
    const defaultValue = Number(settings?.defaultDayloss);
    return Number.isFinite(defaultValue) && defaultValue !== 0 ? defaultValue : fallback;
}

export function getTradeResult(trade) {
    const hasNet = trade?.net !== '' && trade?.net !== null && trade?.net !== undefined;
    const net = hasNet ? Number(trade.net) : NaN;
    if (Number.isFinite(net)) return net;
    const grossRaw = trade?.gross ?? trade?.grossPnl;
    const gross = grossRaw === '' || grossRaw === null || grossRaw === undefined ? NaN : Number(grossRaw);
    return Number.isFinite(gross) ? gross : null;
}

export function normalizeTradeResult(trade) {
    if (!trade || typeof trade !== 'object') return trade;
    const hasNet = trade.net !== '' && trade.net !== null && trade.net !== undefined && Number.isFinite(Number(trade.net));
    if (hasNet) return trade;
    const result = getTradeResult(trade);
    return result === null ? trade : { ...trade, net: result };
}

export function normalizeTradeSource(source) {
    const safeSource = source && typeof source === 'object' ? source : {};
    return {
        gross: Number(safeSource.gross) || 0,
        net: Number(safeSource.net) || 0,
        comm: Number(safeSource.comm) || 0,
        locates: Number(safeSource.locates) || 0,
        tickers: sanitizeStringArray(safeSource.tickers)
    };
}

function normalizeTradeTypeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/i/g, 'і')
        .replace(/[^a-zа-яіїєґ0-9]+/gi, '');
}

export function classifyTradeTypeGroup(trade) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const rawType = sheet.tradeType || trade?.type || sheet.fondexxType || '';
    const key = normalizeTradeTypeText(rawType);
    if (!key) return null;

    if (['синя', 'рпсиня'].includes(key)) return 'Синя';
    if (['зелена', 'рпзелена'].includes(key)) return 'Зелена';
    if (['фіолетова', 'рпфіолетова'].includes(key)) return 'Фіолетова';
    if (['візуально', 'рпвізуально'].includes(key)) return 'Візуально';
    return null;
}

export function isNotTakenTrade(trade) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const fields = [
        trade?.type,
        trade?.tradeType,
        trade?.setupType,
        trade?.note,
        trade?.notes,
        sheet.tradeType,
        sheet.fondexxType,
        sheet.exception,
        sheet.exceptions,
        sheet.pv,
    ];
    const text = fields
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .map((value) => String(value || '').toLowerCase())
        .join(' ');

    if (!text.trim()) return false;
    return /\bdo\s*not\s*take\b|\bnot\s*taken\b|\bno\s*trade\b|\bskip(?:ped)?\b/i.test(text)
        || /не\s*брав|не\s*взяв|пропустив|пропущен|без\s*входу/i.test(text);
}

function parseTradeKf(value) {
    if (value === null || value === undefined || value === '') return null;
    const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value) {
    return Number.parseFloat((Number(value) || 0).toFixed(2));
}

// Sum only explicit per-trade R multiples. PnL is never used to guess KФ.
export function deriveDayKfFromTrades(trades = []) {
    if (!Array.isArray(trades)) return null;
    const seen = new Set();
    let total = 0;
    let count = 0;
    trades.forEach((trade, index) => {
        if (!trade || isNotTakenTrade(trade)) return;
        const sheet = trade.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
        const value = parseTradeKf(sheet.profitRisk ?? trade.profitRisk ?? trade.kf);
        if (value === null) return;
        const rowId = sheet.sheetRow ?? sheet.rowNumber ?? sheet.row;
        const sourceId = (sheet.spreadsheetId ?? sheet.sourceFileId ?? sheet.source) || '';
        const key = rowId !== null && rowId !== undefined && rowId !== ''
            ? `sheet:${sourceId}:${rowId}`
            : `trade:${trade.id ?? `${trade.symbol || ''}:${trade.opened || ''}:${index}`}`;
        if (seen.has(key)) return;
        seen.add(key);
        total += value;
        count++;
    });
    return count ? roundMetric(total) : null;
}

export function buildAutoTradeTypesData(trades = []) {
    const totals = Object.fromEntries(DEFAULT_TRADE_TYPES.map((type) => [type, { pnl: 0, kf: 0, count: 0, kfCount: 0 }]));
    let hasAny = false;

    trades.forEach((trade) => {
        if (isNotTakenTrade(trade)) return;
        const group = classifyTradeTypeGroup(trade);
        if (!group || !totals[group]) return;

        const net = getTradeResult(trade);
        if (net !== null) {
            totals[group].pnl += net;
            hasAny = true;
        }

        const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
        const kf = parseTradeKf(sheet.profitRisk ?? trade?.profitRisk ?? trade?.kf);
        if (kf !== null) {
            totals[group].kf += kf;
            totals[group].kfCount++;
            hasAny = true;
        }

        totals[group].count++;
    });

    if (!hasAny) return {};

    return Object.fromEntries(DEFAULT_TRADE_TYPES.map((type) => {
        const item = totals[type];
        return [type, {
            pnl: item.count ? roundMetric(item.pnl) : '',
            kf: item.kfCount ? roundMetric(item.kf) : '',
        }];
    }));
}

export function applyAutoTradeTypesData(dayEntry) {
    if (!dayEntry || typeof dayEntry !== 'object') return dayEntry;
    const autoData = buildAutoTradeTypesData(Array.isArray(dayEntry.trades) ? dayEntry.trades : []);
    dayEntry.tradeTypesData = {
        ...(dayEntry.tradeTypesData && typeof dayEntry.tradeTypesData === 'object' ? dayEntry.tradeTypesData : {}),
        ...autoData,
    };
    return dayEntry;
}

export function normalizeTradeTypesList(value) {
    const incoming = Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
    const retiredDefaults = new Set(['Шорт', 'Виключення', 'Виключення фіолетова']);
    const base = incoming.filter((item) => !retiredDefaults.has(item));
    return [...new Set([...DEFAULT_TRADE_TYPES, ...base])];
}

export function normalizeDayEntry(entry) {
    const defaults = getDefaultDayEntry();
    const safeEntry = entry && typeof entry === 'object' ? entry : {};
    const screenshots = safeEntry.screenshots && typeof safeEntry.screenshots === 'object' ? safeEntry.screenshots : {};

    const storedKf = sanitizeNumberOrNull(safeEntry.kf);
    const derivedKf = storedKf === null
        ? deriveDayKfFromTrades(Array.isArray(safeEntry.trades) ? safeEntry.trades : [])
        : null;

    const normalizedTrades = Array.isArray(safeEntry.trades) ? safeEntry.trades.map(normalizeTradeResult) : [];
    return applyAutoTradeTypesData({
        ...defaults,
        ...safeEntry,
        pnl: sanitizeNumberOrNull(safeEntry.pnl),
        gross_pnl: sanitizeNumberOrNull(safeEntry.gross_pnl),
        commissions: sanitizeNumberOrNull(safeEntry.commissions),
        locates: sanitizeNumberOrNull(safeEntry.locates),
        kf: storedKf ?? derivedKf,
        notes: typeof safeEntry.notes === 'string' ? safeEntry.notes : '',
        nextSessionImprovement: typeof safeEntry.nextSessionImprovement === 'string' ? safeEntry.nextSessionImprovement : '',
        sessionReviewDone: safeEntry.sessionReviewDone === true,
        sessionReviewCompletedAt: typeof safeEntry.sessionReviewCompletedAt === 'string' ? safeEntry.sessionReviewCompletedAt : '',
        sessionStartRecorded: safeEntry.sessionStartRecorded === true
            || safeEntry.sessionDone === true
            || String(safeEntry.sessionGoal || '').trim() !== ''
            || String(safeEntry.sessionPlan || '').trim() !== '',
        sessionEndRecorded: safeEntry.sessionEndRecorded === true
            || safeEntry.sessionReviewDone === true
            || String(safeEntry.sessionReviewCompletedAt || '').trim() !== '',
        errors: sanitizeStringArray(safeEntry.errors),
        screenshots: {
            good: sanitizeStringArray(screenshots.good),
            normal: sanitizeStringArray(screenshots.normal),
            bad: sanitizeStringArray(screenshots.bad),
            error: sanitizeStringArray(screenshots.error)
        },
        checkedParams: sanitizeStringArray(safeEntry.checkedParams),
        sliders: safeEntry.sliders && typeof safeEntry.sliders === 'object' ? safeEntry.sliders : {},
        ai_advice: typeof safeEntry.ai_advice === 'string' ? safeEntry.ai_advice : "",
        traded_tickers: sanitizeStringArray(safeEntry.traded_tickers),
        fondexx: normalizeTradeSource(safeEntry.fondexx),
        ppro: normalizeTradeSource(safeEntry.ppro),
        fondexxSource: typeof safeEntry.fondexxSource === 'string' ? safeEntry.fondexxSource : '',
        pproSource: typeof safeEntry.pproSource === 'string' ? safeEntry.pproSource : '',
        traderAbsent: safeEntry.traderAbsent === true,
        demoTrading: safeEntry.demoTrading === true,
        tradeTypesData:
            safeEntry.tradeTypesData && typeof safeEntry.tradeTypesData === 'object' ? { ...safeEntry.tradeTypesData } : {},
        sheetTradeTypesSyncEnabled: safeEntry.sheetTradeTypesSyncEnabled === true,
        trades: normalizedTrades,
        review_requests:
            safeEntry.review_requests && typeof safeEntry.review_requests === 'object' ? { ...safeEntry.review_requests } : {},
    });
}

export function normalizeAppData(rawData) {
    const defaults = getDefaultAppData();
    const safeData = rawData && typeof rawData === 'object' ? rawData : {};
    const settingsSource = safeData.settings && typeof safeData.settings === 'object' ? safeData.settings : {};
    const normalizedSettings = { ...getDefaultSettings(), ...settingsSource };

    const hadDefaultDayloss = Object.prototype.hasOwnProperty.call(settingsSource, 'defaultDayloss');
    if (normalizedSettings.daylossLimit !== undefined && (!hadDefaultDayloss || normalizedSettings.defaultDayloss === -100)) {
        normalizedSettings.defaultDayloss = Number(normalizedSettings.daylossLimit) || -1000;
    } else if (!hadDefaultDayloss || normalizedSettings.defaultDayloss === -100) normalizedSettings.defaultDayloss = -1000;
    delete normalizedSettings.daylossLimit;

    normalizedSettings.customTheme = { ...getDefaultSettings().customTheme, ...(normalizedSettings.customTheme || {}) };
    normalizedSettings.ocrRect = { ...getDefaultSettings().ocrRect, ...(normalizedSettings.ocrRect || {}) };
    normalizedSettings.checklist = Array.isArray(normalizedSettings.checklist) ? normalizedSettings.checklist : [];
    normalizedSettings.sliders = Array.isArray(normalizedSettings.sliders) ? normalizedSettings.sliders : [];
    normalizedSettings.gemini_keys = Array.isArray(normalizedSettings.gemini_keys) ? normalizedSettings.gemini_keys : [];
    normalizedSettings.monthlyDayloss = typeof normalizedSettings.monthlyDayloss === 'object' ? normalizedSettings.monthlyDayloss : {};
    normalizedSettings.cumulativeMonthlyDayloss =
        normalizedSettings.cumulativeMonthlyDayloss && typeof normalizedSettings.cumulativeMonthlyDayloss === 'object'
            ? normalizedSettings.cumulativeMonthlyDayloss
            : {};
    normalizedSettings.cumulativeIncludeDemo = normalizedSettings.cumulativeIncludeDemo !== false;
    normalizedSettings.fondexxMonthlyAdjustments = typeof normalizedSettings.fondexxMonthlyAdjustments === 'object' ? normalizedSettings.fondexxMonthlyAdjustments : {};
    
    if (!normalizedSettings.gemini_key && typeof normalizedSettings.openai_key === 'string') {
        normalizedSettings.gemini_key = normalizedSettings.openai_key;
    }

    const journalSource = safeData.journal && typeof safeData.journal === 'object' ? safeData.journal : {};
    const normalizedJournal = {};
    Object.keys(journalSource).forEach(dateKey => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            normalizedJournal[dateKey] = normalizeDayEntry(journalSource[dateKey]);
        }
    });

    return {
        ...defaults, ...safeData,
        journal: normalizedJournal,
        errorTypes: sanitizeStringArray(safeData.errorTypes).length ? sanitizeStringArray(safeData.errorTypes) : defaults.errorTypes,
        weeklyComments: safeData.weeklyComments && typeof safeData.weeklyComments === 'object' ? safeData.weeklyComments : {},
        settings: normalizedSettings,
        tickers: safeData.tickers && typeof safeData.tickers === 'object' ? safeData.tickers : {},
        screenMeta: safeData.screenMeta && typeof safeData.screenMeta === 'object' ? safeData.screenMeta : {},
        unassignedImages: sanitizeStringArray(safeData.unassignedImages),
        sheetRows: safeData.sheetRows && typeof safeData.sheetRows === 'object' ? safeData.sheetRows : {},
        cumulativeSheetRows: safeData.cumulativeSheetRows && typeof safeData.cumulativeSheetRows === 'object' ? safeData.cumulativeSheetRows : {},
        tradeTypes: normalizeTradeTypesList(safeData.tradeTypes)
    };
}
