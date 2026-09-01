// === js/ui.js ===
import { state } from './state.js';
import { saveToLocal, saveSettings } from './storage.js';
import { showToast, showConfirm } from './utils.js';
import { disposeDashMiniEquityChart, refreshDashMiniEquityChartTheme } from './dash_mini_chart.js';
import { disposeStatsView } from './stats.js';
import { disposeTradesView } from './trades_view2.js';
import { disposeScreensView } from './gallery.js';
import { disposeTradesDatagrid } from './trades_datagrid.js';

let isThemeUIInitialized = false;
let selectedDashGreetingIndex = null;
let themeSaveTimer = 0;

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
    ocean: {
        background: '#061827', card: '#0b2538', primary: '#22d3ee', primaryForeground: '#04131f',
        muted: '#12344a', mutedForeground: '#7da7bd', border: '#17435d', ring: '#22d3ee',
        sidebarBg: '#04131f', sidebarAccentBg: '#0b2538', bgColor: '#061827', panelColor: '#0b2538',
        primaryColor: '#22d3ee', textPrimary: '#e0f7ff', textSecondary: '#7da7bd', bgHover: '#12344a',
        accentHover: '#67e8f9', profit: '#2dd4bf', loss: '#fb7185', gold: '#fbbf24',
        aiBg: 'rgba(34,211,238,0.06)', aiBorder: 'rgba(34,211,238,0.28)',
    },
    nord: {
        background: '#242933', card: '#2e3440', primary: '#88c0d0', primaryForeground: '#242933',
        muted: '#3b4252', mutedForeground: '#9aa7b8', border: '#434c5e', ring: '#88c0d0',
        sidebarBg: '#20242d', sidebarAccentBg: '#2e3440', bgColor: '#242933', panelColor: '#2e3440',
        primaryColor: '#88c0d0', textPrimary: '#eceff4', textSecondary: '#9aa7b8', bgHover: '#3b4252',
        accentHover: '#8fbcbb', profit: '#a3be8c', loss: '#bf616a', gold: '#ebcb8b',
        aiBg: 'rgba(136,192,208,0.06)', aiBorder: 'rgba(136,192,208,0.25)',
    },
    sunset: {
        background: '#1b1014', card: '#2a171c', primary: '#fb923c', primaryForeground: '#1b1014',
        muted: '#3a2025', mutedForeground: '#b98b86', border: '#543038', ring: '#fb923c',
        sidebarBg: '#160c10', sidebarAccentBg: '#2a171c', bgColor: '#1b1014', panelColor: '#2a171c',
        primaryColor: '#fb923c', textPrimary: '#fff1e8', textSecondary: '#b98b86', bgHover: '#3a2025',
        accentHover: '#fdba74', profit: '#4ade80', loss: '#f43f5e', gold: '#facc15',
        aiBg: 'rgba(251,146,60,0.06)', aiBorder: 'rgba(251,146,60,0.27)',
    },
    rose: {
        background: '#180d18', card: '#29152a', primary: '#f472b6', primaryForeground: '#180d18',
        muted: '#3a203b', mutedForeground: '#b892b7', border: '#513052', ring: '#f472b6',
        sidebarBg: '#130a14', sidebarAccentBg: '#29152a', bgColor: '#180d18', panelColor: '#29152a',
        primaryColor: '#f472b6', textPrimary: '#fce7f3', textSecondary: '#b892b7', bgHover: '#3a203b',
        accentHover: '#f9a8d4', profit: '#34d399', loss: '#fb7185', gold: '#fbbf24',
        aiBg: 'rgba(244,114,182,0.06)', aiBorder: 'rgba(244,114,182,0.27)',
    },
    obsidian: {
        background: '#07090d', card: '#11151c', primary: '#4f8cff', primaryForeground: '#ffffff',
        muted: '#191f2a', mutedForeground: '#8994a7', border: '#252d3a', ring: '#4f8cff',
        sidebarBg: '#090c11', sidebarAccentBg: '#151b24', bgColor: '#07090d', panelColor: '#11151c',
        primaryColor: '#4f8cff', textPrimary: '#f1f5fb', textSecondary: '#8994a7', bgHover: '#1a2230',
        accentHover: '#75a6ff', profit: '#36d399', loss: '#ff667a', gold: '#f4bc5e',
        aiBg: 'rgba(79,140,255,0.07)', aiBorder: 'rgba(79,140,255,0.3)',
    },
    aurora: {
        background: '#090a1a', card: '#12152b', primary: '#7c6cff', primaryForeground: '#ffffff',
        muted: '#1c2040', mutedForeground: '#9198bd', border: '#292e52', ring: '#7c6cff',
        sidebarBg: '#080918', sidebarAccentBg: '#171a34', bgColor: '#090a1a', panelColor: '#12152b',
        primaryColor: '#7c6cff', textPrimary: '#f0f1ff', textSecondary: '#9198bd', bgHover: '#1d2243',
        accentHover: '#9b90ff', profit: '#31e6b0', loss: '#ff668d', gold: '#ffc857',
        aiBg: 'rgba(124,108,255,0.08)', aiBorder: 'rgba(92,225,230,0.3)',
    },
    graphite: {
        background: '#111214', card: '#191b1f', primary: '#d2ff45', primaryForeground: '#111214',
        muted: '#23262b', mutedForeground: '#92979f', border: '#30343a', ring: '#d2ff45',
        sidebarBg: '#0d0e10', sidebarAccentBg: '#1d2024', bgColor: '#111214', panelColor: '#191b1f',
        primaryColor: '#d2ff45', textPrimary: '#f4f5f6', textSecondary: '#92979f', bgHover: '#24272c',
        accentHover: '#deff73', profit: '#76e6a6', loss: '#ff6b6b', gold: '#f5c451',
        aiBg: 'rgba(210,255,69,0.05)', aiBorder: 'rgba(210,255,69,0.24)',
    },
    ivory: {
        background: '#f5f1e9', card: '#fffdf8', primary: '#2563eb', primaryForeground: '#ffffff',
        muted: '#ebe5da', mutedForeground: '#726c63', border: '#ddd5c8', ring: '#2563eb',
        sidebarBg: '#eee8dd', sidebarAccentBg: '#e1eaff', bgColor: '#f5f1e9', panelColor: '#fffdf8',
        primaryColor: '#2563eb', textPrimary: '#24211d', textSecondary: '#726c63', bgHover: '#eee8dd',
        accentHover: '#1d4ed8', profit: '#16805d', loss: '#d13c4b', gold: '#b7791f',
        aiBg: 'rgba(37,99,235,0.05)', aiBorder: 'rgba(37,99,235,0.2)',
    },
    nebula: {
        background: '#090718', card: '#17142b', primary: '#a78bfa', primaryForeground: '#ffffff',
        muted: '#25203d', mutedForeground: '#a7a0c4', border: '#352d55', ring: '#a78bfa',
        sidebarBg: '#0b081a', sidebarAccentBg: '#201a38', bgColor: '#090718', panelColor: '#17142b',
        primaryColor: '#a78bfa', textPrimary: '#f5f3ff', textSecondary: '#a7a0c4', bgHover: '#272043',
        accentHover: '#c4b5fd', profit: '#5eead4', loss: '#fb7185', gold: '#fbbf24',
        aiBg: 'rgba(167,139,250,0.08)', aiBorder: 'rgba(167,139,250,0.3)',
    },
    lagoon: {
        background: '#03171b', card: '#0a2930', primary: '#2dd4bf', primaryForeground: '#03201f',
        muted: '#103b43', mutedForeground: '#80b7ba', border: '#18515a', ring: '#2dd4bf',
        sidebarBg: '#041418', sidebarAccentBg: '#0d3239', bgColor: '#03171b', panelColor: '#0a2930',
        primaryColor: '#2dd4bf', textPrimary: '#e6fffb', textSecondary: '#80b7ba', bgHover: '#10404a',
        accentHover: '#5eead4', profit: '#34d399', loss: '#fb7185', gold: '#facc15',
        aiBg: 'rgba(45,212,191,0.07)', aiBorder: 'rgba(45,212,191,0.28)',
    },
    ember: {
        background: '#1a0c0a', card: '#2b1713', primary: '#fb7185', primaryForeground: '#ffffff',
        muted: '#42231d', mutedForeground: '#c39a8e', border: '#5b3027', ring: '#fb7185',
        sidebarBg: '#160907', sidebarAccentBg: '#351c17', bgColor: '#1a0c0a', panelColor: '#2b1713',
        primaryColor: '#fb7185', textPrimary: '#fff4ed', textSecondary: '#c39a8e', bgHover: '#47251e',
        accentHover: '#fda4af', profit: '#4ade80', loss: '#ff4d6d', gold: '#fbbf24',
        aiBg: 'rgba(251,113,133,0.07)', aiBorder: 'rgba(251,113,133,0.28)',
    },
    frost: {
        background: '#eaf2ff', card: '#f8fbff', primary: '#6366f1', primaryForeground: '#ffffff',
        muted: '#dde8f8', mutedForeground: '#61708a', border: '#cad8ec', ring: '#6366f1',
        sidebarBg: '#e2ecfa', sidebarAccentBg: '#dce4ff', bgColor: '#eaf2ff', panelColor: '#f8fbff',
        primaryColor: '#6366f1', textPrimary: '#182238', textSecondary: '#61708a', bgHover: '#dae5f5',
        accentHover: '#4f46e5', profit: '#059669', loss: '#dc2626', gold: '#ca8a04',
        aiBg: 'rgba(99,102,241,0.05)', aiBorder: 'rgba(99,102,241,0.2)',
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
                if (document.getElementById('ct-gradient-enabled')) document.getElementById('ct-gradient-enabled').checked = !!ct.gradient;
                if (document.getElementById('ct-gradient-color')) document.getElementById('ct-gradient-color').value = ct.gradientColor || '#7c3aed';
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
        const profit   = '#10b981';
        const loss     = '#ef4444';
        const gradientEnabled = !!document.getElementById('ct-gradient-enabled')?.checked;
        const gradientColor = document.getElementById('ct-gradient-color')?.value || '#7c3aed';

        document.body.dataset.customGradient = gradientEnabled ? 'true' : 'false';
        root.style.setProperty('--custom-gradient-color', gradientColor);
        document.body.style.setProperty('--custom-gradient-color', gradientColor);

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
        delete document.body.dataset.customGradient;
        root.style.removeProperty('--custom-gradient-color');
        document.body.style.removeProperty('--custom-gradient-color');
        applyThemeVarsEverywhere(THEME_PRESETS[theme] || THEME_PRESETS.dark);
        document.documentElement.style.removeProperty('--tabs-bg');
        document.body.style.removeProperty('--tabs-bg');
    }

    const fontMap = {
        dm: { main: "'DM Sans', sans-serif", head: "'Space Grotesk', 'DM Sans', sans-serif" },
        inter: { main: "'Inter', sans-serif", head: "'Inter', sans-serif" },
        manrope: { main: "'Manrope', sans-serif", head: "'Manrope', sans-serif" },
        space: { main: "'Space Grotesk', sans-serif", head: "'Space Grotesk', sans-serif" },
        sora: { main: "'Sora', sans-serif", head: "'Sora', sans-serif" },
        mono: { main: "'DM Mono', monospace", head: "'DM Mono', monospace" },
        roboto: { main: "'Inter', sans-serif", head: "'Inter', sans-serif" },
        montserrat: { main: "'Manrope', sans-serif", head: "'Manrope', sans-serif" },
        playfair: { main: "'Sora', sans-serif", head: "'Sora', sans-serif" },
    };
    const resolvedFont = fontMap[font] || fontMap.inter;
    [root, document.body].forEach((target) => {
        target.style.setProperty('--font-main', resolvedFont.main);
        target.style.setProperty('--font-head', resolvedFont.head);
        target.style.setProperty('--font-mono', "'DM Mono', monospace");
    });
    document.body.style.fontFamily = resolvedFont.main;

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

export function saveThemeSettings(options = {}) {
    if (!state.appData.settings) state.appData.settings = {};
    
    state.appData.settings.theme = getThemeFromUI();
    state.appData.settings.font = getFontFromUI();
    state.appData.settings.themeUpdatedAt = new Date().toISOString();

    if (state.appData.settings.theme === 'custom') {
        state.appData.settings.customTheme = {
            bgMain: document.getElementById('ct-bg-main').value, 
            bgPanel: document.getElementById('ct-bg-panel').value,
            textMain: document.getElementById('ct-text-main').value, 
            accent: document.getElementById('ct-accent').value,
            profit: '#10b981',
            loss: '#ef4444',
            gradient: !!document.getElementById('ct-gradient-enabled')?.checked,
            gradientColor: document.getElementById('ct-gradient-color')?.value || '#7c3aed'
        };
    }
    
    applyTheme();
    clearTimeout(themeSaveTimer);
    const commit = () => saveSettings().then(() => {
        try {
            localStorage.setItem(`theme:${state.myUserId || 'local'}`, JSON.stringify({
                theme: state.appData.settings.theme,
                font: state.appData.settings.font,
                customTheme: state.appData.settings.customTheme || null,
                updatedAt: state.appData.settings.themeUpdatedAt,
            }));
        } catch {}
        if (!options.quiet) showToast('Стиль збережено!');
    });
    if (options.quiet) themeSaveTimer = window.setTimeout(commit, 280);
    else void commit();
    return;
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
    'team-report': 'TeamLead Report',
    dash: 'Головна',
    calendar: 'Календар',
    stats: 'Статистика',
    trades: 'Угоди',
    datagrid: 'Таблиця Угод',
    table: 'Імпорт Sheets',
    screens: 'Скріншоти',
    'stop-errors': 'Помилки',
    ai: 'AI Аналітик',
    'mentor-review': 'Черга рев’ю',
    playbook: 'Плейбук',
    learn: 'Навчання',
    settings: 'Налаштування',
    admin: 'Адмін-панель',
    testing: 'Тестування',
};

const NAV_TITLES = {
    'team-report': 'TeamLead Report',
    dash: 'Огляд',
    calendar: 'Календар',
    stats: 'Аналітика',
    trades: 'Журнал',
    datagrid: 'Таблиця',
    table: 'Імпорт',
    screens: 'Скріншоти',
    'stop-errors': 'Помилки',
    ai: 'AI Ментор',
    'mentor-review': 'Черга ревʼю',
    playbook: 'Плейбук',
    learn: 'Навчання',
    settings: 'Налаштування',
    admin: 'Адмін-панель',
    testing: 'Тестування',
};

const TAB_ROUTES = {
    'team-report': '/team-report',
    dash: '/',
    calendar: '/calendar',
    stats: '/stats',
    trades: '/trades',
    datagrid: '/datagrid',
    table: '/import',
    screens: '/screen',
    'stop-errors': '/mistakes',
    ai: '/ai',
    'mentor-review': '/mentor-review',
    playbook: '/playbook',
    learn: '/learn',
    settings: '/settings',
    admin: '/admin',
    testing: '/testing',
};

const TAB_DISPOSERS = {
    dash: () => disposeDashMiniEquityChart(),
    stats: () => disposeStatsView(),
    trades: () => disposeTradesView(),
    datagrid: () => disposeTradesDatagrid(),
    screens: () => disposeScreensView(),
};
const TAB_LOADING_TITLES = {
    'team-report': 'Готуємо TeamLead report',
    dash: 'Готуємо головну',
    calendar: 'Готуємо календар',
    stats: 'Готуємо статистику',
    trades: 'Готуємо угоди',
    datagrid: 'Готуємо таблицю угод',
    table: 'Готуємо імпорт',
    screens: 'Готуємо скріншоти',
    'stop-errors': 'Готуємо розбір помилок',
    ai: 'Готуємо AI',
    'mentor-review': 'Готуємо ревʼю',
    playbook: 'Готуємо плейбук',
    learn: 'Готуємо навчання',
    settings: 'Готуємо налаштування',
    admin: 'Готуємо адмін-панель',
    testing: 'Готуємо тестування',
};
let mainTabSwitchToken = 0;

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function resetCustomTheme() {
    const defaults = {
        bgMain: '#0f172a', bgPanel: '#1e293b', textMain: '#f8fafc', accent: '#3b82f6',
        profit: '#10b981', loss: '#ef4444', gradient: false, gradientColor: '#7c3aed',
    };
    const values = {
        'ct-bg-main': defaults.bgMain,
        'ct-bg-panel': defaults.bgPanel,
        'ct-text-main': defaults.textMain,
        'ct-accent': defaults.accent,
        'ct-gradient-color': defaults.gradientColor,
    };
    Object.entries(values).forEach(([id, value]) => {
        const input = document.getElementById(id);
        if (input) input.value = value;
    });
    const gradient = document.getElementById('ct-gradient-enabled');
    if (gradient) gradient.checked = false;
    const customRadio = document.getElementById('theme-custom');
    if (customRadio) customRadio.checked = true;
    state.appData.settings.customTheme = defaults;
    applyTheme();
    saveThemeSettings();
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureViewLoader(view, tab) {
    let loader = view.querySelector(':scope > .view-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.className = 'view-loader';
        loader.setAttribute('role', 'status');
        loader.setAttribute('aria-live', 'polite');
        loader.innerHTML = `
            <div class="view-loader-box">
                <div class="view-loader-mark" aria-hidden="true"><span class="view-loader-ring"></span></div>
                <p class="view-loader-title"></p>
                <p class="view-loader-subtitle">Завантажуємо дані та збираємо інтерфейс</p>
                <div class="view-loader-lines" aria-hidden="true">
                    <span class="view-loader-line"></span>
                    <span class="view-loader-line"></span>
                    <span class="view-loader-line"></span>
                </div>
            </div>`;
        view.prepend(loader);
    }
    const title = loader.querySelector('.view-loader-title');
    if (title) title.textContent = TAB_LOADING_TITLES[tab] || 'Готуємо вкладку';
    return loader;
}

function setViewLoading(view, tab, isLoading) {
    if (!view) return;
    if (isLoading) {
        ensureViewLoader(view, tab);
        view.classList.add('app-view-loading');
        view.setAttribute('aria-busy', 'true');
    } else {
        view.classList.remove('app-view-loading');
        view.removeAttribute('aria-busy');
    }
}

function deactivateMainView(view, nextTab) {
    if (!view) return;
    const prevTab = view.id?.replace(/^view-/, '') || '';
    const wasActive = view.classList.contains('active');
    if (wasActive && prevTab) {
        view.dispatchEvent(new CustomEvent('app:view-leave', {
            bubbles: true,
            detail: { tab: prevTab, nextTab },
        }));
        try { TAB_DISPOSERS[prevTab]?.(); } catch (error) {
            console.warn(`[UI] cleanup for ${prevTab} failed:`, error);
        }
    }
    view.classList.remove('active');
    setViewLoading(view, prevTab, false);
    view.style.display = 'none';
    view.setAttribute('aria-hidden', 'true');
    view.inert = true;
}

function activateMainView(view, tab, previousTab) {
    if (!view) return;
    view.classList.add('active');
    view.style.display = 'flex';
    view.setAttribute('aria-hidden', 'false');
    view.inert = false;
    view.dispatchEvent(new CustomEvent('app:view-enter', {
        bubbles: true,
        detail: { tab, previousTab },
    }));
}

async function runMainTabWork(tab) {
    const tasks = [];
    if (tab === 'team-report' && window.renderTeamReport) tasks.push(Promise.resolve(window.renderTeamReport()));
    if (tab === 'ai') {
        window.initAILearningCenter?.();
    }
    if (tab === 'stats' && window.refreshStatsView) {
        // РЎРєРёРґР°С”РјРѕ all-time С„С–Р»СЊС‚СЂ РїСЂРё РїРѕРІРµСЂРЅРµРЅРЅС– РЅР° РІРєР»Р°РґРєСѓ вЂ” С‰РѕР± РЅРµ С‚СЂРёРіРµСЂРёР»Рѕ РІР°Р¶РєРµ Р·Р°РІР°РЅС‚Р°Р¶РµРЅРЅСЏ
        if (state.activeFilters?.some(f => f.type === 'all-time')) {
            state.activeFilters = [];
        }
        tasks.push(Promise.resolve(window.refreshStatsView()));
    }
    if (tab === 'trades') {
        if (window.populateDateSelect) tasks.push(Promise.resolve(window.populateDateSelect()));
        if (window.populateSymbolSelect && window.state?.selectedDateStr) {
            tasks.push(Promise.resolve(window.populateSymbolSelect(window.state.selectedDateStr)));
        }
    }
    if (tab === 'table' && window.initSheetTableView) tasks.push(Promise.resolve(window.initSheetTableView()));
    if (tab === 'datagrid' && window.renderTradesDatagrid) tasks.push(Promise.resolve(window.renderTradesDatagrid()));
    if (tab === 'dash') {
        tasks.push(Promise.resolve(refreshDashMiniEquityChartTheme()));
        if (window.renderDashboardNews) tasks.push(Promise.resolve(window.renderDashboardNews()));
        if (window.renderMarketSentiment) tasks.push(Promise.resolve(window.renderMarketSentiment()));
    }
    if (tab === 'screens') {
        if (window.setupOCRDrawing) window.setupOCRDrawing();
        if (window.updateDriveUI) tasks.push(Promise.resolve(window.updateDriveUI()));
        if (window.restoreScreensDistributionState) tasks.push(Promise.resolve(window.restoreScreensDistributionState()));
        if (window.loadImages) tasks.push(Promise.resolve(window.loadImages()));
        const settingsPanel = document.getElementById('screens-settings-panel');
        if (settingsPanel && !settingsPanel.classList.contains('initially-hidden') && window.loadLatestImageForOCR) {
            tasks.push(Promise.resolve(window.loadLatestImageForOCR()));
        }
        if (window.syncDriveScreenshots) tasks.push(Promise.resolve(window.syncDriveScreenshots(true)));
        if (window.refreshReviewRequestButtons) tasks.push(Promise.resolve(window.refreshReviewRequestButtons()));
    }
    if (tab === 'stop-errors') {
        if (window.initStopReview) window.initStopReview();
        if (window.refreshStopReview) tasks.push(Promise.resolve(window.refreshStopReview()));
    }
    if (tab === 'calendar' && window.refreshReviewRequestButtons) tasks.push(Promise.resolve(window.refreshReviewRequestButtons()));
    if (tab === 'settings' && window.renderDaylossSettings) tasks.push(Promise.resolve(window.renderDaylossSettings()));
    if (tab === 'settings' && window.renderSettingsBackups) tasks.push(Promise.resolve(window.renderSettingsBackups()));
    if (tab === 'settings' && window.refreshSettingsBackups) tasks.push(Promise.resolve(window.refreshSettingsBackups()));
    if (tab === 'playbook' && window.renderPlaybook) tasks.push(Promise.resolve(window.renderPlaybook()));
    if (tab === 'learn' && window.renderLearnCache) tasks.push(Promise.resolve(window.renderLearnCache()));
    if (tab === 'admin' && window.renderAdminPanel) tasks.push(Promise.resolve(window.renderAdminPanel()));
    if (tab === 'testing' && window.renderTestingPanel) tasks.push(Promise.resolve(window.renderTestingPanel()));
    if (tab === 'mentor-review' && window.refreshMentorReviewQueue) tasks.push(Promise.resolve(window.refreshMentorReviewQueue()));

    await Promise.allSettled(tasks);
}

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
    const title = tab === 'dash' ? getDashboardGreetingTitle() : (NAV_TITLES[tab] || TAB_TITLES[tab] || '');
    const pageTitleEl = document.getElementById('page-title');
    const mobileTitleEl = document.getElementById('mobile-section-title');
    if (pageTitleEl) pageTitleEl.textContent = title;
    if (mobileTitleEl) mobileTitleEl.textContent = title;
}

const ROUTE_TABS = {
    '/team-report': 'team-report',
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
    '/mistakes': 'stop-errors',
    '/errors': 'stop-errors',
    '/ai': 'ai',
    '/mentor-review': 'mentor-review',
    '/playbook': 'playbook',
    '/learn': 'learn',
    '/settings': 'settings',
    '/admin': 'admin',
    '/testing': 'testing',
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

export async function switchMainTab(tab, options = {}) {
    if (tab === 'testing' && state.myRole !== 'admin') tab = 'dash';
    if (!document.getElementById('view-' + tab)) {
        tab = 'dash';
    }
    document.body?.classList.toggle('is-calendar-tab', tab === 'calendar');
    const previousView = document.querySelector('.view-content.active');
    const previousTab = previousView?.id?.replace(/^view-/, '') || '';
    if (previousTab === tab) return;
    await window.autoSaveCurrentDay?.();
    const switchToken = ++mainTabSwitchToken;
    if (options.updateRoute !== false) updateRouteForTab(tab, options.historyMode);
    // Очищаємо старі активні стани
    document.querySelectorAll('.main-tab-btn, .more-tab-item, .sidebar-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-content').forEach(v => {
        deactivateMainView(v, tab);
    });
    
    // Активуємо кнопку в лівому меню
    let sidebarBtn = document.querySelector(`.sidebar-nav-item[data-tab="${tab}"]`);
    if(sidebarBtn) sidebarBtn.classList.add('active');
    
    // Активуємо стару кнопку (для сумісності)
    let btn = document.getElementById('main-btn-' + tab);
    if(btn) btn.classList.add('active');
    
    let view = document.getElementById('view-' + tab);
    activateMainView(view, tab, previousTab);
    setViewLoading(view, tab, true);

    // Оновлюємо bottom nav
    document.querySelectorAll('.mobile-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Оновлюємо more menu items
    document.querySelectorAll('.mobile-more-item').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Якщо активна вкладка в more menu — підсвічуємо кнопку Ще
    const moreTabIds = ['trades', 'datagrid', 'table', 'calendar', 'stop-errors', /* 'playbook', */ 'learn', 'settings', 'mentor-review', 'admin', 'testing'];
    const moreBtn = document.querySelector('.mobile-nav-more-btn');
    if (moreBtn) moreBtn.classList.toggle('more-open', moreTabIds.includes(tab));

    // Оновлюємо заголовки
    refreshCurrentMainTitle();

    let activeSosBtn = document.getElementById('sos-btn');
    if (activeSosBtn) activeSosBtn.style.display = tab === 'dash' ? 'flex' : 'none';

    const startedAt = performance.now();
    await nextPaint();
    await runMainTabWork(tab);
    const elapsed = performance.now() - startedAt;
    if (elapsed < 260) await delay(260 - elapsed);
    if (switchToken === mainTabSwitchToken && view?.classList.contains('active')) {
        setViewLoading(view, tab, false);
    }
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
    menu.classList.toggle('open', !isOpen);
    document.querySelector('.mobile-more-backdrop')?.classList.toggle('open', !isOpen);
    document.body.classList.toggle('mobile-nav-open', !isOpen);
    const btn = document.querySelector('.mobile-nav-more-btn');
    if (btn) {
        btn.classList.toggle('more-open', !isOpen);
        btn.setAttribute('aria-expanded', String(!isOpen));
    }
    if (!isOpen) {
        window.setTimeout(() => menu.querySelector('.mobile-more-item.active, .mobile-more-item')?.focus(), 50);
    } else {
        btn?.focus();
    }
}

export function closeMobileMoreMenu() {
    const menu = document.getElementById('mobile-more-menu');
    if (menu) menu.classList.remove('open');
    document.querySelector('.mobile-more-backdrop')?.classList.remove('open');
    document.body.classList.remove('mobile-nav-open');
    const btn = document.querySelector('.mobile-nav-more-btn');
    if (btn) {
        btn.classList.remove('more-open');
        btn.setAttribute('aria-expanded', 'false');
    }
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
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.getElementById('mobile-more-menu')?.classList.contains('open')) {
            closeMobileMoreMenu();
            document.querySelector('.mobile-nav-more-btn')?.focus();
        }
    });
    window.addEventListener('resize', () => {
        if (window.innerWidth > 1024) closeMobileMoreMenu();
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
