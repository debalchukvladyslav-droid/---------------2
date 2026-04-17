// === js/data_utils.js ===

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
        monthlyDayloss: {}
    };
}

export function getDefaultDayEntry() {
    return {
        pnl: null, gross_pnl: null, commissions: null, locates: null, kf: null,
        notes: '', errors: [],
        screenshots: { good: [], normal: [], bad: [], error: [] },
        checkedParams: [], sliders: {}, ai_advice: "", traded_tickers: [],
        fondexx: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        ppro: { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
        trades: [],
        review_requests: {},
    };
}

export function getDefaultAppData() {
    return {
        journal: {},
        errorTypes: ["Взяв дві позиції в одному місці", "Фомо", "Тільт"],
        weeklyComments: {},
        settings: getDefaultSettings(),
        tickers: {},
        unassignedImages: [],
        tradeTypes: ["Шорт", "Виключення", "Виключення фіолетова"]
    };
}
export function sanitizeStringArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function sanitizeNumberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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

export function normalizeDayEntry(entry) {
    const defaults = getDefaultDayEntry();
    const safeEntry = entry && typeof entry === 'object' ? entry : {};
    const screenshots = safeEntry.screenshots && typeof safeEntry.screenshots === 'object' ? safeEntry.screenshots : {};

    return {
        ...defaults,
        ...safeEntry,
        pnl: sanitizeNumberOrNull(safeEntry.pnl),
        gross_pnl: sanitizeNumberOrNull(safeEntry.gross_pnl),
        commissions: sanitizeNumberOrNull(safeEntry.commissions),
        locates: sanitizeNumberOrNull(safeEntry.locates),
        kf: sanitizeNumberOrNull(safeEntry.kf),
        notes: typeof safeEntry.notes === 'string' ? safeEntry.notes : '',
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
        review_requests:
            safeEntry.review_requests && typeof safeEntry.review_requests === 'object' ? { ...safeEntry.review_requests } : {},
    };
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
        unassignedImages: sanitizeStringArray(safeData.unassignedImages)
    };
}