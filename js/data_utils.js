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
            accent: '#3b82f6', profit: '#10b981', loss: '#ef4444'
        },
        checklist: [],
        sliders: [],
        ocrPos: 'left',
        ocrRect: { top: 0, left: 0, width: 250, height: 80 },
        defaultDayloss: -100,
        monthlyDayloss: {},
        fondexxMonthlyAdjustments: {}
    };
}

export function getDefaultDayEntry() {
    return {
        pnl: null, gross_pnl: null, commissions: null, locates: null, kf: null,
        notes: '', errors: [],
        nextSessionImprovement: '', sessionReviewDone: false, sessionReviewCompletedAt: '',
        screenshots: { good: [], normal: [], bad: [], error: [] },
        checkedParams: [], sliders: {}, ai_advice: "", traded_tickers: [],
        fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        fondexxSource: '',
        pproSource: '',
        trades: [],
        tradeTypesData: {},
        review_requests: {},
    };
}

export const DEFAULT_TRADE_TYPES = ['Шорт', 'Виключення', 'Фіолетова', 'Візуально'];

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

    if (['шортнс', 'рпвиключення', 'виключення'].includes(key)) return 'Виключення';
    if (['фіолетова', 'виключенняфіолетова'].includes(key)) return 'Фіолетова';
    if (['візуально', 'виключеннявізуально', 'рпвізуально'].includes(key)) return 'Візуально';
    if (key === 'шорт') return 'Шорт';
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

export function buildAutoTradeTypesData(trades = []) {
    const totals = Object.fromEntries(DEFAULT_TRADE_TYPES.map((type) => [type, { pnl: 0, kf: 0, count: 0, kfCount: 0 }]));
    let hasAny = false;

    trades.forEach((trade) => {
        if (isNotTakenTrade(trade)) return;
        const group = classifyTradeTypeGroup(trade);
        if (!group || !totals[group]) return;

        const net = Number(trade?.net);
        if (Number.isFinite(net)) {
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
    const oldDefault = ['Шорт', 'Виключення', 'Виключення фіолетова'];
    const isOnlyOldDefault = incoming.length === oldDefault.length && oldDefault.every((item, index) => incoming[index] === item);
    const base = isOnlyOldDefault || incoming.length === 0 ? [] : incoming;
    return [...new Set([...DEFAULT_TRADE_TYPES, ...base])];
}

export function normalizeDayEntry(entry) {
    const defaults = getDefaultDayEntry();
    const safeEntry = entry && typeof entry === 'object' ? entry : {};
    const screenshots = safeEntry.screenshots && typeof safeEntry.screenshots === 'object' ? safeEntry.screenshots : {};

    return applyAutoTradeTypesData({
        ...defaults,
        ...safeEntry,
        pnl: sanitizeNumberOrNull(safeEntry.pnl),
        gross_pnl: sanitizeNumberOrNull(safeEntry.gross_pnl),
        commissions: sanitizeNumberOrNull(safeEntry.commissions),
        locates: sanitizeNumberOrNull(safeEntry.locates),
        kf: sanitizeNumberOrNull(safeEntry.kf),
        notes: typeof safeEntry.notes === 'string' ? safeEntry.notes : '',
        nextSessionImprovement: typeof safeEntry.nextSessionImprovement === 'string' ? safeEntry.nextSessionImprovement : '',
        sessionReviewDone: safeEntry.sessionReviewDone === true,
        sessionReviewCompletedAt: typeof safeEntry.sessionReviewCompletedAt === 'string' ? safeEntry.sessionReviewCompletedAt : '',
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
        tradeTypesData:
            safeEntry.tradeTypesData && typeof safeEntry.tradeTypesData === 'object' ? { ...safeEntry.tradeTypesData } : {},
        review_requests:
            safeEntry.review_requests && typeof safeEntry.review_requests === 'object' ? { ...safeEntry.review_requests } : {},
    });
}

export function normalizeAppData(rawData) {
    const defaults = getDefaultAppData();
    const safeData = rawData && typeof rawData === 'object' ? rawData : {};
    const settingsSource = safeData.settings && typeof safeData.settings === 'object' ? safeData.settings : {};
    const normalizedSettings = { ...getDefaultSettings(), ...settingsSource };

    if (normalizedSettings.daylossLimit !== undefined && normalizedSettings.defaultDayloss === -100) {
        normalizedSettings.defaultDayloss = Number(normalizedSettings.daylossLimit) || -100;
    }
    delete normalizedSettings.daylossLimit;

    normalizedSettings.customTheme = { ...getDefaultSettings().customTheme, ...(normalizedSettings.customTheme || {}) };
    normalizedSettings.ocrRect = { ...getDefaultSettings().ocrRect, ...(normalizedSettings.ocrRect || {}) };
    normalizedSettings.checklist = Array.isArray(normalizedSettings.checklist) ? normalizedSettings.checklist : [];
    normalizedSettings.sliders = Array.isArray(normalizedSettings.sliders) ? normalizedSettings.sliders : [];
    normalizedSettings.gemini_keys = Array.isArray(normalizedSettings.gemini_keys) ? normalizedSettings.gemini_keys : [];
    normalizedSettings.monthlyDayloss = typeof normalizedSettings.monthlyDayloss === 'object' ? normalizedSettings.monthlyDayloss : {};
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
