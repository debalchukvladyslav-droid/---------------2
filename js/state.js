// === js/state.js ===

export const state = {
    systemConfig: {},

    // Авторизація та доступи
    USER_DOC_NAME: "",
    CURRENT_VIEWED_USER: "",
    currentViewedUserId: null,  // UUID профілю що зараз переглядається
    myUserId: null,             // UUID авторизованого юзера (незмінний)
    isRegisterMode: false,
    IS_MENTOR_MODE: false,
    /** Роль з profiles: trader | mentor | admin */
    myRole: 'trader',
    /** email | telegram — джерело основного входу (див. profiles.settings.auth_provider). */
    authProvider: 'email',
    
    // Команди (Кущі)
    TEAM_GROUPS: {}, 
    
    // Головні дані щоденника
    appData: { 
        journal: {}, 
        errorTypes: ["Взяв дві позиції в одному місці", "Фомо", "Тільт"], 
        weeklyComments: {}, 
        settings: {
            screenshot_folder: "", 
            gemini_key: "",
            gemini_keys: [],
            theme: "dark", 
            font: "inter", 
            customTheme: null, 
            checklist: [], 
            sliders: [], 
            playbookSituations: [],
            ocrPos: 'left', 
            ocrRect: {top: 0, left: 0, width: 250, height: 80}, 
            defaultDayloss: -100,
            monthlyDayloss: {},
            glassEnabled: true
        }, 
        tickers: {},
        unassignedImages: [],
        backgrounds: [],
        activeBackground: null
    },

    // Дані для UI та Чарту
    todayObj: new Date(),
    selectedDateStr: "", // Ініціалізуємо пізніше
    pnlChartInstance: null,
    daysChartInstance: null,
    winLossChartInstance: null,
    comparePnlChartInstance: null,
    compareDaysChartInstance: null,
    compareWinLossChartInstance: null,
    mistakeChartInstance: null,
    
    // OCR
    ocrScale: 1.0, 
    ocrTranslateX: 0, 
    ocrTranslateY: 0, 
    ocrMinScale: 0.1,
    isDrawingOCR: false, 
    ocrStartX: 0, 
    ocrStartY: 0, 
    pendingOCRRect: null,
    currentZoomedSrc: '',

    // Скріншоти
    currentUnassignedImages: [],
    unassignedVisibleCount: 5,

    // Статистика та Фільтри
    activeFilters: [],
    statsDocCache: {},
    loadedMonths: {}, // { 'nick_stats': Set(['2026-03', '2026-04']) }
    statsSourceSelection: { type: 'current', key: '' },
    currentStatsContext: { journal: {}, label: 'Мій профіль' },
    statsLoadRequestId: 0,
    activeStatsDropdown: null,
    activeTradeTypeFilter: null,
    statsEquityAdvancedMode: false,
    statsCompareMode: false,
    statsCompareScale: 'year',
    statsCompareA: '',
    statsCompareB: '',
    statsComparePeriodKey: '',
    statsCompareFilters: [],
    statsCompareSourceSelection: { type: 'current', key: '' },
    statsCompareTradeTypeFilter: null,
    statsCompareContext: { journal: {}, label: 'Мій профіль', tradeTypes: [] },
    statsCompareEquityAdvancedMode: false,
    autoFlagsCache: { records: new Set(), absoluteRecord: null }
};

// Задаємо сьогоднішню дату при старті
state.selectedDateStr = `${state.todayObj.getFullYear()}-${String(state.todayObj.getMonth()+1).padStart(2,'0')}-${String(state.todayObj.getDate()).padStart(2,'0')}`;

// Константи
export const SCREEN_CATS = [
    { id: 'good', name: '✅ Хороший трейд', color: 'var(--profit)' },
    { id: 'normal', name: '🟡 Норм трейд', color: '#eab308' },
    { id: 'bad', name: '🟠 Поганий трейд', color: '#f97316' },
    { id: 'error', name: '❌ Помилка', color: 'var(--loss)' }
];
