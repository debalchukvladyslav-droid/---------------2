// === js/ui.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { showToast, showConfirm } from './utils.js';

let isThemeUIInitialized = false;

const THEME_PRESETS = {
    dark: {
        background:        'oklch(0.098 0 0)',
        card:              'oklch(0.13 0 0)',
        primary:           'oklch(0.67 0.21 145)',
        primaryForeground: 'oklch(0.1 0 0)',
        muted:             'oklch(0.18 0 0)',
        mutedForeground:   'oklch(0.55 0 0)',
        border:            'oklch(0.22 0 0)',
        ring:              'oklch(0.67 0.21 145)',
        sidebarBg:         'oklch(0.08 0 0)',
        sidebarAccentBg:   'oklch(0.15 0 0)',
        bgColor:     'oklch(0.098 0 0)',
        panelColor:  'oklch(0.13 0 0)',
        primaryColor:'oklch(0.67 0.21 145)',
        textPrimary: 'oklch(0.985 0 0)',
        textSecondary:'oklch(0.55 0 0)',
        bgHover:     'oklch(0.18 0 0)',
        accentHover: 'oklch(0.75 0.18 145)',
        profit:      'oklch(0.67 0.21 145)',
        loss:        'oklch(0.55 0.2 25)',
        gold:        'oklch(0.75 0.15 80)',
        aiBg:        'color-mix(in srgb, oklch(0.67 0.21 145) 5%, transparent)',
        aiBorder:    'oklch(0.67 0.21 145)',
    },
    light: {
        background:        'oklch(0.97 0 0)',
        card:              'oklch(1 0 0)',
        primary:           'oklch(0.55 0.2 250)',
        primaryForeground: 'oklch(0.985 0 0)',
        muted:             'oklch(0.95 0 0)',
        mutedForeground:   'oklch(0.5 0 0)',
        border:            'oklch(0.88 0 0)',
        ring:              'oklch(0.55 0.2 250)',
        sidebarBg:         'oklch(0.99 0 0)',
        sidebarAccentBg:   'oklch(0.93 0 0)',
        bgColor:     'oklch(0.97 0 0)',
        panelColor:  'oklch(1 0 0)',
        primaryColor:'oklch(0.55 0.2 250)',
        textPrimary: 'oklch(0.15 0 0)',
        textSecondary:'oklch(0.5 0 0)',
        bgHover:     'oklch(0.93 0 0)',
        accentHover: 'oklch(0.45 0.2 250)',
        profit:      'oklch(0.45 0.18 145)',
        loss:        'oklch(0.5 0.22 25)',
        gold:        'oklch(0.6 0.15 70)',
        aiBg:        'oklch(0.93 0.05 250)',
        aiBorder:    'oklch(0.55 0.2 250)',
    },
    matrix: {
        background:        'oklch(0 0 0)',
        card:              'oklch(0.06 0 0)',
        primary:           'oklch(0.72 0.28 145)',
        primaryForeground: 'oklch(0 0 0)',
        muted:             'oklch(0.08 0 0)',
        mutedForeground:   'oklch(0.45 0.15 145)',
        border:            'oklch(0.15 0.08 145)',
        ring:              'oklch(0.72 0.28 145)',
        sidebarBg:         'oklch(0.03 0 0)',
        sidebarAccentBg:   'oklch(0.1 0.03 145)',
        bgColor:     'oklch(0 0 0)',
        panelColor:  'oklch(0.06 0 0)',
        primaryColor:'oklch(0.72 0.28 145)',
        textPrimary: 'oklch(0.85 0.25 145)',
        textSecondary:'oklch(0.45 0.15 145)',
        bgHover:     'oklch(0.1 0.03 145)',
        accentHover: 'oklch(0.85 0.25 145)',
        profit:      'oklch(0.72 0.28 145)',
        loss:        'oklch(0.55 0.22 25)',
        gold:        'oklch(0.75 0.18 100)',
        aiBg:        'oklch(0.04 0.05 145)',
        aiBorder:    'oklch(0.72 0.28 145)',
    },
    dracula: {
        background:        'oklch(0.2 0.02 270)',
        card:              'oklch(0.28 0.03 270)',
        primary:           'oklch(0.72 0.2 300)',
        primaryForeground: 'oklch(0.15 0 0)',
        muted:             'oklch(0.32 0.04 270)',
        mutedForeground:   'oklch(0.65 0.08 200)',
        border:            'oklch(0.42 0.06 260)',
        ring:              'oklch(0.72 0.2 300)',
        sidebarBg:         'oklch(0.16 0.02 270)',
        sidebarAccentBg:   'oklch(0.32 0.04 270)',
        bgColor:     'oklch(0.2 0.02 270)',
        panelColor:  'oklch(0.28 0.03 270)',
        primaryColor:'oklch(0.72 0.2 300)',
        textPrimary: 'oklch(0.97 0.01 80)',
        textSecondary:'oklch(0.75 0.1 200)',
        bgHover:     'oklch(0.42 0.06 260)',
        accentHover: 'oklch(0.78 0.22 340)',
        profit:      'oklch(0.75 0.22 145)',
        loss:        'oklch(0.6 0.22 25)',
        gold:        'oklch(0.95 0.18 100)',
        aiBg:        'oklch(0.2 0.02 270)',
        aiBorder:    'oklch(0.72 0.2 300)',
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
    document.querySelectorAll('.sidebar .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.sidebar .tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    const idx = ['tab-profit','tab-mind','tab-errors','tab-session'].indexOf(tabId);
    const btn = document.querySelector(`.sidebar .tab-btn:nth-child(${idx + 1})`);
    if (btn) btn.classList.add('active');
    if (tabId === 'tab-session' && window.renderSessionPlaybook) window.renderSessionPlaybook();
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
    dash: '📊 Дашборд',
    stats: '📈 Статистика',
    trades: '📋 Угоди',
    screens: '🖼️ Скріншоти',
    ai: '🤖 AI Аналітик',
    playbook: '📖 Плейбук',
    settings: '⚙️ Налаштування',
    admin: '🛡 Адмін-панель',
};

export function switchMainTab(tab) {
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
    const moreTabIds = ['trades', 'playbook', 'learn', 'settings'];
    const moreBtn = document.querySelector('.mobile-nav-more-btn');
    if (moreBtn) moreBtn.classList.toggle('more-open', moreTabIds.includes(tab));

    // Оновлюємо заголовки
    const pageTitleEl = document.getElementById('page-title');
    const mobileTitleEl = document.getElementById('mobile-section-title');
    const title = TAB_TITLES[tab] || '';
    if (pageTitleEl) pageTitleEl.textContent = title;
    if (mobileTitleEl) mobileTitleEl.textContent = title;

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
    if (tab === 'settings' && window.loadLatestImageForOCR) window.loadLatestImageForOCR();
    if (tab === 'screens') {
        if (window.updateDriveUI) window.updateDriveUI();
        if (window.syncDriveScreenshots) window.syncDriveScreenshots(true);
    }
    if (tab === 'playbook' && window.renderPlaybook) window.renderPlaybook();
    if (tab === 'learn' && window.renderLearnCache) window.renderLearnCache();

    if (tab === 'admin' && window.renderAdminPanel) window.renderAdminPanel();
    let sosBtn = document.getElementById('sos-btn');
    if (sosBtn) sosBtn.style.display = tab === 'dash' ? 'flex' : 'none';
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
