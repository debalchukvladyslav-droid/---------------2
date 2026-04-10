// === js/ui.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { showToast, showConfirm } from './utils.js';

let isThemeUIInitialized = false;

const THEME_PRESETS = {
    dark: {
        bgColor: '#0b0f19',
        panelColor: '#111625',
        primaryColor: '#3b82f6',
        textPrimary: '#f3f4f6',
        textSecondary: '#9ca3af',
        bgHover: '#1b2236',
        accentHover: '#60a5fa',
        profit: '#10b981',
        loss: '#ef4444',
        border: 'rgba(156, 163, 175, 0.15)',
        gold: '#f59e0b',
        aiBg: 'color-mix(in srgb, #3b82f6 5%, transparent)',
        aiBorder: '#3b82f6',
    },
    light: {
        bgColor: '#f1f5f9',
        panelColor: '#ffffff',
        primaryColor: '#2563eb',
        textPrimary: '#0f172a',
        textSecondary: '#64748b',
        bgHover: '#e2e8f0',
        accentHover: '#1d4ed8',
        profit: '#059669',
        loss: '#dc2626',
        border: '#cbd5e1',
        gold: '#d97706',
        aiBg: '#e0e7ff',
        aiBorder: '#6366f1',
    },
    matrix: {
        bgColor: '#000000',
        panelColor: '#0a0a0a',
        primaryColor: '#00dd00',
        textPrimary: '#00ff00',
        textSecondary: '#008800',
        bgHover: '#111111',
        accentHover: '#00ff00',
        profit: '#00ff00',
        loss: '#ff0000',
        border: '#003300',
        gold: '#aaaa00',
        aiBg: '#001100',
        aiBorder: '#00ff00',
    },
    dracula: {
        bgColor: '#282a36',
        panelColor: '#44475a',
        primaryColor: '#bd93f9',
        textPrimary: '#f8f8f2',
        textSecondary: '#8be9fd',
        bgHover: '#6272a4',
        accentHover: '#ff79c6',
        profit: '#50fa7b',
        loss: '#ff5555',
        border: '#6272a4',
        gold: '#f1fa8c',
        aiBg: '#282a36',
        aiBorder: '#bd93f9',
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
    target.style.setProperty('--bg-color', vars.bgColor);
    target.style.setProperty('--panel-color', vars.panelColor);
    target.style.setProperty('--primary-color', vars.primaryColor);
    target.style.setProperty('--text-primary', vars.textPrimary);
    target.style.setProperty('--text-secondary', vars.textSecondary);

    target.style.setProperty('--bg-main', vars.bgColor);
    target.style.setProperty('--bg-panel', vars.panelColor);
    target.style.setProperty('--text-main', vars.textPrimary);
    target.style.setProperty('--text-muted', vars.textSecondary);
    target.style.setProperty('--accent', vars.primaryColor);
    target.style.setProperty('--bg-hover', vars.bgHover);
    target.style.setProperty('--accent-hover', vars.accentHover);
    target.style.setProperty('--profit', vars.profit);
    target.style.setProperty('--loss', vars.loss);
    target.style.setProperty('--border', vars.border);
    target.style.setProperty('--gold', vars.gold);
    target.style.setProperty('--ai-bg', vars.aiBg);
    target.style.setProperty('--ai-border', vars.aiBorder);
    target.style.setProperty('--tab-active-text', vars.tabActiveText || getContrastText(vars.primaryColor));
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
    ];
    // Clear from both root and body to avoid stale overrides
    allVars.forEach(p => {
        root.style.removeProperty(p);
        document.body.style.removeProperty(p);
    });
    if (theme === 'custom') {
        const bgMain  = document.getElementById('ct-bg-main')?.value  || '#0b0f19';
        const bgPanel = document.getElementById('ct-bg-panel')?.value || '#111625';
        const textMain = document.getElementById('ct-text-main')?.value || '#f3f4f6';
        const accent  = document.getElementById('ct-accent')?.value   || '#3b82f6';
        const profit  = document.getElementById('ct-profit')?.value   || '#10b981';
        const loss    = document.getElementById('ct-loss')?.value     || '#ef4444';

        applyThemeVarsEverywhere({
            bgColor: bgMain,
            panelColor: bgPanel,
            primaryColor: accent,
            textPrimary: textMain,
            textSecondary: textMain + 'b0',
            bgHover: textMain + '18',
            accentHover: adjustColor(accent, getBrightness(accent) > 128 ? -20 : 20),
            profit,
            loss,
            border: textMain + '40',
            gold: loss === '#ef4444' ? '#f59e0b' : profit,
            aiBorder: accent,
            aiBg: accent + '1a',
            tabActiveText: getContrastText(accent),
        });

        const tabsBg = getBrightness(bgMain) > 128 ? adjustColor(bgMain, -15) : adjustColor(bgMain, 15);
        document.documentElement.style.setProperty('--tabs-bg', tabsBg);
        document.body.style.setProperty('--tabs-bg', tabsBg);
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
    document.querySelectorAll('.main-tab-btn, .more-tab-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-content').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });
    
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

    // Оновлюємо заголовок в хедері
    const titleEl = document.getElementById('mobile-section-title');
    if (titleEl) titleEl.textContent = TAB_TITLES[tab] || '';

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
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    const btn = document.querySelector('.mobile-nav-more-btn');
    if (btn) btn.classList.toggle('more-open', !isOpen);
}

export function closeMobileMoreMenu() {
    const menu = document.getElementById('mobile-more-menu');
    if (menu) menu.style.display = 'none';
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
