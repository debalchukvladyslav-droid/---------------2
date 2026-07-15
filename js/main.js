// === js/main.js ===

// 1. ІМПОРТИ
import { supabase } from './supabase.js';
import { state } from './state.js';
import { getDefaultDayEntry } from './data_utils.js';
import { toggleAuthMode, handleAuth, logout, loadMentorStatusForAccount, activateMentorMode, deactivateMentorMode, applyAccessRights, saveMentorComment, savePrivateNote, loadPrivateNote, showResetStep, sendResetCode, verifyResetCode, applyNewPassword, resetPassword, showMigrationForm, canAccessMentorReviewQueue, mentorAcceptReviewRequest, ensureAuthUserProfile, rejectBlockedProfile, isPasswordRecoveryUrl, showPasswordRecoveryForm } from './auth.js';
import { loadTeams, openTeamManager, createNewTeam, moveTrader, deleteTeam, renameTeam, deleteTraderProfile, renderTeamSidebar, switchUser } from './teams.js';
import { saveToLocal, saveJournalData, saveSettings, markJournalDayDirty, markAllJournalDirty, initializeApp, resetRuntimeDataForAccountSwitch, exportData, importData, loadMonth, loadTradeDays, resolveViewedUserId, setCurrentViewedUserId,
         loadBackgroundGallery } from './storage.js';
import { applyTheme, saveThemeSettings, switchTab, toggleMobileSidebar, switchMainTab, scrollMainTabs, toggleMoreTabs, toggleMobileMoreMenu, closeMobileMoreMenu, bindMainTabRoutes, syncMainTabFromRoute, refreshCurrentMainTitle } from './ui.js';
import { shiftDate, selectDateFromInput, saveEntry, renderView, selectDate, updateAutoFlags, initSelectors, renderSidebarTradesList } from './calendar.js';
import { toggleStatsDropdown, toggleTree, toggleStatsFilter, refreshStatsView, closeStatsDropdown, renderStatsSourceSelector, selectStatsSource, renderTradeTypeSelector, selectTradeTypeFilter, toggleStatsEquityMode, toggleStatsCompareMode, closeStatsCompareMode, openStatsComparisonWithTrader } from './stats.js';
import { renderErrorsList, addNewErrorType, deleteErrorType, renderChecklistDisplay, renderSettingsChecklist, addNewChecklistItem, deleteChecklistItem, saveChecklist, renderSidebarSliders, renderSettingsSliders, addNewSliderItem, deleteSliderItem, saveSlidersSettings, renderSettingsTradeTypes, addNewTradeType, deleteTradeType, saveTradeTypes, renderMyTradeTypes, addMyTradeType, deleteMyTradeType, saveMyTradeTypes, renderSettingsSituations, addPlaybookSituation, deletePlaybookSituation, savePlaybookSituations } from './settings.js';
import { openZoom, closeZoom, openOriginal, zoomStep, loadMoreUnassigned, assignImage, removeAssignedImage, deleteFileFromPC, loadImages, renderAssignedScreens, disposeScreensView, openScreenshotForTrade, getStorageUrl } from './gallery.js';
import { getAIAdvice, analyzeChart, analyzeTagPatterns, openSOSModal, closeSOSModal, sendSOSMessage, sendDataChatMessage, renderAIAdviceUI, loadAIChatHistory, switchAITab, bookmarkAIChat, renderSavedAIChats, deleteSavedAI, applyAIQuickPrompt } from './ai.js';
import { cleanupUnusedAIRequests } from './ai/client.js';
import { setupOCRDrawing, loadLatestImageForOCR, saveVisualOCRSettings, editTicker, forceScan, updateBadgeUI, runOCR, enqueueOCR, enqueueBackgroundOCRForAllScreens, getOCRQueueStatus } from './ocr.js';
import { importFondexxReport, importPPROReport, importFondexxTrades, importFondexxSummaryByDate } from './parsers.js';
import { renderPlaybook, addPlaybookSetup, editPlaybookSetup, savePlaybookSetup, deletePlaybookSetup, getPlaybookContext, getPlaybookForSituation, loadPlaybook } from './playbook.js';
import { loadLearnContent, renderLearnCache } from './learn.js';
import { renderAdminPanel } from './admin.js';
import { initSidebarAccount, refreshSidebarAccount } from './sidebar_account.js';
import { initMentorReviewUI, refreshMentorReviewQueue, setMentorReviewNavBadges } from './mentor_review.js';

import { initTradesView, populateDateSelect, populateSymbolSelect, loadTradeChart, openTradesAtDayIndex } from './trades_view2.js';
import { initSheetTableView, saveSheetMapping } from './sheet_table.js';
import { renderTradesDatagrid, disposeTradesDatagrid, TRADE_TYPES } from './trades_datagrid.js';
import { initNotifications } from './notifications.js';
import { submitReviewRequest, refreshReviewRequestButtons } from './review_requests.js';
import { parseDecimalInput, showToast } from './utils.js';
import { connectGoogleDrive, syncDriveScreenshots, updateDriveUI, disconnectGoogleDrive, startDriveAutoSync, tryRestoreDriveToken } from './drive.js';
import { initPlaybookChart } from './playbook_chart.js';
import { renderDashboardNews, refreshDashboardNews, refreshLiveNewsModal, openLiveNewsModal, closeLiveNewsModal } from './news.js';
import { renderMarketSentiment, refreshMarketSentiment, openMarketSentimentSource } from './market_sentiment.js';
import { buildTradeTypeAIContext } from './trade_type_analysis.js';
import {
    createCompressedBackup,
    deleteCompressedBackup,
    downloadCompressedBackup,
    listCompressedBackups,
    refreshServerBackups,
    restoreCompressedBackup,
    restoreCompressedBackupEntry,
} from './backups.js';
import { loadPartials } from './partials.js';
import { applyPersistedBackground, initBackgroundControls } from './backgrounds.js';
import { initGlobalAppEvents } from './app_events.js';
import { showGlobalLoader, hideGlobalLoader } from './loading.js';
import { initOnboarding, startOnboardingTour, resetOnboardingRuntime } from './onboarding.js';
import { renderDashboardAI, refreshDashboardAI, toggleDashboardAIHistory, rotateDashboardAI, openDashboardMentor, closeDashboardMentor, sendDashboardMentorMessage, switchDashboardMentorTab } from './dashboard_ai.js';

let appShellPromise = null;
let appShellEventsReady = false;

await loadPartials(document.querySelector('[data-partial="partials/modals/auth-overlay.html"]'));

async function ensureAppShellLoaded() {
    if (!appShellPromise) {
        appShellPromise = (async () => {
            showGlobalLoader('app-shell', 'Завантаження інтерфейсу...');
            await loadPartials();
            initBackgroundControls();
            if (!appShellEventsReady) {
                initGlobalAppEvents({ shiftDate, closeSOSModal });
                appShellEventsReady = true;
            }
            document.dispatchEvent(new CustomEvent('app:shell-ready'));
            hideGlobalLoader('app-shell');
        })().catch((error) => {
            showGlobalLoader('app-shell', `Помилка інтерфейсу: ${error?.message || error}`, { type: 'error' });
            hideGlobalLoader('app-shell', 2800);
            appShellPromise = null;
            throw error;
        });
    }
    return appShellPromise;
}

// 2. ПРОКИДАННЯ ФУНКЦІЙ ДЛЯ HTML (window)
window.toggleRightSidebar = function() {
    const sidebar = document.getElementById('form-sidebar') || document.querySelector('.sidebar');
    const backdrop = document.getElementById('form-sidebar-backdrop');
    const btn = document.getElementById('sidebar-toggle-btn');
    const isMobile = window.innerWidth <= 1024;

    // On mobile, reuse mobile handler which also controls backdrop
    if (isMobile) {
        if (window.toggleMobileSidebar) window.toggleMobileSidebar();
        return;
    }

    if (!sidebar) return;

    const isCollapsed = sidebar.classList.contains('collapsed');
    if (isCollapsed) {
        sidebar.classList.remove('collapsed');
        if (backdrop) backdrop.classList.add('visible');
        const desk = btn?.querySelector('.sidebar-btn-desktop');
        if (desk) desk.innerHTML = '◂ Сховати';
        if (btn) btn.style.color = 'var(--text-muted)';
    } else {
        sidebar.classList.add('collapsed');
        if (backdrop) backdrop.classList.remove('visible');
        const desk = btn?.querySelector('.sidebar-btn-desktop');
        if (desk) desk.innerHTML = '▸ Панель';
        if (btn) btn.style.color = 'var(--accent)';
    }

    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 320);
};
window.getDefaultDayEntry = getDefaultDayEntry;
window.state = state;
window.startOnboardingTour = startOnboardingTour;
window.renderDashboardAI = renderDashboardAI;
window.refreshDashboardAI = refreshDashboardAI;
window.toggleDashboardAIHistory = toggleDashboardAIHistory;
window.rotateDashboardAI = rotateDashboardAI;
window.openDashboardMentor = openDashboardMentor;
window.closeDashboardMentor = closeDashboardMentor;
window.sendDashboardMentorMessage = sendDashboardMentorMessage;
window.switchDashboardMentorTab = switchDashboardMentorTab;

let manualSyncInProgress = false;
let manualSyncIntervalId = null;
const MANUAL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function runManualSyncStep(name, fn, options = {}) {
    const optional = options.optional !== false;
    if (typeof fn !== 'function') return { name, ok: true, skipped: true };
    try {
        await fn();
        return { name, ok: true };
    } catch (error) {
        if (!optional) throw error;
        console.warn(`[Manual sync] ${name}:`, error?.message || error);
        return { name, ok: false, error };
    }
}

async function manualSyncAll(trigger = null, options = {}) {
    if (manualSyncInProgress) return;
    manualSyncInProgress = true;
    const quiet = options.quiet === true;
    const btn = quiet ? null : (trigger || document.getElementById('manual-sync-btn'));
    const prevTitle = btn?.getAttribute('title') || '';
    if (btn) {
        btn.classList.add('is-syncing');
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('title', 'Синхронізація...');
    }

    if (!quiet) showToast('Синхронізація запущена...');
    try {
        const isOwnProfile = state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
        const steps = [
            await runManualSyncStep('backup', () => isOwnProfile ? createCompressedBackup({ reason: 'manual-sync', force: true, requireServer: true }) : null, { optional: false }),
            await runManualSyncStep('save-local', () => saveToLocal(), { optional: false }),
            await runManualSyncStep('load-trades', () => loadTradeDays()),
            await runManualSyncStep('drive-screenshots', () => isOwnProfile ? syncDriveScreenshots(true) : null),
            await runManualSyncStep('google-sheet', () => isOwnProfile ? window.refreshSheetMatchesAfterTradesImport?.({ quiet: true }) : null),
            await runManualSyncStep('background-ocr', () => isOwnProfile ? window.enqueueBackgroundOCRForAllScreens?.() : null),
            await runManualSyncStep('calendar-view', () => window.renderView?.()),
            await runManualSyncStep('screens-view', () => document.getElementById('view-screens')?.classList.contains('active') ? loadImages() : null),
            await runManualSyncStep('stats-view', () => document.getElementById('view-stats')?.classList.contains('active') ? refreshStatsView() : null),
            await runManualSyncStep('datagrid-view', () => document.getElementById('view-datagrid')?.classList.contains('active') ? renderTradesDatagrid() : null),
            await runManualSyncStep('mentor-review', () => canAccessMentorReviewQueue() ? refreshMentorReviewQueue() : null),
            await runManualSyncStep('dashboard-news', () => document.getElementById('view-dash')?.classList.contains('active') ? renderDashboardNews() : null),
            await runManualSyncStep('dashboard-ai', () => document.getElementById('view-dash')?.classList.contains('active') ? renderDashboardAI() : null),
            await runManualSyncStep('market-sentiment', () => document.getElementById('view-dash')?.classList.contains('active') ? renderMarketSentiment() : null),
            await runManualSyncStep('sidebar-account', () => refreshSidebarAccount()),
            await runManualSyncStep('drive-ui', () => updateDriveUI()),
        ];
        const failed = steps.filter((step) => step && !step.ok);
        if (!quiet) showToast(failed.length ? `Синхронізацію завершено, але ${failed.length} процес(и) пропущено/не вдалося.` : 'Синхронізацію завершено.');
    } finally {
        manualSyncInProgress = false;
        if (btn) {
            btn.classList.remove('is-syncing');
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.setAttribute('title', prevTitle || 'Синхронізувати все');
        }
    }
}

function startManualSyncScheduler() {
    stopManualSyncScheduler();
    const runScheduledSync = () => {
        if (!state.USER_DOC_NAME) return;
        void manualSyncAll(null, { quiet: true }).catch((error) => {
            console.warn('[Scheduled sync]', error?.message || error);
        });
    };
    runScheduledSync();
    manualSyncIntervalId = setInterval(runScheduledSync, MANUAL_SYNC_INTERVAL_MS);
}

function stopManualSyncScheduler() {
    if (!manualSyncIntervalId) return;
    clearInterval(manualSyncIntervalId);
    manualSyncIntervalId = null;
}

window.manualSyncAll = manualSyncAll;
window.refreshSidebarAccount = refreshSidebarAccount;
window.refreshMentorReviewQueue = refreshMentorReviewQueue;
window.setMentorReviewNavBadges = setMentorReviewNavBadges;
window.renderDashboardNews = renderDashboardNews;
window.refreshDashboardNews = refreshDashboardNews;
window.refreshLiveNewsModal = refreshLiveNewsModal;
window.openLiveNewsModal = openLiveNewsModal;
window.closeLiveNewsModal = closeLiveNewsModal;
window.renderMarketSentiment = renderMarketSentiment;
window.refreshMarketSentiment = refreshMarketSentiment;
window.openMarketSentimentSource = openMarketSentimentSource;
window.toggleAuthMode = toggleAuthMode;
window.handleAuth = handleAuth;
window.logout = logout;
window.activateMentorMode = activateMentorMode;
window.openTeamManager = openTeamManager;
window.createNewTeam = createNewTeam;
window.switchAITab = switchAITab;
window.applyAIQuickPrompt = applyAIQuickPrompt;
window.bookmarkAIChat = bookmarkAIChat;
window.renderSavedAIChats = renderSavedAIChats;
window.deleteSavedAI = deleteSavedAI;
window.moveTrader = moveTrader;
window.deleteTeam = deleteTeam;
window.renameTeam = renameTeam;
window.deleteTraderProfile = deleteTraderProfile;
window.exportData = exportData;
window.importData = importData;
window.applyTheme = applyTheme;
window.saveThemeSettings = saveThemeSettings;
window.switchTab = switchTab;
window.toggleMobileSidebar = toggleMobileSidebar;
window.switchMainTab = switchMainTab;
window.refreshCurrentMainTitle = refreshCurrentMainTitle;
window.scrollMainTabs = scrollMainTabs;
window.toggleMoreTabs = toggleMoreTabs;
window.toggleMobileMoreMenu = toggleMobileMoreMenu;
window.closeMobileMoreMenu = closeMobileMoreMenu;
bindMainTabRoutes();
window.shiftDate = shiftDate;
window.selectDateFromInput = selectDateFromInput;
window.saveEntry = saveEntry;
window.renderView = renderView;
window.selectDate = selectDate;
window.updateAutoFlags = updateAutoFlags;
window.toggleStatsDropdown = toggleStatsDropdown;
window.toggleTree = toggleTree;
// Ensure these functions are available on window for inline HTML handlers (modules scope may hide them)
window.toggleRightSidebar = window.toggleRightSidebar;
window.openTeamSidebar = window.openTeamSidebar;
window.closeTeamSidebar = window.closeTeamSidebar;
window.toggleStatsFilter = toggleStatsFilter;
window.refreshStatsView = refreshStatsView;
window.closeStatsDropdown = closeStatsDropdown;
window.renderStatsSourceSelector = renderStatsSourceSelector;
window.selectStatsSource = selectStatsSource;
window.renderTradeTypeSelector = renderTradeTypeSelector;
window.selectTradeTypeFilter = selectTradeTypeFilter;
window.toggleStatsEquityMode = toggleStatsEquityMode;
window.toggleStatsCompareMode = toggleStatsCompareMode;
window.closeStatsCompareMode = closeStatsCompareMode;
window.openStatsComparisonWithTrader = openStatsComparisonWithTrader;
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
window.zoomStep = zoomStep;
window.loadMoreUnassigned = loadMoreUnassigned;
window.assignImage = assignImage;
window.removeAssignedImage = removeAssignedImage;
window.deleteFileFromPC = deleteFileFromPC;
window.loadImages = loadImages;
window.renderAssignedScreens = renderAssignedScreens;
window.disposeScreensView = disposeScreensView;
window.openScreenshotForTrade = openScreenshotForTrade;
window.submitReviewRequest = submitReviewRequest;
window.refreshReviewRequestButtons = refreshReviewRequestButtons;
window.mentorAcceptReviewRequest = mentorAcceptReviewRequest;
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
    markJournalDayDirty(state.selectedDateStr);
    saveJournalData();
};

// === SESSION MODAL ===
let sessionModalSnoozeUntil = 0;

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
    markJournalDayDirty(today);
    await saveJournalData();
    if (state.selectedDateStr === today) {
        const goalEl = document.getElementById('session-goal');
        const planEl = document.getElementById('session-plan');
        const readEl = document.getElementById('session-readiness');
        if (goalEl) goalEl.value = state.appData.journal[today].sessionGoal;
        if (planEl) planEl.value = state.appData.journal[today].sessionPlan;
        if (readEl) readEl.value = state.appData.journal[today].sessionReadiness;
    }
    sessionModalSnoozeUntil = 0;
    document.getElementById('session-modal').style.display = 'none';
};

window.snoozeSessionModal = function() {
    sessionModalSnoozeUntil = Date.now() + 5 * 60 * 1000;
    document.getElementById('session-modal').style.display = 'none';
    setTimeout(() => checkAndShowSessionModal(), 5 * 60 * 1000);
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
        const today = getTodayEST();
        const recentDays = Object.entries(state.appData.journal)
            .filter(([d, v]) => d.match(/^\d{4}-\d{2}-\d{2}$/) && v.pnl !== null && v.pnl !== undefined)
            .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5)
            .map(([d, v]) => `${d}: PnL=${v.pnl}$, помилки=${(v.errors||[]).join(',') || 'немає'}`).join('\n');
        const tradeTypeContext = buildTradeTypeAIContext(state.appData.journal || {}, { tradeTypes: state.appData.tradeTypes, recentDays: 90, limit: 5 });
        const prompt = `Початок дня. Ціль: ${goal || 'не вказана'}. План: ${plan || 'не вказаний'}. Сетапи: ${setups.join(', ') || 'не обрані'}. Готовність: ${readiness}/10.\n\nОстанні 5 сесій:\n${recentDays || 'немає даних'}\n${tradeTypeContext}\n\nДай коротке спостереження (3-4 речення). Врахуй, які типи входу зараз тягнуть результат, а які краще фільтрувати.`;
        const res = await callGemini(getGeminiKeys()[0], {
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
    if (Date.now() < sessionModalSnoozeUntil) return;
    const today = getTodayEST();
    if (state.appData.journal?.[today]?.sessionDone) return;
    fillSessionModalFromSaved();
    document.getElementById('session-modal').style.display = 'flex';
}

setInterval(checkAndShowSessionModal, 5 * 60 * 1000);
window._checkSessionModal = checkAndShowSessionModal;

// === END-OF-SESSION REVIEW ===
let sessionReviewSnoozeUntil = 0;
let sessionReviewScreens = [];
let sessionReviewScreenIndex = 0;
let sessionReviewRenderToken = 0;
let sessionReviewReviewed = new Set();
let sessionReviewIncludesYesterday = false;

function isSessionReviewTime() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return minutes >= 16 * 60 + 30 && minutes <= 21 * 60;
}

function localDateKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function previousDateKey(dateKey) {
    const date = new Date(`${dateKey}T12:00:00`);
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function collectSessionReviewScreens(today, includeYesterday = false) {
    const meta = state.appData.screenMeta || {};
    const seen = new Set();
    const rows = [];
    const dates = includeYesterday ? [previousDateKey(today), today] : [today];
    dates.forEach((dateKey) => {
        const day = state.appData.journal?.[dateKey] || {};
        ['good', 'normal', 'bad', 'error'].forEach((category) => {
            (day.screenshots?.[category] || []).forEach((path) => {
                if (!path || seen.has(path)) return;
                const createdAt = meta[path]?.createdAt || meta[path]?.driveCreatedTime || '';
                if (createdAt && !dates.includes(localDateKey(createdAt))) return;
                seen.add(path);
                rows.push({ path, category, createdAt, date: dateKey });
            });
        });
    });
    (state.appData.unassignedImages || []).forEach((path) => {
        if (!path || seen.has(path)) return;
        const createdAt = meta[path]?.createdAt || meta[path]?.driveCreatedTime || '';
        const createdDate = localDateKey(createdAt);
        if (!createdAt || !dates.includes(createdDate)) return;
        seen.add(path);
        rows.push({ path, category: 'unassigned', createdAt, date: createdDate });
    });
    return rows.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
}

async function renderSessionReviewScreen() {
    const stage = document.getElementById('session-review-screen-stage');
    const progress = document.getElementById('session-review-screen-progress');
    const categories = document.getElementById('session-review-categories');
    if (!stage || !progress) return;
    const total = sessionReviewScreens.length;
    sessionReviewScreenIndex = total ? Math.max(0, Math.min(sessionReviewScreenIndex, total - 1)) : 0;
    progress.textContent = total ? `${sessionReviewScreenIndex + 1} / ${total} · перевірено ${sessionReviewReviewed.size}` : '0 / 0';
    if (categories) categories.hidden = !total;
    if (!total) { stage.innerHTML = '<p>Скріншотів за сьогодні немає</p>'; return; }
    const current = sessionReviewScreens[sessionReviewScreenIndex];
    categories?.querySelectorAll('[data-category]').forEach((button) => button.classList.toggle('active', button.dataset.category === current.category));
    const token = ++sessionReviewRenderToken;
    stage.innerHTML = '<p>Завантажую скріншот…</p>';
    try {
        const src = await getStorageUrl(current.path);
        if (token !== sessionReviewRenderToken) return;
        stage.textContent = '';
        const image = document.createElement('img'); image.src = src; image.alt = `Скріншот ${sessionReviewScreenIndex + 1}`; stage.appendChild(image);
    } catch {
        if (token === sessionReviewRenderToken) stage.innerHTML = '<p>Не вдалося завантажити скріншот</p>';
    }
}

window.stepSessionReviewScreen = function(direction = 1) {
    if (!sessionReviewScreens.length) return;
    sessionReviewScreenIndex = (sessionReviewScreenIndex + (Number(direction) < 0 ? -1 : 1) + sessionReviewScreens.length) % sessionReviewScreens.length;
    void renderSessionReviewScreen();
};

function setSessionReviewCategory(category) {
    if (!['good', 'normal', 'bad', 'error'].includes(category) || !sessionReviewScreens.length) return;
    const current = sessionReviewScreens[sessionReviewScreenIndex];
    const targetDate = current?.date || getTodayEST();
    if (!state.appData.journal[targetDate]) state.appData.journal[targetDate] = getDefaultDayEntry();
    const day = state.appData.journal[targetDate];
    if (!day || !current) return;
    if (!day.screenshots) day.screenshots = { good: [], normal: [], bad: [], error: [] };
    Object.keys(day.screenshots).forEach((key) => { if (Array.isArray(day.screenshots[key])) day.screenshots[key] = day.screenshots[key].filter((path) => path !== current.path); });
    if (Array.isArray(state.appData.unassignedImages)) state.appData.unassignedImages = state.appData.unassignedImages.filter((path) => path !== current.path);
    day.screenshots[category] = [...new Set([...(day.screenshots[category] || []), current.path])];
    current.category = category;
    sessionReviewReviewed.add(current.path);
    markJournalDayDirty(targetDate);
    void saveSettings();
    void renderSessionReviewScreen();
};

function openSessionReview() {
    const today = getTodayEST();
    if (!state.appData.journal[today]) state.appData.journal[today] = getDefaultDayEntry();
    const day = state.appData.journal[today];
    document.getElementById('session-review-date').textContent = `📅 ${today}`;
    document.getElementById('session-review-notes').value = day.notes || '';
    document.getElementById('session-review-improvement').value = day.nextSessionImprovement || '';
    sessionReviewIncludesYesterday = false;
    sessionReviewScreens = collectSessionReviewScreens(today, false);
    sessionReviewScreenIndex = 0;
    sessionReviewReviewed = new Set();
    const yesterdayButton = document.getElementById('session-review-yesterday-btn');
    const screensTitle = document.getElementById('session-review-screens-title');
    if (yesterdayButton) { yesterdayButton.classList.remove('active'); yesterdayButton.textContent = 'Посортувати вчорашні'; }
    if (screensTitle) screensTitle.textContent = 'Скріншоти за сьогодні';
    const categories = document.getElementById('session-review-categories');
    if (categories && !categories.dataset.bound) {
        categories.dataset.bound = 'true';
        categories.addEventListener('click', (event) => setSessionReviewCategory(event.target?.closest?.('[data-category]')?.dataset?.category || ''));
    }
    document.getElementById('session-review-modal').style.display = 'flex';
    void renderSessionReviewScreen();
}

window.toggleSessionReviewYesterday = function() {
    const today = getTodayEST();
    sessionReviewIncludesYesterday = !sessionReviewIncludesYesterday;
    sessionReviewScreens = collectSessionReviewScreens(today, sessionReviewIncludesYesterday);
    sessionReviewScreenIndex = 0;
    sessionReviewReviewed = new Set();
    const button = document.getElementById('session-review-yesterday-btn');
    const title = document.getElementById('session-review-screens-title');
    if (button) { button.classList.toggle('active', sessionReviewIncludesYesterday); button.textContent = sessionReviewIncludesYesterday ? 'Лише сьогоднішні' : 'Посортувати вчорашні'; }
    if (title) title.textContent = sessionReviewIncludesYesterday ? 'Скріншоти за сьогодні та вчора' : 'Скріншоти за сьогодні';
    void renderSessionReviewScreen();
};

window.openSessionReviewTest = function() {
    if (state.myRole !== 'admin') return;
    openSessionReview();
};

window.saveSessionReview = async function() {
    const today = getTodayEST();
    if (sessionReviewScreens.length && sessionReviewReviewed.size < sessionReviewScreens.length) {
        const nextIndex = sessionReviewScreens.findIndex((screen) => !sessionReviewReviewed.has(screen.path));
        if (nextIndex >= 0) sessionReviewScreenIndex = nextIndex;
        showToast(`Переглянь і класифікуй усі скріншоти: ${sessionReviewReviewed.size} із ${sessionReviewScreens.length}`);
        void renderSessionReviewScreen();
        return;
    }
    const day = state.appData.journal?.[today] || getDefaultDayEntry();
    day.notes = document.getElementById('session-review-notes')?.value || '';
    day.nextSessionImprovement = document.getElementById('session-review-improvement')?.value || '';
    day.sessionReviewDone = true;
    day.sessionReviewCompletedAt = new Date().toISOString();
    day.__detailsLoaded = true;
    state.appData.journal[today] = day;
    markJournalDayDirty(today);
    await saveJournalData();
    document.getElementById('session-review-modal').style.display = 'none';
    if (state.selectedDateStr === today) renderView();
};

window.snoozeSessionReview = function() {
    sessionReviewSnoozeUntil = Date.now() + 10 * 60 * 1000;
    document.getElementById('session-review-modal').style.display = 'none';
};

function checkAndShowSessionReview() {
    if (!state.USER_DOC_NAME || state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME || !isSessionReviewTime()) return;
    if (Date.now() < sessionReviewSnoozeUntil || document.body.classList.contains('onboarding-active')) return;
    const today = getTodayEST();
    if (state.appData.journal?.[today]?.sessionReviewDone) return;
    const modal = document.getElementById('session-review-modal');
    if (!modal || modal.style.display === 'flex') return;
    openSessionReview();
}

setInterval(checkAndShowSessionReview, 5 * 60 * 1000);
window._checkSessionReview = checkAndShowSessionReview;

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
        const recentDays = Object.entries(state.appData.journal)
            .filter(([d, v]) => d.match(/^\d{4}-\d{2}-\d{2}$/) && v.pnl !== null && v.pnl !== undefined)
            .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5)
            .map(([d, v]) => `${d}: PnL=${v.pnl}$, помилки=${(v.errors||[]).join(',') || 'немає'}, готовність=${v.sessionReadiness || '-'}/10`)
            .join('\n');
        const tradeTypeContext = buildTradeTypeAIContext(state.appData.journal || {}, { tradeTypes: state.appData.tradeTypes, recentDays: 90, limit: 5 });
        const prompt = `Початок дня. Ось мій стан і контекст:\nЦіль: ${goal || 'не вказана'}\nПлан: ${plan || 'не вказаний'}\nСетапи: ${setups.join(', ') || 'не обрані'}\nГотовність: ${readiness}/10\nСтан: ${sliders.join(', ')}\n\nОстанні 5 сесій:\n${recentDays || 'немає даних'}\n${tradeTypeContext}\n\nДай коротке спостереження (3-4 речення). Врахуй, на яких типах входу сьогодні краще робити акцент, а які не форсити.`;
        const res = await callGemini(getGeminiKeys()[0], {
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
        markJournalDayDirty(state.selectedDateStr);
        saveJournalData();
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
window.enqueueOCR = enqueueOCR;
window.enqueueBackgroundOCRForAllScreens = enqueueBackgroundOCRForAllScreens;
window.getOCRQueueStatus = getOCRQueueStatus;
window.importFondexxReport = importFondexxReport;
window.importFondexxSummaryByDate = importFondexxSummaryByDate;
window.importPPROReport = importPPROReport;
window.importFondexxTrades = importFondexxTrades;
window.loadTradeChart = loadTradeChart;
window.populateDateSelect = populateDateSelect;
window.populateSymbolSelect = populateSymbolSelect;
window.openTradesAtDayIndex = openTradesAtDayIndex;
window.renderSidebarTradesList = renderSidebarTradesList;
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
window.showPasswordRecoveryForm = showPasswordRecoveryForm;
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

function escapeBackupHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatBackupBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}

function formatBackupDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'unknown date';
    return d.toLocaleString('uk-UA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function renderSettingsBackups() {
    const host = document.getElementById('settings-backup-list');
    if (!host) return;
    const toggle = document.getElementById('settings-backup-toggle');
    const isHidden = localStorage.getItem('tj:settings-backups:hidden') !== '0';
    host.hidden = isHidden;
    if (toggle) toggle.textContent = isHidden ? 'Показати список' : 'Сховати список';
    const backups = listCompressedBackups();
    if (!backups.length) {
        host.innerHTML = '<p class="settings-copy-sm">Бекапів ще немає. Натисніть “Створити зараз” або запустіть синхронізацію.</p>';
        return;
    }

    const visibleCount = Math.max(4, Number(localStorage.getItem('tj:settings-backups:visible')) || 4);
    const visibleBackups = backups.slice(0, visibleCount);
    host.innerHTML = visibleBackups.map((backup) => `
        <article class="settings-backup-item">
            <div class="settings-backup-meta">
                <div class="settings-backup-name">${escapeBackupHtml(formatBackupDate(backup.createdAt))} · ${escapeBackupHtml(backup.reason || 'backup')}</div>
                <div class="settings-backup-sub">
                    ${escapeBackupHtml(backup.days || 0)} днів · ${escapeBackupHtml(formatBackupBytes(backup.storedBytes))} з ${escapeBackupHtml(formatBackupBytes(backup.rawBytes))} · ${escapeBackupHtml(backup.encoding || '')} · ${backup.serverBackedUp ? 'сервер' : 'локально'}
                </div>
            </div>
            <div class="settings-backup-actions">
                <button type="button" class="btn-secondary" data-action="backup-download" data-backup-id="${escapeBackupHtml(backup.id)}">Скачати</button>
                <button type="button" class="btn-secondary" data-action="backup-restore" data-backup-id="${escapeBackupHtml(backup.id)}">Відновити</button>
                <button type="button" class="btn-secondary" data-action="backup-delete" data-backup-id="${escapeBackupHtml(backup.id)}">Видалити</button>
            </div>
        </article>
    `).join('') + (visibleCount < backups.length ? `
        <button type="button" class="btn-secondary settings-backup-more">Показати ще</button>
    ` : '');
    host.querySelector('.settings-backup-more')?.addEventListener('click', () => {
        localStorage.setItem('tj:settings-backups:visible', String(visibleCount + 4));
        renderSettingsBackups();
    });
}

window.renderSettingsBackups = renderSettingsBackups;
window.toggleSettingsBackupList = function() {
    const host = document.getElementById('settings-backup-list');
    const nextHidden = !host?.hidden;
    localStorage.setItem('tj:settings-backups:hidden', nextHidden ? '1' : '0');
    if (!nextHidden) localStorage.setItem('tj:settings-backups:visible', '4');
    renderSettingsBackups();
};
window.refreshSettingsBackups = async function() {
    try {
        await refreshServerBackups();
        renderSettingsBackups();
    } catch (error) {
        console.warn('[Backups] server list failed:', error?.message || error);
    }
};
window.createSettingsBackup = async function() {
    try {
        await createCompressedBackup({ reason: 'manual', force: true, requireServer: true });
        renderSettingsBackups();
        showToast('Бекап створено');
    } catch (error) {
        console.error('[Backups] create failed', error);
        showToast('Не вдалося створити бекап: ' + (error?.message || error));
    }
};
window.downloadSettingsBackup = async function(id) {
    try {
        await downloadCompressedBackup(id);
    } catch (error) {
        showToast('Не вдалося скачати бекап: ' + (error?.message || error));
    }
};
window.deleteSettingsBackup = function(id) {
    if (!window.confirm('Видалити цей локальний бекап?')) return;
    deleteCompressedBackup(id);
    renderSettingsBackups();
    showToast('Бекап видалено');
};
window.restoreSettingsBackup = async function(id) {
    if (!window.confirm('Відновити журнал з цього бекапу? Поточні дані будуть замінені локально і збережені в Supabase.')) return;
    try {
        await createCompressedBackup({ reason: 'before-restore', force: true, requireServer: true });
        await restoreCompressedBackup(id);
        markAllJournalDirty();
        await saveToLocal();
        renderSettingsBackups();
        if (window.renderView) window.renderView();
        if (window.refreshStatsView) window.refreshStatsView();
        showToast('Бекап відновлено');
    } catch (error) {
        console.error('[Backups] restore failed', error);
        showToast('Не вдалося відновити бекап: ' + (error?.message || error));
    }
};

window.importSettingsBackup = async function(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const entry = JSON.parse(text);
        if (!window.confirm('Відновити журнал з backup-файлу? Поточні дані будуть замінені локально і збережені в Supabase.')) return;
        await createCompressedBackup({ reason: 'before-file-restore', force: true, requireServer: true });
        await restoreCompressedBackupEntry(entry);
        markAllJournalDirty();
        await saveToLocal();
        renderSettingsBackups();
        if (window.renderView) window.renderView();
        if (window.refreshStatsView) window.refreshStatsView();
        showToast('Backup-файл відновлено');
    } catch (error) {
        console.error('[Backups] file restore failed', error);
        showToast('Не вдалося імпортувати backup: ' + (error?.message || error));
    } finally {
        if (event?.target) event.target.value = '';
    }
};

function getCalendarMonthKey() {
    const yearEl = document.getElementById('cal-view-year');
    const monthEl = document.getElementById('cal-view-month');
    if (!yearEl || !monthEl) return new Date().toISOString().slice(0, 7);
    return `${yearEl.value}-${String(parseInt(monthEl.value, 10) + 1).padStart(2, '0')}`;
}

function ensureMonthlyDayloss() {
    if (!state.appData.settings) state.appData.settings = {};
    if (!state.appData.settings.monthlyDayloss || typeof state.appData.settings.monthlyDayloss !== 'object') {
        state.appData.settings.monthlyDayloss = {};
    }
    return state.appData.settings.monthlyDayloss;
}

function normalizeDaylossInput(value) {
    const parsed = parseDecimalInput(value);
    if (parsed === null || !Number.isFinite(parsed)) return null;
    return parsed > 0 ? -parsed : parsed;
}

function formatMonthLabel(monthKey) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return monthKey || '';
    return new Date(year, month - 1, 1).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
}

function getJournalMonthKeys() {
    const fromJournal = Object.keys(state.appData?.journal || {})
        .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
        .map((key) => key.slice(0, 7));
    const fromSettings = Object.keys(state.appData?.settings?.monthlyDayloss || {})
        .filter((key) => /^\d{4}-\d{2}$/.test(key));
    return [...new Set([...fromJournal, ...fromSettings, getCalendarMonthKey()])]
        .sort((a, b) => b.localeCompare(a));
}

function syncDaylossInputs(monthKey = null) {
    const selectedMonth = monthKey || document.getElementById('setting-dayloss-month')?.value || getCalendarMonthKey();
    const monthInput = document.getElementById('setting-dayloss-month');
    const daylossInput = document.getElementById('setting-dayloss-limit');
    const monthly = state.appData?.settings?.monthlyDayloss || {};
    const value = monthly[selectedMonth] ?? state.appData?.settings?.defaultDayloss ?? -100;
    if (monthInput) monthInput.value = selectedMonth;
    if (daylossInput) daylossInput.value = value;
}

function renderDaylossMonthsList() {
    const list = document.getElementById('settings-dayloss-months-list');
    if (!list) return;
    const months = getJournalMonthKeys();
    const monthly = state.appData?.settings?.monthlyDayloss || {};
    if (!months.length) {
        list.innerHTML = '<p class="settings-copy-sm">Місяців з даними ще немає.</p>';
        return;
    }
    list.innerHTML = months.map((monthKey) => `
        <label class="settings-dayloss-month-item">
            <span>${escapeBackupHtml(formatMonthLabel(monthKey))}</span>
            <input type="number" step="1" value="${escapeBackupHtml(monthly[monthKey] ?? '')}" placeholder="${escapeBackupHtml(state.appData?.settings?.defaultDayloss ?? -100)}" data-dayloss-month="${escapeBackupHtml(monthKey)}">
        </label>
    `).join('');
}

window.renderDaylossSettings = function() {
    syncDaylossInputs();
    renderDaylossMonthsList();
};

window.toggleDaylossMonthsPanel = function() {
    const panel = document.getElementById('settings-dayloss-months-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderDaylossMonthsList();
};

window.saveDaylossSetting = function() {
    const input = document.getElementById('setting-dayloss-limit');
    const monthInput = document.getElementById('setting-dayloss-month');
    if (!input) return;
    const val = normalizeDaylossInput(input.value);
    if (val === null) {
        showToast('Введіть коректний дейлос');
        return;
    }
    const mk = monthInput?.value || getCalendarMonthKey();
    ensureMonthlyDayloss()[mk] = val;
    saveToLocal().then(() => {
        syncDaylossInputs(mk);
        renderDaylossMonthsList();
        if (window.renderView) window.renderView();
        showToast(`Дейлос для ${mk} збережено: ${val}$`);
    });
};

window.saveAllDaylossMonths = function() {
    const inputs = Array.from(document.querySelectorAll('[data-dayloss-month]'));
    const monthly = ensureMonthlyDayloss();
    let saved = 0;
    for (const input of inputs) {
        const monthKey = input.dataset.daylossMonth;
        const raw = String(input.value || '').trim();
        if (!raw) {
            delete monthly[monthKey];
            continue;
        }
        const val = normalizeDaylossInput(raw);
        if (val === null) continue;
        monthly[monthKey] = val;
        input.value = val;
        saved++;
    }
    saveToLocal().then(() => {
        syncDaylossInputs();
        renderDaylossMonthsList();
        if (window.renderView) window.renderView();
        showToast(`Дейлоси збережено: ${saved}`);
    });
};

window.retryInitApp = function() { hideLoadingToast(); initializeApp(); };
window._debugDay = () => console.log(state.appData.journal[state.selectedDateStr]);

function hideLoadingToast() {
    const t = document.getElementById('_load-toast');
    if (t) { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }
}

// 3. СИНХРОНІЗАЦІЯ БАЗИ
function startLiveSync() {}

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
        if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
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
    resetRuntimeDataForAccountSwitch();

    let { data: bootProfile, error: bootProfileError } = await supabase
        .from('profiles')
        .select('nick, role, mentor_enabled, settings')
        .eq('id', user.id)
        .maybeSingle();
    if (bootProfileError) console.warn('[AUTH] Could not load profile nick:', bootProfileError);

    if (!bootProfile?.nick) {
        try {
            await ensureAuthUserProfile(user);
            const refetched = await supabase
                .from('profiles')
                .select('nick, role, mentor_enabled, settings')
                .eq('id', user.id)
                .maybeSingle();
            bootProfile = refetched.data;
        } catch (e) {
            console.error('[AUTH] ensureAuthUserProfile:', e);
        }
    }

    if (await rejectBlockedProfile(bootProfile)) {
        _appInitialized = false;
        hideAuthSpinner();
        return;
    }

    const nick =
        bootProfile?.nick ||
        user.user_metadata?.nick ||
        user.user_metadata?.display_name ||
        (user.email ? user.email.split('@')[0] : '') ||
        'user';
    state.myRole = bootProfile?.role || 'trader';
    state.IS_MENTOR_MODE = !!(bootProfile?.mentor_enabled || bootProfile?.role === 'mentor');
    state.authProvider =
        (bootProfile?.settings && typeof bootProfile.settings === 'object' && bootProfile.settings.auth_provider) ||
        user.app_metadata?.provider ||
        'email';
    state.USER_DOC_NAME = `${nick}_stats`;
    state.CURRENT_VIEWED_USER = state.USER_DOC_NAME;
    state.myUserId = user.id || null;
    setCurrentViewedUserId(user.id || null);
    await resolveViewedUserId(state.CURRENT_VIEWED_USER);

    startInitTimeout();
    try {
        await ensureAppShellLoaded();
        initNotifications();

        document.getElementById('auth-overlay').style.display = 'none';
        const errEl = document.getElementById('auth-error');
        if (errEl) errEl.style.display = 'none';

        await loadTeams();
        await loadMentorStatusForAccount();
        await initializeApp();

        if (canAccessMentorReviewQueue()) {
            document.querySelectorAll('.mentor-review-nav-item').forEach((el) => {
                el.classList.remove('initially-hidden');
            });
            initMentorReviewUI();
            setTimeout(() => {
                void refreshMentorReviewQueue();
            }, 2800);
        }

        if (window.renderTeamSidebar) window.renderTeamSidebar();
        initSidebarAccount();
        if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
        if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
        if (window.renderSettingsTradeTypes) window.renderSettingsTradeTypes();
        if (window.renderSettingsSituations) window.renderSettingsSituations();
        if (window.applyAccessRights) window.applyAccessRights();
        syncMainTabFromRoute();
        if (window.loadAIChatHistory) window.loadAIChatHistory();
        if (window.renderDashboardNews) void window.renderDashboardNews();
        void renderDashboardAI();
        if (window.renderMarketSentiment) void window.renderMarketSentiment();
        cleanupUnusedAIRequests();

        applyPersistedBackground();
        loadBackgroundGallery();
    } catch (e) {
        console.error('[INIT] Помилка ініціалізації:', e);
    } finally {
        clearInitTimeout();
        hideLoadingToast();
    }

    setupOCRDrawing();
    startLiveSync();
    await tryRestoreDriveToken();
    if (window.updateDriveUI) window.updateDriveUI();
    startDriveAutoSync();
    startManualSyncScheduler();
    initOnboarding({ user, saveSettings, switchMainTab });
    setTimeout(() => window._checkSessionModal?.(), 1500);
    setTimeout(() => window._checkSessionReview?.(), 1800);
}

function resetRouteForLoginScreen() {
    if (!window.history?.replaceState || isPasswordRecoveryUrl()) return;
    const cleanPath = '/';
    if (window.location.pathname === cleanPath && !window.location.search && !window.location.hash) return;
    window.history.replaceState({}, '', cleanPath);
}

function showLoginScreen() {
    _appInitialized = false;
    stopManualSyncScheduler();
    resetOnboardingRuntime();
    resetRouteForLoginScreen();
    resetRuntimeDataForAccountSwitch();
    state.USER_DOC_NAME = '';
    state.CURRENT_VIEWED_USER = '';
    state.myUserId = null;
    state.myRole = 'trader';
    state.IS_MENTOR_MODE = false;
    state.authProvider = 'email';
    setCurrentViewedUserId(null);
    const overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.style.display = 'flex';
    document.querySelectorAll('.mentor-review-nav-item').forEach((el) => {
        el.classList.add('initially-hidden');
    });
    document.querySelectorAll('.admin-nav-item, .admin-tab-mobile').forEach((el) => {
        el.classList.add('initially-hidden');
    });
    setMentorReviewNavBadges(0);
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
        const isRecovery = isPasswordRecoveryUrl();
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (session?.user) {
            console.log('[AUTH] getSession: session found, booting app');
            await bootApp(session.user);
            if (isRecovery) showPasswordRecoveryForm();
        } else {
            console.log('[AUTH] getSession: no session, showing login');
            showLoginScreen();
            if (isRecovery) showPasswordRecoveryForm();
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
    if (event === 'PASSWORD_RECOVERY') {
        console.log('[AUTH] onAuthStateChange: PASSWORD_RECOVERY');
        if (session?.user && !_appInitialized) {
            bootApp(session.user).then(() => showPasswordRecoveryForm());
        } else {
            showPasswordRecoveryForm();
        }
        return;
    }
    if (event === 'SIGNED_IN' && session?.user && !_appInitialized) {
        console.log('[AUTH] onAuthStateChange: SIGNED_IN');
        bootApp(session.user);
    }
    if (event === 'SIGNED_OUT') {
        console.log('[AUTH] onAuthStateChange: SIGNED_OUT');
        showLoginScreen();
    }
});

window.appendReviewTag = function (chunk) {
    const ta = document.getElementById('trade-notes');
    const t = String(chunk || '').trim();
    if (!ta) {
        showToast('Відкрийте панель дня (кнопка +)');
        return;
    }
    if (!t) return;
    const needle = t.toLowerCase();
    const cur = String(ta.value || '');
    if (cur.toLowerCase().includes(needle)) {
        showToast('Такий тег уже є в нотатках');
        return;
    }
    ta.value = cur ? `${cur.trimEnd()} ${t}` : t;
    if (window.switchTab) window.switchTab('tab-mind');
    const sb = document.getElementById('form-sidebar');
    if (sb?.classList.contains('collapsed') && window.toggleRightSidebar) window.toggleRightSidebar();
    ta.focus();
    showToast('Додано. Натисніть «Зберегти день».');
};

initTradesView();
initNotifications();
initSheetTableView({ deferGoogleRestore: true });
window.initSheetTableView = initSheetTableView;
window.saveSheetMapping = saveSheetMapping;
window.renderTradesDatagrid = renderTradesDatagrid;
window.disposeTradesDatagrid = disposeTradesDatagrid;
window.TRADE_TYPES = TRADE_TYPES;
