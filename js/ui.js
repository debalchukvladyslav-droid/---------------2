// === js/ui.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { showToast, showConfirm } from './utils.js';
import { refreshDashMiniEquityChartTheme } from './dash_mini_chart.js';

let isThemeUIInitialized = false;
let selectedDashGreetingIndex = null;

const DASH_GREETINGS = [
    { render: (name) => `Вітаю, ${name}` },
    { render: (name) => `Радий бачити, ${name}` },
    { render: (name) => `Готові до роботи, ${name}` },
    { render: (name) => `Гарного торгового дня, ${name}`, beforeHour: 14 },
    { render: (name) => `Плануємо спокійно, ${name}` },
];

const THEME_PRESETS = {
    dark: {
        background:        '#020617',
        card:              '#0f172a',
        primary:           '#00e5a0',
        primaryForeground: '#020617',
        muted:             '#1e293b',
        mutedForeground:   '#64748b',
        border:            '#1e293b',
        ring:              '#00e5a0',
        sidebarBg:         '#070a0d',
        sidebarAccentBg:   '#0f172a',
        bgColor:           '#020617',
        panelColor:        '#0f172a',
        primaryColor:      '#00e5a0',
        textPrimary:       '#e2e8f0',
        textSecondary:     '#64748b',
        bgHover:           '#1e293b',
        accentHover:       '#1ffdb5',
        profit:            '#00e5a0',
        loss:              '#ef4444',
        gold:              '#f59e0b',
        aiBg:              'rgba(0,229,160,0.05)',
        aiBorder:          'rgba(0,229,160,0.3)',
    },
    light: {
        background:        '#f3f5f9',
        card:              '#ffffff',
        primary:           '#00966a',
        primaryForeground: '#ffffff',
        muted:             '#eef2f7',
        mutedForeground:   '#64748b',
        border:            '#d1d9e6',
        ring:              '#00966a',
        sidebarBg:         '#ffffff',
        sidebarAccentBg:   '#f0fdf9',
        bgColor:           '#f3f5f9',
        panelColor:        '#ffffff',
        primaryColor:      '#00966a',
        textPrimary:       '#0f172a',
        textSecondary:     '#64748b',
        bgHover:           '#e8ecf3',
        accentHover:       '#00b87a',
        profit:            '#00966a',
        loss:              '#dc2626',
        gold:              '#d97706',
        aiBg:              'rgba(0,150,106,0.05)',
        aiBorder:          'rgba(0,150,106,0.2)',
    },
    matrix: {
        background:        '#000d00',
        card:              '#001a00',
        primary:           '#00ff41',
        primaryForeground: '#000d00',
        muted:             '#002600',
        mutedForeground:   '#008f11',
        border:            '#003300',
        ring:              '#00ff41',
        sidebarBg:         '#000d00',
        sidebarAccentBg:   '#001a00',
        bgColor:           '#000d00',
        panelColor:        '#001a00',
        primaryColor:      '#00ff41',
        textPrimary:       '#00ff41',
        textSecondary:     '#008f11',
        bgHover:           '#002600',
        accentHover:       '#39ff6e',
        profit:            '#00ff41',
        loss:              '#ff3333',
        gold:              '#ffcc00',
        aiBg:              'rgba(0,255,65,0.05)',
        aiBorder:          'rgba(0,255,65,0.25)',
    },
    dracula: {
        background:        '#191a21',
        card:              '#21222c',
        primary:           '#bd93f9',
        primaryForeground: '#191a21',
        muted:             '#282a36',
        mutedForeground:   '#6272a4',
        border:            '#2d2f3e',
        ring:              '#bd93f9',
        sidebarBg:         '#191a21',
        sidebarAccentBg:   '#21222c',
        bgColor:           '#191a21',
        panelColor:        '#21222c',
        primaryColor:      '#bd93f9',
        textPrimary:       '#f8f8f2',
        textSecondary:     '#6272a4',
        bgHover:           '#282a36',
        accentHover:       '#caa8ff',
        profit:            '#50fa7b',
        loss:              '#ff5555',
        gold:              '#f1fa8c',
        aiBg:              'rgba(189,147,249,0.06)',
        aiBorder:          'rgba(189,147,249,0.25)',
    },
};

// --- РОЗУМНИЙ АЛГОРИТМ КОНТРАСТУ ТА РОЗДІЛЕННЯ ---
// Отримуємо яскравість (0 - найтемніший, 255 - найсвітліший)
function getBrightness(hex) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x+x).join('');
    if (c.length !== 6) return 0;
    let r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    return (r * 299 + g * 587 + b * 114) / 1000;
}

// Зміна кольору (світліше/темніше)
function adjustColor(col, amt) {
    col = col.replace('#', '');
    if (col.length === 3) col = col.split('').map(x=>x+x).join('');
    let r = parseInt(col.substr(0, 2), 16) + amt;
    let g = parseInt(col.substr(2, 2), 16) + amt;
    let b = parseInt(col.substr(4, 2), 16) + amt;
    r = Math.max(0, Math.min(255, r)).toString(16).padStart(2, '0');
    g = Math.max(0, Math.min(255, g)).toString(16).padStart(2, '0');
    b = Math.max(0, Math.min(255, b)).toString(16).padStart(2, '0');
    return "#" + r + g + b;
}

// Генерує контрастний колір тексту (чорний або білий) відносно фону
function getContrastText(bgHex) {
    return getBrightness(bgHex) > 128 ? '#000000' : '#ffffff';
}
// -------------------------------------------------

function getThemeFromUI() {
    const r = document.querySelector('input[name="theme"]:checked');
    return r ? r.value : (state.appData?.settings?.theme || 'dark');
}

function getFontFromUI() {
    const r = document.querySelector('input[name="font"]:checked');
    return r ? r.value : (state.appData?.settings?.font || 'inter');
}

function applyResolvedThemeVars(target, vars) {
    const set = (prop, val) => { if (val) target.style.setProperty(prop, val); };

    // oklch design tokens
    set('--background',         vars.background);
    set('--foreground',         vars.textPrimary);
    set('--card',               vars.card);
    set('--card-foreground',    vars.textPrimary);
    set('--primary',            vars.primary);
    set('--primary-foreground', vars.primaryForeground);
    set('--muted',              vars.muted);
    set('--muted-foreground',   vars.mutedForeground);
    set('--border',             vars.border);
    set('--input',              vars.border);
    set('--ring',               vars.ring);
    set('--sidebar-bg',         vars.sidebarBg);
    set('--sidebar-accent-bg',  vars.sidebarAccentBg || vars.bgHover);
    set('--sidebar-border-color', vars.border);
    set('--sidebar',            vars.sidebarBg);
    set('--sidebar-foreground', vars.textPrimary);
    set('--sidebar-primary',    vars.primary);
    set('--sidebar-primary-foreground', vars.primaryForeground);
    set('--sidebar-accent',     vars.sidebarAccentBg || vars.bgHover);
    set('--sidebar-accent-foreground', vars.textPrimary);
    set('--sidebar-border',     vars.border);
    set('--sidebar-ring',       vars.ring);

    // mapped legacy tokens
    set('--bg-color',       vars.bgColor);
    set('--panel-color',    vars.panelColor);
    set('--primary-color',  vars.primaryColor);
    set('--text-primary',   vars.textPrimary);
    set('--text-secondary', vars.textSecondary);
    set('--bg-main',        vars.bgColor);
    set('--bg-panel',       vars.panelColor);
    set('--text-main',      vars.textPrimary);
    set('--text-muted',     vars.textSecondary);
    set('--accent',         vars.primaryColor);
    set('--bg-hover',       vars.bgHover);
    set('--accent-hover',   vars.accentHover);
    set('--profit',         vars.profit);
    set('--loss',           vars.loss);
    set('--gold',           vars.gold);
    set('--ai-bg',          vars.aiBg);
    set('--ai-border',      vars.aiBorder);
    const fg = vars.primaryForeground || '#fff';
    target.style.setProperty('--tab-active-text', fg);
}

function applyThemeVarsEverywhere(vars) {
    applyResolvedThemeVars(document.documentElement, vars);
    applyResolvedThemeVars(document.body, vars);
}

export function applyTheme(forceSync = false) {
    const root = document.documentElement;

    if (forceSync || !isThemeUIInitialized) {
        if (state.appData && state.appData.settings) {
            const t = state.appData.settings.theme || 'dark';
            const f = state.appData.settings.font || 'inter';
            
            const tr = document.getElementById(`theme-${t}`);
            if (tr) tr.checked = true;
            
            const fr = document.getElementById(`font-${f}`);
            if (fr) fr.checked = true;
            
            if (state.appData.settings.customTheme) {
                const ct = state.appData.settings.customTheme;
                if (document.getElementById('ct-bg-main')) document.getElementById('ct-bg-main').value = ct.bgMain || '#0b0f19';
                if (document.getElementById('ct-bg-panel')) document.getElementById('ct-bg-panel').value = ct.bgPanel || '#111625';
                if (document.getElementById('ct-text-main')) document.getElementById('ct-text-main').value = ct.textMain || '#f3f4f6';
                if (document.getElementById('ct-accent')) document.getElementById('ct-accent').value = ct.accent || '#3b82f6';
                if (document.getElementById('ct-profit')) document.getElementById('ct-profit').value = ct.profit || '#10b981';
                if (document.getElementById('ct-loss')) document.getElementById('ct-loss').value = ct.loss || '#ef4444';
            }
        }
        isThemeUIInitialized = true;
    }

    const theme = getThemeFromUI();
    const font = getFontFromUI();

    document.body.setAttribute('data-theme', theme);
    document.body.setAttribute('data-font', font);

    const customBlock = document.getElementById('custom-theme-block');
    if (customBlock) customBlock.dataset.visible = (theme === 'custom') ? 'true' : 'false';

    // Clear all inline overrides so the selected preset can repaint the full UI cleanly.
    const allVars = [
        '--bg-main','--bg-panel','--text-main','--text-muted','--border',
        '--bg-hover','--accent','--accent-hover','--profit','--loss','--gold',
        '--ai-bg','--ai-border',
        '--bg-color','--panel-color','--primary-color','--text-primary','--text-secondary',
        '--tab-active-text','--tabs-bg',
        '--background','--foreground','--card','--card-foreground',
        '--primary','--primary-foreground','--muted','--muted-foreground',
        '--border','--input','--ring',
        '--sidebar-bg','--sidebar-accent-bg','--sidebar-border-color',
        '--sidebar','--sidebar-foreground','--sidebar-primary','--sidebar-primary-foreground',
        '--sidebar-accent','--sidebar-accent-foreground','--sidebar-border','--sidebar-ring',
    ];
    // Clear from both root and body to avoid stale overrides
    allVars.forEach(p => {
        root.style.removeProperty(p);
        document.body.style.removeProperty(p);
    });
    if (theme === 'custom') {
        const bgMain   = document.getElementById('ct-bg-main')?.value   || '#0b0f19';
        const bgPanel  = document.getElementById('ct-bg-panel')?.value  || '#111625';
        const textMain = document.getElementById('ct-text-main')?.value || '#f3f4f6';
        const accent   = document.getElementById('ct-accent')?.value    || '#3b82f6';
        const profit   = document.getElementById('ct-profit')?.value    || '#10b981';
        const loss     = document.getElementById('ct-loss')?.value      || '#ef4444';

        const isLight  = getBrightness(bgMain) > 128;
        const textMuted    = adjustColor(textMain, isLight ? 60 : -60);
        const bgHover      = adjustColor(bgMain,   isLight ? -12 : 18);
        const sidebarBg    = adjustColor(bgMain,   isLight ? -6  : -10);
        const sidebarAccent = adjustColor(bgMain,  isLight ? -14 : 20);
        const borderColor  = adjustColor(bgMain,   isLight ? -20 : 30);
        const accentHover  = adjustColor(accent,   getBrightness(accent) > 128 ? -20 : 20);
        const aiBg         = adjustColor(bgPanel,  isLight ? -8  : 10);

        applyThemeVarsEverywhere({
            background:        bgMain,
            card:              bgPanel,
            primary:           accent,
            primaryForeground: getContrastText(accent),
            muted:             bgHover,
            mutedForeground:   textMuted,
            border:            borderColor,
            ring:              accent,
            sidebarBg,
            sidebarAccentBg:   sidebarAccent,
            bgColor:           bgMain,
            panelColor:        bgPanel,
            primaryColor:      accent,
            textPrimary:       textMain,
            textSecondary:     textMuted,
            bgHover,
            accentHover,
            profit,
            loss,
            gold:    loss === '#ef4444' ? '#f59e0b' : profit,
            aiBorder: accent,
            aiBg,
        });

        document.documentElement.style.setProperty('--tabs-bg', sidebarAccent);
        document.body.style.setProperty('--tabs-bg', sidebarAccent);
    } else {
        applyThemeVarsEverywhere(THEME_PRESETS[theme] || THEME_PRESETS.dark);
        document.documentElement.style.removeProperty('--tabs-bg');
        document.body.style.removeProperty('--tabs-bg');
    }

    const fontMap = { roboto: "'Roboto', sans-serif", montserrat: "'Montserrat', sans-serif", playfair: "'Playfair Display', serif", mono: "'Courier New', Courier, monospace" };
    document.body.style.fontFamily = fontMap[font] || "'Inter', sans-serif";

    setTimeout(() => {
        if (window.Chart) {
            let textColor = getComputedStyle(root).getPropertyValue('--text-main').trim();
            let gridColor = getComputedStyle(root).getPropertyValue('--border').trim();
            Chart.defaults.color = textColor;
            Chart.defaults.borderColor = gridColor;
            const statsView = document.getElementById('view-stats');
            if (statsView?.classList.contains('active') && window.refreshStatsView) window.refreshStatsView();
            refreshDashMiniEquityChartTheme();
        }
    }, 50); 
}

export function saveThemeSettings() {
    if (!state.appData.settings) state.appData.settings = {};
    
    state.appData.settings.theme = getThemeFromUI();
    state.appData.settings.font = getFontFromUI();

    if (state.appData.settings.theme === 'custom') {
        state.appData.settings.customTheme = {
            bgMain: document.getElementById('ct-bg-main').value, 
            bgPanel: document.getElementById('ct-bg-panel').value,
            textMain: document.getElementById('ct-text-main').value, 
            accent: document.getElementById('ct-accent').value,
            profit: document.getElementById('ct-profit').value, 
            loss: document.getElementById('ct-loss').value
        };
    }
    
    applyTheme(); 
    saveToLocal().then(() => showToast("Стиль збережено!"));
}

export function switchTab(tabId) {
    document.querySelectorAll('.sidebar .tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.sidebar .tab-content').forEach((content) => {
        content.classList.toggle('active', content.id === tabId);
    });
    if (tabId === 'tab-session' && window.renderSessionPlaybook) window.renderSessionPlaybook();
    if (tabId === 'tab-trades' && window.state?.selectedDateStr && window.renderSidebarTradesList) {
        window.renderSidebarTradesList(window.state.selectedDateStr);
    }
}

export function toggleMobileSidebar(forceState) {
    const sidebar = document.querySelector('.sidebar');
    const menuBtn = document.getElementById('mobile-menu-btn');
    const backdrop = document.getElementById('form-sidebar-backdrop');
    if (!sidebar) return;

    const shouldOpen = typeof forceState === 'boolean' ? forceState : !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', shouldOpen);
    if (shouldOpen) sidebar.classList.remove('collapsed');
    if (backdrop) backdrop.classList.toggle('visible', shouldOpen);
    document.body.style.overflow = shouldOpen ? 'hidden' : '';

    if (menuBtn) {
        menuBtn.textContent = shouldOpen ? '✖ Закрити' : '☰ Меню';
    }
}

const TAB_TITLES = {
    dash: 'Головна',
    calendar: 'Календар',
    stats: 'Статистика',
    trades: 'Угоди',
    datagrid: 'Таблиця Угод',
    table: 'Імпорт Sheets',
    screens: 'Скріншоти',
    ai: 'AI Аналітик',
    'mentor-review': 'Черга рев’ю',
    playbook: 'Плейбук',
    learn: 'Навчання',
    settings: 'Налаштування',
    admin: 'Адмін-панель',
};

const TAB_ROUTES = {
    dash: '/',
    calendar: '/calendar',
    stats: '/stats',
    trades: '/trades',
    datagrid: '/datagrid',
    table: '/import',
    screens: '/screen',
    ai: '/ai',
    'mentor-review': '/mentor-review',
    playbook: '/playbook',
    learn: '/learn',
    settings: '/settings',
    admin: '/admin',
};

function getDashboardGreetingName() {
    const profileFirstName = document.getElementById('sidebar-pf-fname')?.value?.trim();
    if (profileFirstName) return profileFirstName;

    const sidebarName = document.getElementById('sidebar-account-name')?.textContent?.trim();
    if (sidebarName && sidebarName !== 'Профіль' && sidebarName !== '—') {
        return sidebarName.split(/\s+/)[0];
    }

    const nick = state.USER_DOC_NAME ? state.USER_DOC_NAME.replace(/_stats$/, '').trim() : '';
    return nick || 'трейдере';
}

function getDashboardGreetingTitle() {
    if (!DASH_GREETINGS.length) return TAB_TITLES.dash;
    if (selectedDashGreetingIndex === null) {
        const hour = new Date().getHours();
        const available = DASH_GREETINGS
            .map((greeting, index) => ({ greeting, index }))
            .filter(({ greeting }) => greeting.beforeHour === undefined || hour < greeting.beforeHour);
        const pool = available.length ? available : DASH_GREETINGS.map((greeting, index) => ({ greeting, index }));
        selectedDashGreetingIndex = pool[Math.floor(Math.random() * pool.length)].index;
    }
    return DASH_GREETINGS[selectedDashGreetingIndex].render(getDashboardGreetingName());
}

export function refreshCurrentMainTitle() {
    const activeView = document.querySelector('.view-content.active');
    const tab = activeView?.id?.replace(/^view-/, '') || 'dash';
    const title = tab === 'dash' ? getDashboardGreetingTitle() : (TAB_TITLES[tab] || '');
    const pageTitleEl = document.getElementById('page-title');
    const mobileTitleEl = document.getElementById('mobile-section-title');
    if (pageTitleEl) pageTitleEl.textContent = title;
    if (mobileTitleEl) mobileTitleEl.textContent = title;
}

const ROUTE_TABS = {
    '/': 'dash',
    '/dashboard': 'dash',
    '/calendar': 'calendar',
    '/stats': 'stats',
    '/trades': 'trades',
    '/datagrid': 'datagrid',
    '/trades-table': 'datagrid',
    '/table': 'table',
    '/import': 'table',
    '/sheet-import': 'table',
    '/screen': 'screens',
    '/screens': 'screens',
    '/ai': 'ai',
    '/mentor-review': 'mentor-review',
    '/playbook': 'playbook',
    '/learn': 'learn',
    '/settings': 'settings',
    '/admin': 'admin',
};

function normalizeRoutePath(pathname = '/') {
    const clean = String(pathname || '/').replace(/\/+$/, '') || '/';
    return clean.toLowerCase();
}

function getTabFromRoute() {
    return ROUTE_TABS[normalizeRoutePath(window.location.pathname)] || 'dash';
}

function updateRouteForTab(tab, mode = 'push') {
    if (!window.history?.pushState) return;
    const route = TAB_ROUTES[tab] || '/';
    if (normalizeRoutePath(window.location.pathname) === normalizeRoutePath(route)) return;
    const state = { tab };
    if (mode === 'replace') {
        window.history.replaceState(state, '', route);
    } else {
        window.history.pushState(state, '', route);
    }
}

export function switchMainTab(tab, options = {}) {
    if (!document.getElementById('view-' + tab)) tab = 'dash';
    if (options.updateRoute !== false) updateRouteForTab(tab, options.historyMode);
    // Очищаємо старі активні стани
    document.querySelectorAll('.main-tab-btn, .more-tab-item, .sidebar-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-content').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });
    
    // Активуємо кнопку в лівому меню
    let sidebarBtn = document.querySelector(`.sidebar-nav-item[data-tab="${tab}"]`);
    if(sidebarBtn) sidebarBtn.classList.add('active');
    
    // Активуємо стару кнопку (для сумісності)
    let btn = document.getElementById('main-btn-' + tab);
    if(btn) btn.classList.add('active');
    
    let view = document.getElementById('view-' + tab);
    if(view) {
        view.classList.add('active');
        view.style.display = 'flex';
    }

    // Оновлюємо bottom nav
    document.querySelectorAll('.mobile-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Оновлюємо more menu items
    document.querySelectorAll('.mobile-more-item').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Якщо активна вкладка в more menu — підсвічуємо кнопку Ще
    const moreTabIds = ['trades', 'datagrid', 'table', 'calendar', 'playbook', 'learn', 'settings', 'mentor-review'];
    const moreBtn = document.querySelector('.mobile-nav-more-btn');
    if (moreBtn) moreBtn.classList.toggle('more-open', moreTabIds.includes(tab));

    // Оновлюємо заголовки
    refreshCurrentMainTitle();

    if (tab === 'stats' && window.refreshStatsView) {
        // Скидаємо all-time фільтр при поверненні на вкладку — щоб не тригерило важке завантаження
        if (state.activeFilters?.some(f => f.type === 'all-time')) {
            state.activeFilters = [];
        }
        window.refreshStatsView();
    }
    if (tab === 'trades') {
        if (window.populateDateSelect) window.populateDateSelect();
        // Auto-populate pills for the currently selected calendar date
        if (window.populateSymbolSelect && window.state?.selectedDateStr) {
            window.populateSymbolSelect(window.state.selectedDateStr);
        }
    }
    if (tab === 'table' && window.initSheetTableView) window.initSheetTableView();
    if (tab === 'datagrid' && window.renderTradesDatagrid) window.renderTradesDatagrid();
    if (tab === 'dash' && window.renderDashboardNews) window.renderDashboardNews();
    if (tab === 'settings' && window.loadLatestImageForOCR) window.loadLatestImageForOCR();
    if (tab === 'screens') {
        if (window.updateDriveUI) window.updateDriveUI();
        if (window.syncDriveScreenshots) window.syncDriveScreenshots(true);
        if (window.refreshReviewRequestButtons) window.refreshReviewRequestButtons();
    }
    if (tab === 'calendar' && window.refreshReviewRequestButtons) window.refreshReviewRequestButtons();
    if (tab === 'playbook' && window.renderPlaybook) window.renderPlaybook();
    if (tab === 'learn' && window.renderLearnCache) window.renderLearnCache();

    if (tab === 'admin' && window.renderAdminPanel) window.renderAdminPanel();
    if (tab === 'mentor-review' && window.refreshMentorReviewQueue) void window.refreshMentorReviewQueue();
    let sosBtn = document.getElementById('sos-btn');
    if (sosBtn) sosBtn.style.display = tab === 'dash' ? 'flex' : 'none';
}

export function syncMainTabFromRoute() {
    const tab = getTabFromRoute();
    switchMainTab(tab, { updateRoute: false });
    updateRouteForTab(tab, 'replace');
}

export function bindMainTabRoutes() {
    window.addEventListener('popstate', () => {
        switchMainTab(getTabFromRoute(), { updateRoute: false });
    });
}

export function scrollMainTabs(offset) {
    const container = document.getElementById('main-tabs-container');
    if (container) {
        container.scrollBy({ left: offset, behavior: 'smooth' });
    }
}

export function toggleMoreTabs(forceState) {
    const dropdown = document.getElementById('more-tabs-dropdown');
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains('open');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !isOpen;
    dropdown.classList.toggle('open', shouldOpen);
}

export function toggleMobileMoreMenu() {
    const menu = document.getElementById('mobile-more-menu');
    if (!menu) return;
    const isOpen = menu.classList.contains('open');
    if (isOpen) {
        menu.classList.remove('open');
    } else {
        menu.classList.add('open');
    }
    const btn = document.querySelector('.mobile-nav-more-btn');
    if (btn) btn.classList.toggle('more-open', !isOpen);
}

export function closeMobileMoreMenu() {
    const menu = document.getElementById('mobile-more-menu');
    if (menu) menu.classList.remove('open');
    const btn = document.querySelector('.mobile-nav-more-btn');
    if (btn) btn.classList.remove('more-open');
}

window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', e => {
        if (!e.target.closest('.more-tabs-wrap')) {
            const d = document.getElementById('more-tabs-dropdown');
            if (d) d.style.display = 'none';
        }
        if (!e.target.closest('.mobile-nav-more-btn') && !e.target.closest('#mobile-more-menu')) {
            closeMobileMoreMenu();
        }
        // Закриваємо stats дропдауни при кліку поза ними
        if (!e.target.closest('.stats-bar-item') && window.closeStatsDropdown) {
            window.closeStatsDropdown();
        }
    });
});

export function toggleLeftSidebar() {
    const sidebar = document.querySelector('.app-sidebar');
    const main = document.querySelector('.main-content');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed');
    // main-content розширюється коли sidebar collapsed
    if (main) main.classList.toggle('expanded', sidebar.classList.contains('collapsed'));
}

window.toggleLeftSidebar = toggleLeftSidebar;

// Ініціалізація: застосовуємо expanded одразу бо sidebar collapsed за замовчуванням
document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('.app-sidebar');
    const main = document.querySelector('.main-content');
    if (sidebar?.classList.contains('collapsed') && main) {
        main.classList.add('expanded');
    }
});
