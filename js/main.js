// === js/main.js ===

// 1. ІМПОРТИ
import { supabase } from './supabase.js';
import { state } from './state.js';
import { getDefaultDayEntry } from './data_utils.js';
import { toggleAuthMode, handleAuth, logout, loadMentorStatusForAccount, activateMentorMode, deactivateMentorMode, applyAccessRights, saveMentorComment, savePrivateNote, loadPrivateNote, showResetStep, sendResetCode, verifyResetCode, applyNewPassword, resetPassword, showMigrationForm } from './auth.js';
import { loadTeams, openTeamManager, createNewTeam, moveTrader, deleteTeam, deleteTraderProfile, renderTeamSidebar, switchUser } from './teams.js';
import { saveToLocal, initializeApp, exportData, importData, loadMonth, resolveViewedUserId, setCurrentViewedUserId,
         uploadBackground, setActiveBackground, deleteBackground, loadBackgroundGallery } from './storage.js';
import { applyTheme, saveThemeSettings, switchTab, toggleMobileSidebar, switchMainTab, scrollMainTabs, toggleMoreTabs, toggleMobileMoreMenu, closeMobileMoreMenu } from './ui.js';
import { shiftDate, selectDateFromInput, saveEntry, renderView, selectDate, updateAutoFlags, initSelectors } from './calendar.js';
import { toggleStatsDropdown, toggleTree, toggleStatsFilter, refreshStatsView, closeStatsDropdown, renderStatsSourceSelector, selectStatsSource, renderTradeTypeSelector, selectTradeTypeFilter } from './stats.js';
import { renderErrorsList, addNewErrorType, deleteErrorType, renderChecklistDisplay, renderSettingsChecklist, addNewChecklistItem, deleteChecklistItem, saveChecklist, renderSidebarSliders, renderSettingsSliders, addNewSliderItem, deleteSliderItem, saveSlidersSettings, renderSettingsTradeTypes, addNewTradeType, deleteTradeType, saveTradeTypes, renderMyTradeTypes, addMyTradeType, deleteMyTradeType, saveMyTradeTypes, renderSettingsSituations, addPlaybookSituation, deletePlaybookSituation, savePlaybookSituations } from './settings.js';
import { openZoom, closeZoom, openOriginal, loadMoreUnassigned, assignImage, removeAssignedImage, deleteFileFromPC, loadImages, renderAssignedScreens } from './gallery.js';
import { getAIAdvice, analyzeChart, analyzeTagPatterns, openSOSModal, closeSOSModal, sendSOSMessage, sendDataChatMessage, renderAIAdviceUI, loadAIChatHistory, switchAITab, bookmarkAIChat, renderSavedAIChats, deleteSavedAI } from './ai.js';
import { setupOCRDrawing, loadLatestImageForOCR, saveVisualOCRSettings, editTicker, forceScan, updateBadgeUI, runOCR } from './ocr.js';
import { importFondexxReport, importPPROReport, importFondexxTrades } from './parsers.js';
import { renderPlaybook, addPlaybookSetup, editPlaybookSetup, savePlaybookSetup, deletePlaybookSetup, getPlaybookContext, getPlaybookForSituation, loadPlaybook } from './playbook.js';
import { loadLearnContent, renderLearnCache } from './learn.js';
import { renderAdminPanel } from './admin.js';

import { initTradesView, populateDateSelect, populateSymbolSelect, loadTradeChart } from './trades_view2.js';
import { connectGoogleDrive, syncDriveScreenshots, updateDriveUI, disconnectGoogleDrive, startDriveAutoSync } from './drive.js';
import { initPlaybookChart } from './playbook_chart.js';


// 2. ПРОКИДАННЯ ФУНКЦІЙ ДЛЯ HTML (window)
window.toggleRightSidebar = function() {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.getElementById('sidebar-toggle-btn');
    const isMobile = window.innerWidth <= 1024;
    if (isMobile) { if (window.toggleMobileSidebar) window.toggleMobileSidebar(); return; }
    if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        const desk = btn.querySelector('.sidebar-btn-desktop');
        if (desk) desk.innerHTML = '◂ Сховати';
        btn.style.color = 'var(--text-muted)';
    } else {
        sidebar.classList.add('collapsed');
        const desk = btn.querySelector('.sidebar-btn-desktop');
        if (desk) desk.innerHTML = '▸ Панель';
        btn.style.color = 'var(--accent)';
    }
    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 320);
};
window.getDefaultDayEntry = getDefaultDayEntry;
window.state = state;
window.toggleAuthMode = toggleAuthMode;
window.handleAuth = handleAuth;
window.logout = logout;
window.activateMentorMode = activateMentorMode;
window.openTeamManager = openTeamManager;
window.createNewTeam = createNewTeam;
window.switchAITab = switchAITab;
window.bookmarkAIChat = bookmarkAIChat;
window.renderSavedAIChats = renderSavedAIChats;
window.deleteSavedAI = deleteSavedAI;
window.moveTrader = moveTrader;
window.deleteTeam = deleteTeam;
window.deleteTraderProfile = deleteTraderProfile;
window.exportData = exportData;
window.importData = importData;
window.applyTheme = applyTheme;
window.saveThemeSettings = saveThemeSettings;
window.switchTab = switchTab;
window.toggleMobileSidebar = toggleMobileSidebar;
window.switchMainTab = switchMainTab;
window.scrollMainTabs = scrollMainTabs;
window.toggleMoreTabs = toggleMoreTabs;
window.toggleMobileMoreMenu = toggleMobileMoreMenu;
window.closeMobileMoreMenu = closeMobileMoreMenu;
window.shiftDate = shiftDate;
window.selectDateFromInput = selectDateFromInput;
window.saveEntry = saveEntry;
window.renderView = renderView;
window.selectDate = selectDate;
window.updateAutoFlags = updateAutoFlags;
window.toggleStatsDropdown = toggleStatsDropdown;
window.toggleTree = toggleTree;
window.toggleStatsFilter = toggleStatsFilter;
window.refreshStatsView = refreshStatsView;
window.closeStatsDropdown = closeStatsDropdown;
window.renderStatsSourceSelector = renderStatsSourceSelector;
window.selectStatsSource = selectStatsSource;
window.renderTradeTypeSelector = renderTradeTypeSelector;
window.selectTradeTypeFilter = selectTradeTypeFilter;
window.renderErrorsList = renderErrorsList;
window.addNewErrorType = addNewErrorType;
window.deleteErrorType = deleteErrorType;
window.renderChecklistDisplay = renderChecklistDisplay;
window.renderSettingsChecklist = renderSettingsChecklist;
window.addNewChecklistItem = addNewChecklistItem;
window.deleteChecklistItem = deleteChecklistItem;
window.saveChecklist = saveChecklist;
window.renderSidebarSliders = renderSidebarSliders;
window.renderSettingsSliders = renderSettingsSliders;
window.addNewSliderItem = addNewSliderItem;
window.deleteSliderItem = deleteSliderItem;
window.saveSlidersSettings = saveSlidersSettings;
window.openZoom = openZoom;
window.closeZoom = closeZoom;
window.openOriginal = openOriginal;
window.loadMoreUnassigned = loadMoreUnassigned;
window.assignImage = assignImage;
window.removeAssignedImage = removeAssignedImage;
window.deleteFileFromPC = deleteFileFromPC;
window.loadImages = loadImages;
window.renderAssignedScreens = renderAssignedScreens;
window.getAIAdvice = getAIAdvice;
window.analyzeChart = analyzeChart;
window.analyzeTagPatterns = analyzeTagPatterns;
window.renderPlaybook = renderPlaybook;
window.addPlaybookSetup = addPlaybookSetup;
window.editPlaybookSetup = editPlaybookSetup;
window.savePlaybookSetup = savePlaybookSetup;
window.deletePlaybookSetup = deletePlaybookSetup;
window.getPlaybookContext = getPlaybookContext;
window.loadLearnContent = loadLearnContent;
window.renderLearnCache = renderLearnCache;
window.renderAdminPanel = renderAdminPanel;

window.renderSessionPlaybook = function() {
    const container = document.getElementById('session-playbook-checks');
    if (!container) return;
    const playbook = state.appData.playbook || [];
    if (!playbook.length) { container.innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem;">Плейбук порожній</span>'; return; }
    const saved = state.appData.journal[state.selectedDateStr]?.sessionSetups || [];
    container.innerHTML = '';
    playbook.forEach((s) => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; padding:6px 8px; border-radius:6px; background:var(--bg-main); border:1px solid var(--border);';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = s.name;
        cb.checked = saved.includes(s.name);
        cb.addEventListener('change', () => window.saveSessionData());
        const span = document.createElement('span');
        span.style.fontSize = '0.9rem';
        span.textContent = s.name;
        label.appendChild(cb); label.appendChild(span);
        container.appendChild(label);
    });
};

window.saveSessionData = function() {
    if (!state.appData.journal[state.selectedDateStr]) return;
    const goal = document.getElementById('session-goal')?.value || '';
    const plan = document.getElementById('session-plan')?.value || '';
    const readiness = document.getElementById('session-readiness')?.value || 5;
    const setups = [...document.querySelectorAll('#session-playbook-checks input:checked')].map(cb => cb.value);
    state.appData.journal[state.selectedDateStr].sessionGoal = goal;
    state.appData.journal[state.selectedDateStr].sessionPlan = plan;
    state.appData.journal[state.selectedDateStr].sessionReadiness = parseInt(readiness);
    state.appData.journal[state.selectedDateStr].sessionSetups = setups;
    state.appData.journal[state.selectedDateStr].__detailsLoaded = true;
    import('./storage.js').then(m => m.saveToLocal());
};

// === SESSION MODAL ===
function getTodayEST() {
    const now = new Date();
    const estStr = now.toLocaleString('en-CA', { timeZone: 'America/New_York' });
    return estStr.split(',')[0];
}

function getHourEST() {
    const now = new Date();
    const estStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    return parseInt(estStr);
}

function isSessionTime() {
    const h = getHourEST();
    return h >= 3 && h < 7;
}

function renderSessionModalPlaybook() {
    const container = document.getElementById('sm-playbook-checks');
    if (!container) return;
    const playbook = state.appData.playbook || [];
    if (!playbook.length) { container.innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem;">Плейбук порожній</span>'; return; }
    const today = getTodayEST();
    const saved = state.appData.journal?.[today]?.sessionSetups || [];
    container.innerHTML = '';
    playbook.forEach(s => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; padding:6px 8px; border-radius:6px; background:var(--bg-main); border:1px solid var(--border);';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = s.name;
        cb.checked = saved.includes(s.name);
        const span = document.createElement('span');
        span.style.fontSize = '0.9rem';
        span.textContent = s.name;
        label.appendChild(cb); label.appendChild(span);
        container.appendChild(label);
    });
}

function fillSessionModalFromSaved() {
    const today = getTodayEST();
    const dayData = state.appData.journal?.[today] || {};
    const goalEl = document.getElementById('sm-goal');
    const planEl = document.getElementById('sm-plan');
    const readEl = document.getElementById('sm-readiness');
    const readValEl = document.getElementById('sm-readiness-val');
    if (goalEl) goalEl.value = dayData.sessionGoal || '';
    if (planEl) planEl.value = dayData.sessionPlan || '';
    const r = dayData.sessionReadiness || 5;
    if (readEl) readEl.value = r;
    if (readValEl) readValEl.textContent = r + '/10';
    const dateEl = document.getElementById('session-modal-date');
    if (dateEl) dateEl.textContent = '📅 ' + today;
    renderSessionModalPlaybook();
}

window.saveSessionModal = async function() {
    const today = getTodayEST();
    if (!state.appData.journal[today]) {
        state.appData.journal[today] = window.getDefaultDayEntry ? window.getDefaultDayEntry() : {};
    }
    state.appData.journal[today].sessionGoal = document.getElementById('sm-goal')?.value || '';
    state.appData.journal[today].sessionPlan = document.getElementById('sm-plan')?.value || '';
    state.appData.journal[today].sessionReadiness = parseInt(document.getElementById('sm-readiness')?.value) || 5;
    state.appData.journal[today].sessionSetups = [...document.querySelectorAll('#sm-playbook-checks input:checked')].map(cb => cb.value);
    state.appData.journal[today].sessionDone = true;
    state.appData.journal[today].__detailsLoaded = true;
    const { saveToLocal } = await import('./storage.js');
    await saveToLocal();
    if (state.selectedDateStr === today) {
        const goalEl = document.getElementById('session-goal');
        const planEl = document.getElementById('session-plan');
        const readEl = document.getElementById('session-readiness');
        if (goalEl) goalEl.value = state.appData.journal[today].sessionGoal;
        if (planEl) planEl.value = state.appData.journal[today].sessionPlan;
        if (readEl) readEl.value = state.appData.journal[today].sessionReadiness;
    }
    document.getElementById('session-modal').style.display = 'none';
};

window.snoozeSessionModal = function() {
    document.getElementById('session-modal').style.display = 'none';
    setTimeout(() => checkAndShowSessionModal(), 30 * 60 * 1000);
};

window.checkSessionModalReadiness = async function() {
    const goal = document.getElementById('sm-goal')?.value || '';
    const plan = document.getElementById('sm-plan')?.value || '';
    const readiness = document.getElementById('sm-readiness')?.value || 5;
    const setups = [...document.querySelectorAll('#sm-playbook-checks input:checked')].map(cb => cb.value);
    const resultEl = document.getElementById('sm-ai-result');
    resultEl.style.display = 'block';
    resultEl.textContent = '⏳ AI аналізує...';
    try {
        const { callGemini, getGeminiKeys } = await import('./ai.js');
        const _keys = getGeminiKeys();
        if (!_keys.length) { resultEl.textContent = '⚠️ Додайте Gemini API ключ у Налаштуваннях.'; return; }
        const today = getTodayEST();
        const recentDays = Object.entries(state.appData.journal)
            .filter(([d, v]) => d.match(/^\d{4}-\d{2}-\d{2}$/) && v.pnl !== null && v.pnl !== undefined)
            .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5)
            .map(([d, v]) => `${d}: PnL=${v.pnl}$, помилки=${(v.errors||[]).join(',') || 'немає'}`).join('\n');
        const prompt = `Початок дня. Ціль: ${goal || 'не вказана'}. План: ${plan || 'не вказаний'}. Сетапи: ${setups.join(', ') || 'не обрані'}. Готовність: ${readiness}/10.\n\nОстанні 5 сесій:\n${recentDays || 'немає даних'}\n\nДай коротке спостереження (3-4 речення).`;
        const res = await callGemini(_keys[0], {
            systemInstruction: { parts: [{ text: 'Ти досвідчений напарник-трейдер. Говориш коротко, по-людськи, українською.' }] },
            contents: [{ parts: [{ text: prompt }] }]
        });
        resultEl.style.background = 'rgba(139,92,246,0.08)';
        resultEl.style.border = '1px solid var(--accent)';
        resultEl.textContent = '';
        res.split('\n').forEach((line, i, arr) => {
            resultEl.appendChild(document.createTextNode(line));
            if (i < arr.length - 1) resultEl.appendChild(document.createElement('br'));
        });
    } catch(e) {
        resultEl.textContent = '⚠️ Помилка: ' + e.message;
    }
};

function checkAndShowSessionModal() {
    if (!state.USER_DOC_NAME) return;
    if (!isSessionTime()) return;
    const today = getTodayEST();
    if (state.appData.journal?.[today]?.sessionDone) return;
    fillSessionModalFromSaved();
    document.getElementById('session-modal').style.display = 'flex';
}

setInterval(checkAndShowSessionModal, 5 * 60 * 1000);
window._checkSessionModal = checkAndShowSessionModal;

window.checkSessionReadiness = async function() {
    const goal = document.getElementById('session-goal')?.value || '';
    const plan = document.getElementById('session-plan')?.value || '';
    const readiness = document.getElementById('session-readiness')?.value || 5;
    const setups = [...document.querySelectorAll('#session-playbook-checks input:checked')].map(cb => cb.value);
    const sliders = [];
    document.querySelectorAll('.slider-input').forEach(el => {
        const f = state.appData.settings.sliders?.find(p => p.id === el.getAttribute('data-id'));
        if (f) sliders.push(`${f.name}: ${el.value}/10`);
    });
    const resultEl = document.getElementById('session-ai-result');
    resultEl.style.display = 'block';
    resultEl.style.background = 'var(--bg-main)';
    resultEl.textContent = '⏳ AI аналізує...';
    try {
        const { callGemini, getGeminiKeys } = await import('./ai.js');
        const _keys = getGeminiKeys();
        if (!_keys.length) { resultEl.textContent = '⚠️ Додайте Gemini API ключ у Налаштуваннях.'; return; }
        const recentDays = Object.entries(state.appData.journal)
            .filter(([d, v]) => d.match(/^\d{4}-\d{2}-\d{2}$/) && v.pnl !== null && v.pnl !== undefined)
            .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5)
            .map(([d, v]) => `${d}: PnL=${v.pnl}$, помилки=${(v.errors||[]).join(',') || 'немає'}, готовність=${v.sessionReadiness || '-'}/10`)
            .join('\n');
        const prompt = `Початок дня. Ось мій стан і контекст:\nЦіль: ${goal || 'не вказана'}\nПлан: ${plan || 'не вказаний'}\nСетапи: ${setups.join(', ') || 'не обрані'}\nГотовність: ${readiness}/10\nСтан: ${sliders.join(', ')}\n\nОстанні 5 сесій:\n${recentDays || 'немає даних'}\n\nДай коротке спостереження (3-4 речення).`;
        const res = await callGemini(_keys[0], {
            systemInstruction: { parts: [{ text: 'Ти досвідчений напарник-трейдер. Говориш коротко, по-людськи, українською. Не командуєш і не лякаєш.' }] },
            contents: [{ parts: [{ text: prompt }] }]
        });
        resultEl.style.background = 'rgba(139,92,246,0.08)';
        resultEl.style.border = '1px solid var(--accent)';
        resultEl.textContent = '';
        res.split('\n').forEach((line, i, arr) => {
            resultEl.appendChild(document.createTextNode(line));
            if (i < arr.length - 1) resultEl.appendChild(document.createElement('br'));
        });
        if (!state.appData.journal[state.selectedDateStr]) state.appData.journal[state.selectedDateStr] = {};
        state.appData.journal[state.selectedDateStr].sessionAiResult = res;
        import('./storage.js').then(m => m.saveToLocal());
    } catch(e) {
        resultEl.textContent = '⚠️ Помилка: ' + e.message;
    }
};

window.openSOSModal = openSOSModal;
window.closeSOSModal = closeSOSModal;
window.sendSOSMessage = sendSOSMessage;
window.sendDataChatMessage = sendDataChatMessage;
window.renderAIAdviceUI = renderAIAdviceUI;
window.setupOCRDrawing = setupOCRDrawing;
window.loadLatestImageForOCR = loadLatestImageForOCR;
window.saveVisualOCRSettings = saveVisualOCRSettings;
window.editTicker = editTicker;
window.forceScan = forceScan;
window.updateBadgeUI = updateBadgeUI;
window.runOCR = runOCR;
window.importFondexxReport = importFondexxReport;
window.importPPROReport = importPPROReport;
window.importFondexxTrades = importFondexxTrades;
window.loadTradeChart = loadTradeChart;
window.populateDateSelect = populateDateSelect;
window.populateSymbolSelect = populateSymbolSelect;
window.renderTeamSidebar = renderTeamSidebar;
window.switchUser = switchUser;
window.openTeamSidebar = function() { document.getElementById('team-sidebar').classList.add('open'); document.getElementById('team-sidebar-backdrop').classList.add('visible'); };
window.closeTeamSidebar = function() { document.getElementById('team-sidebar').classList.remove('open'); document.getElementById('team-sidebar-backdrop').classList.remove('visible'); };
window.initSelectors = initSelectors;
window.activateMentorMode = activateMentorMode;
window.deactivateMentorMode = deactivateMentorMode;
window.applyAccessRights = applyAccessRights;
window.saveMentorComment = saveMentorComment;
window.showMigrationForm = showMigrationForm;
window.resetPassword = resetPassword;
window.showResetStep = showResetStep;
window.sendResetCode = sendResetCode;
window.verifyResetCode = verifyResetCode;
window.applyNewPassword = applyNewPassword;
window.addNewTradeType = addNewTradeType;
window.deleteTradeType = deleteTradeType;
window.saveTradeTypes = saveTradeTypes;
window.renderSettingsTradeTypes = renderSettingsTradeTypes;
window.renderMyTradeTypes = renderMyTradeTypes;
window.addMyTradeType = addMyTradeType;
window.deleteMyTradeType = deleteMyTradeType;
window.saveMyTradeTypes = saveMyTradeTypes;
window.renderSettingsSituations = renderSettingsSituations;
window.addPlaybookSituation = addPlaybookSituation;
window.deletePlaybookSituation = deletePlaybookSituation;
window.savePlaybookSituations = savePlaybookSituations;
window.getPlaybookForSituation = getPlaybookForSituation;
window.loadAIChatHistory = loadAIChatHistory;
window.savePrivateNote = savePrivateNote;
window.loadMonth = loadMonth;
window.connectGoogleDrive = connectGoogleDrive;
window.syncDriveScreenshots = syncDriveScreenshots;
window.updateDriveUI = updateDriveUI;
window.disconnectGoogleDrive = disconnectGoogleDrive;
window.loadBackgroundGallery = loadBackgroundGallery;

window.saveDaylossSetting = function() {
    const input = document.getElementById('setting-dayloss-limit');
    if (!input) return;
    const val = parseFloat(input.value);
    if (isNaN(val)) return;
    const yearEl = document.getElementById('year-select');
    const monthEl = document.getElementById('month-select');
    if (!yearEl || !monthEl) return;
    const mk = `${yearEl.value}-${String(parseInt(monthEl.value) + 1).padStart(2, '0')}`;
    if (!state.appData.settings.monthlyDayloss) state.appData.settings.monthlyDayloss = {};
    state.appData.settings.monthlyDayloss[mk] = val;
    saveToLocal().then(() => {
        if (window.renderView) window.renderView();
        import('./utils.js').then(m => m.showToast(`✅ Дейлос для ${mk} збережено: ${val}$`));
    });
};

// ─── Background helpers ───────────────────────────────────────────────────────

function _applyBackgroundUrl(url) {
    document.body.style.backgroundImage     = `url('${url}')`;
    document.body.style.backgroundSize      = 'cover';
    document.body.style.backgroundPosition  = 'center';
    document.body.style.backgroundAttachment = 'fixed';
}

function _applyPersistedBackground() {
    const url = state.appData?.activeBackground;
    if (!url) return;
    console.info('[BgPersist] Restoring background:', url);
    _applyBackgroundUrl(url);
}

window._handleBgImageUpload = async function(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';

    // Paint instantly via FileReader before upload completes.
    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        document.body.style.backgroundImage     = `url('${dataUrl}')`;
        document.body.style.backgroundSize      = 'cover';
        document.body.style.backgroundPosition  = 'center';
        document.body.style.backgroundAttachment = 'fixed';
    };
    reader.readAsDataURL(file);

    // Upload to Storage and persist URL to Firestore.
    try {
        const downloadURL = await uploadBackground(file, state.USER_DOC_NAME);
        console.info('[BgUpload] Persisted:', downloadURL);
        // Swap data-URL for the stable CDN URL.
        document.body.style.backgroundImage = `url('${downloadURL}')`;
        loadBackgroundGallery();
    } catch (err) {
        console.error('[BgUpload] Storage upload failed:', err);
    }
};

window._setActiveBackground = async function(url) {
    try {
        await setActiveBackground(url, state.USER_DOC_NAME);
        _applyBackgroundUrl(url);
        loadBackgroundGallery();
    } catch (err) {
        console.error('[BgGallery] setActive failed:', err);
    }
};

window._deleteBackground = async function(url) {
    try {
        const wasActive = state.appData.activeBackground === url;
        await deleteBackground(url, state.USER_DOC_NAME);
        if (wasActive) {
            document.body.style.backgroundImage = '';
            document.body.style.backgroundSize = '';
            document.body.style.backgroundPosition = '';
            document.body.style.backgroundAttachment = '';
        }
        loadBackgroundGallery();
    } catch (err) {
        console.error('[BgGallery] delete failed:', err);
    }
};
window.retryInitApp = function() { hideLoadingToast(); initializeApp(); };
window._debugDay = () => console.log(state.appData.journal[state.selectedDateStr]);

function hideLoadingToast() {
    const t = document.getElementById('_load-toast');
    if (t) { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }
}

// 3. СИНХРОНІЗАЦІЯ БАЗИ
function startLiveSync() {}

// 4. СЛУХАЧІ ПОДІЙ
document.addEventListener('click', function(e) {
    // .stats-bar-item is the wrapper class used in index.html for every
    // dropdown trigger+panel pair. Clicks inside any of them must NOT
    // close the open dropdown — only outside clicks should.
    if (!e.target.closest('.stats-bar-item')) {
        if (window.closeStatsDropdown) window.closeStatsDropdown();
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        document.getElementById('image-preview').style.display = 'none';
        closeSOSModal();
        const nameModal = document.getElementById('name-modal');
        if (nameModal) nameModal.style.display = 'none';
        if (window.closeStatsDropdown) window.closeStatsDropdown();
        if (document.getElementById('team-sidebar')?.classList.contains('open')) window.closeTeamSidebar();
        return;
    }
    const tag = e.target.tagName;
    const id = e.target.id;
    if (e.key === 'Enter') {
        if (id === 'auth-nick' || id === 'auth-pass' || id === 'auth-email') { handleAuth(); return; }
        if (id === 'reset-nick') { if (window.sendResetCode) window.sendResetCode(); return; }
        if (id === 'reset-code') { if (window.verifyResetCode) window.verifyResetCode(); return; }
        if (id === 'reset-new-pass' || id === 'reset-confirm-pass') { if (window.applyNewPassword) window.applyNewPassword(); return; }
        if (id === 'new-error-input') { if (window.addNewErrorType) window.addNewErrorType(); return; }
        if (['trade-pnl','trade-gross','trade-comm','trade-locates','trade-kf'].includes(id)) { if (window.saveEntry) window.saveEntry(); return; }
        if (id === 'new-team-name') { if (window.createNewTeam) window.createNewTeam(); return; }
        if (id === 'modal-fname' || id === 'modal-lname') { if (window.saveProfileName) window.saveProfileName(); return; }
        return;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowLeft') { shiftDate(-1); }
    if (e.key === 'ArrowRight') { shiftDate(1); }
});

// 5. МОДАЛКА ІМ'Я/ПРІЗВИЩЕ
window.saveProfileName = async function() {
    const fname = document.getElementById('modal-fname').value.trim();
    const lname = document.getElementById('modal-lname').value.trim();
    const errEl = document.getElementById('name-modal-error');
    if (!fname || !lname) {
        if (errEl) { errEl.textContent = "Введіть і ім'я, і прізвище!"; errEl.style.display = 'block'; }
        return;
    }
    if (errEl) errEl.style.display = 'none';
    try {
        const nick = state.USER_DOC_NAME.replace('_stats', '');
        const { error: profileError } = await supabase
            .from('profiles')
            .update({ first_name: fname, last_name: lname })
            .eq('nick', nick);
        if (profileError) throw profileError;

        const displayName = `${lname} ${fname} (${nick})`;
        let changed = false;
        for (let group in state.TEAM_GROUPS) {
            const arr = state.TEAM_GROUPS[group];
            const idx = arr.findIndex(t => t === nick || t.endsWith(`(${nick})`));
            if (idx > -1) { arr[idx] = displayName; changed = true; }
        }
        document.getElementById('name-modal').style.display = 'none';
        if (window.renderTeamSidebar) window.renderTeamSidebar();
    } catch(e) {
        if (errEl) { errEl.textContent = 'Помилка збереження: ' + e.message; errEl.style.display = 'block'; }
    }
};

// === ІНІЦІАЛІЗАЦІЯ ===

let _appInitialized = false;

// ─── TIMEOUT (10 s) ──────────────────────────────────────────────────────────
let _initTimeoutId = null;
function startInitTimeout() {
    _initTimeoutId = setTimeout(() => {
        console.warn('[DIAG] ⏱ Init timeout > 10 s');
        let t = document.getElementById('_load-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = '_load-toast';
            t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid var(--border);color:var(--text-main);padding:10px 20px;border-radius:8px;z-index:99999;font-size:0.9rem;transition:opacity 0.3s;text-align:center;';
            document.body.appendChild(t);
        }
        t.innerHTML = '⏱ Завантаження займає надто довго...';
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block;margin:8px auto 0;padding:6px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:0.9rem;';
        btn.textContent = '🔄 Повторити';
        btn.addEventListener('click', () => { location.reload(); });
        t.appendChild(btn);
        t.style.opacity = '1'; t.style.display = 'block';
    }, 10000);
}
function clearInitTimeout() { if (_initTimeoutId) { clearTimeout(_initTimeoutId); _initTimeoutId = null; } }

// ─── SPINNER ─────────────────────────────────────────────────────────────────
function showAuthSpinner() {
    const overlay = document.getElementById('auth-overlay');
    if (!overlay || document.getElementById('_auth-spinner')) return;
    const spinner = document.createElement('div');
    spinner.id = '_auth-spinner';
    spinner.style.cssText = 'margin-top:18px;color:var(--text-muted,#94a3b8);font-size:0.85rem;text-align:center;';
    spinner.innerHTML = '⏳ Перевірка сесії...';
    overlay.querySelector('.auth-card')?.appendChild(spinner);
}
function hideAuthSpinner() {
    document.getElementById('_auth-spinner')?.remove();
}

// ─── ЯДРО ІНІЦІАЛІЗАЦІЇ ───────────────────────────────────────────────────────
async function bootApp(user) {
    if (_appInitialized) return;
    _appInitialized = true;

    const nick = user.user_metadata?.nick || user.user_metadata?.display_name || user.email.split('@')[0];
    state.USER_DOC_NAME = `${nick}_stats`;
    state.CURRENT_VIEWED_USER = state.USER_DOC_NAME;
    state.myUserId = user.id || null;
    setCurrentViewedUserId(user.id || null);
    await resolveViewedUserId(state.CURRENT_VIEWED_USER);

    document.getElementById('auth-overlay').style.display = 'none';
    const errEl = document.getElementById('auth-error');
    if (errEl) errEl.style.display = 'none';

    startInitTimeout();
    try {
        await loadTeams();
        await loadMentorStatusForAccount();
        await initializeApp();

        if (window.renderTeamSidebar) window.renderTeamSidebar();
        if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
        if (window.renderSettingsTradeTypes) window.renderSettingsTradeTypes();
        if (window.renderSettingsSituations) window.renderSettingsSituations();
        if (window.applyAccessRights) window.applyAccessRights();
        if (window.loadAIChatHistory) window.loadAIChatHistory();

        // Перевіряємо роль адміна
        const { data: profileData } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .maybeSingle();
        if (profileData?.role === 'admin') {
            const adminBtn = document.getElementById('main-btn-admin');
            if (adminBtn) adminBtn.style.display = '';
            window.renderAdminPanel = renderAdminPanel;
        }

        _applyPersistedBackground();
        loadBackgroundGallery();
    } catch (e) {
        console.error('[INIT] Помилка ініціалізації:', e);
    } finally {
        clearInitTimeout();
        hideLoadingToast();
    }

    setupOCRDrawing();
    startLiveSync();
    startDriveAutoSync();
    syncDriveScreenshots(true);
    setTimeout(() => window._checkSessionModal?.(), 1500);
}

function showLoginScreen() {
    _appInitialized = false;
    state.USER_DOC_NAME = '';
    state.CURRENT_VIEWED_USER = '';
    state.myUserId = null;
    setCurrentViewedUserId(null);
    const overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.style.display = 'flex';
    loadTeams();
}

// ─── CLEAR CACHE ──────────────────────────────────────────────────────────────
window.clearAuthCache = async function() {
    try { await supabase.auth.signOut(); } catch (_) {}
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
};

// ─── КРОК 1: getSession() — синхронна перевірка кешованої сесії ──────────────
// Supabase зберігає токен у localStorage. getSession() читає його одразу,
// без мережевого запиту — тому додаток не зависає при перезавантаженні.
showAuthSpinner();

(async () => {
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (session?.user) {
            console.log('[AUTH] getSession: session found, booting app');
            await bootApp(session.user);
        } else {
            console.log('[AUTH] getSession: no session, showing login');
            showLoginScreen();
        }
    } catch (e) {
        console.error('[AUTH] getSession error:', e);
        showLoginScreen();
    } finally {
        hideAuthSpinner();
    }
})();

// ─── КРОК 2: onAuthStateChange — реагуємо на вхід/вихід після старту ─────────
// Не дублюємо bootApp якщо вже ініціалізовано через getSession.
// Обробляємо тільки SIGNED_IN (новий логін) та SIGNED_OUT (логаут).
supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user && !_appInitialized) {
        console.log('[AUTH] onAuthStateChange: SIGNED_IN');
        bootApp(session.user);
    }
    if (event === 'SIGNED_OUT') {
        console.log('[AUTH] onAuthStateChange: SIGNED_OUT');
        showLoginScreen();
    }
});
