import { showToast } from './utils.js';
import { loadPartials } from './partials.js';

const MAX_IMPORT_SIZE_MB = 35;
let dayFormDirty = false;
let offlineBanner = null;

function markBusy(button, duration = 900) {
    if (!button || button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    window.setTimeout(() => {
        delete button.dataset.busy;
    }, duration);
}

function setExternalLinkDefaults() {
    document.querySelectorAll('a[href^="http"]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (!href || href.startsWith(window.location.origin)) return;
        link.setAttribute('rel', 'noopener noreferrer');
        if (!link.getAttribute('target')) link.setAttribute('target', '_blank');
    });
}

function enhanceIconButtons() {
    document.querySelectorAll('button').forEach((button) => {
        if (button.getAttribute('aria-label')) return;
        const title = button.getAttribute('title');
        if (title) button.setAttribute('aria-label', title);
    });
}

function guardLargeImports() {
    document.querySelectorAll('input[type="file"]').forEach((input) => {
        input.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            const tooLarge = files.find((file) => file.size / 1024 / 1024 > MAX_IMPORT_SIZE_MB);
            if (!tooLarge) return;
            const sizeMb = tooLarge.size / 1024 / 1024;
            input.value = '';
            showToast(`Файл завеликий: ${tooLarge.name} (${sizeMb.toFixed(1)} MB). Ліміт ${MAX_IMPORT_SIZE_MB} MB.`);
        });
    });
}

function improveResetCodeInput() {
    const codeInput = document.getElementById('reset-code');
    if (!codeInput) return;
    codeInput.addEventListener('input', () => {
        codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    });
}

function trackDayFormChanges() {
    const sidebar = document.getElementById('form-sidebar');
    if (!sidebar) return;

    sidebar.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
        if (target.type === 'file') return;
        dayFormDirty = true;
    });

    document.getElementById('btn-save-day')?.addEventListener('click', () => {
        markBusy(document.getElementById('btn-save-day'), 1300);
        window.setTimeout(() => { dayFormDirty = false; }, 250);
    });

    window.addEventListener('beforeunload', (event) => {
        if (!dayFormDirty) return;
        event.preventDefault();
        event.returnValue = '';
    });
}

function addKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
        if (!isSave) return;
        event.preventDefault();
        if (typeof window.saveEntry === 'function') {
            markBusy(document.getElementById('btn-save-day'), 1300);
            window.saveEntry();
            dayFormDirty = false;
            showToast('День збережено');
        }
    });
}

function setNetworkState() {
    const offline = !navigator.onLine;
    document.body.classList.toggle('is-offline', offline);

    if (!offline) {
        offlineBanner?.remove();
        offlineBanner = null;
        return;
    }

    if (offlineBanner) return;
    offlineBanner = document.createElement('div');
    offlineBanner.className = 'offline-banner';
    offlineBanner.setAttribute('role', 'status');
    offlineBanner.textContent = 'Немає інтернету. Локальні зміни залишаться у браузері, синхронізація відновиться після підключення.';
    document.body.appendChild(offlineBanner);
}

function addLiveRegions() {
    ['auth-error', 'reset-error', 'reset-error-2', 'session-ai-result', 'sm-ai-result', 'ai-response'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    });
}

function activateAction(action, trigger, event = null) {
    if (!action) return false;

    const actions = {
        'auth-submit': () => window.handleAuth?.(),
        'auth-telegram': () => window.signInWithTelegram?.(),
        'auth-toggle-mode': () => window.toggleAuthMode?.(),
        'reset-send': () => window.sendResetCode?.(),
        'reset-verify': () => window.verifyResetCode?.(),
        'learn-refresh': () => window.loadLearnContent?.(),
        'left-sidebar-toggle': () => window.toggleLeftSidebar?.(),
        'mobile-sidebar-toggle': () => window.toggleMobileSidebar?.(),
        'mobile-more-toggle': () => window.toggleMobileMoreMenu?.(),
        'right-sidebar-toggle': () => window.toggleRightSidebar?.(),
        'team-sidebar-open': () => window.openTeamSidebar?.(),
        'zoom-close': () => window.closeZoom?.(event),
        'zoom-open-original': () => window.openOriginal?.(event),
        'mentor-comment-save': () => window.saveMentorComment?.(),
        'private-note-save': () => window.savePrivateNote?.(),
        'ai-advice': () => window.getAIAdvice?.(),
        'error-type-add': () => window.addNewErrorType?.(),
        'session-readiness-check': () => window.checkSessionReadiness?.(),
        'day-save': () => window.saveEntry?.(),
        'date-picker': () => {
            const input = document.getElementById('trade-date');
            if (input?.showPicker) input.showPicker();
            else input?.focus();
        },
        'date-shift': () => {
            const offset = Number(trigger?.dataset?.offset ?? 0);
            if (Number.isFinite(offset)) window.shiftDate?.(offset);
        },
        'settings-checklist-add': () => window.addNewChecklistItem?.(),
        'settings-checklist-save': () => window.saveChecklist?.(),
        'settings-slider-add': () => window.addNewSliderItem?.(),
        'settings-slider-save': () => window.saveSlidersSettings?.(),
        'my-trade-type-add': () => window.addMyTradeType?.(),
        'my-trade-type-save': () => window.saveMyTradeTypes?.(),
        'playbook-situation-add': () => window.addPlaybookSituation?.(),
        'playbook-situation-save': () => window.savePlaybookSituations?.(),
        'trade-type-add': () => window.addNewTradeType?.(),
        'trade-type-save': () => window.saveTradeTypes?.(),
        'theme-save': () => window.saveThemeSettings?.(),
        'dayloss-save': () => window.saveDaylossSetting?.(),
        'ocr-save': () => window.saveVisualOCRSettings?.(),
        'stats-dropdown': () => window.toggleStatsDropdown?.(trigger?.dataset?.dropdown || ''),
        'stats-compare-toggle': () => window.toggleStatsCompareMode?.(),
        'stats-compare-close': () => window.closeStatsCompareMode?.(),
        'review-request': () => window.submitReviewRequest?.(trigger?.dataset?.reviewType || ''),
        'ai-tab': () => window.switchAITab?.(trigger?.dataset?.aiTab || 'chat'),
        'data-chat-send': () => window.sendDataChatMessage?.(),
        'google-auth': () => window.handleAuthClick?.(),
        'google-logout': () => window.googleSheetsLogout?.(),
        'google-picker': () => window.openPicker?.(),
        'sheet-toggle-mapping': () => window.toggleMappingMode?.(trigger),
        'tag-search-toggle': () => window.toggleTagSearch?.(),
        'leader-screens': () => window.viewLeaderScreens?.(),
        'tag-search-run': () => window.runTagSearch?.(),
        'tag-search-clear': () => window.clearTagSearch?.(),
        'playbook-setup-add': () => window.addPlaybookSetup?.(),
        'drive-connect': () => window.connectGoogleDrive?.(),
        'drive-disconnect': () => window.disconnectGoogleDrive?.(),
        'export-data': () => window.exportData?.(),
        'file-picker': () => document.getElementById(trigger?.dataset?.target || '')?.click(),
        'logout': () => window.logout?.(),
        'admin-refresh': () => window.renderAdminPanel?.(),
        'team-manager-open': () => window.openTeamManager?.(),
        'profile-name-save': () => window.saveProfileName?.(),
        'session-modal-snooze': () => window.snoozeSessionModal?.(),
        'session-modal-check': () => window.checkSessionModalReadiness?.(),
        'session-modal-save': () => window.saveSessionModal?.(),
        'sos-open': () => window.openSOSModal?.(),
        'sos-close': () => window.closeSOSModal?.(),
        'sos-send': () => window.sendSOSMessage?.(),
        'team-sidebar-close': () => window.closeTeamSidebar?.(),
        'team-manager-close': () => {
            const modal = document.getElementById('team-manager-modal');
            if (modal) modal.style.display = 'none';
        },
        'team-manager-backdrop': () => {
            if (event?.target !== trigger) return;
            trigger.style.display = 'none';
        },
        'team-create': () => window.createNewTeam?.(),
        'team-delete': () => window.deleteTeam?.(trigger?.dataset?.teamName || ''),
        'team-move-trader': () => window.moveTrader?.(),
        'team-delete-trader': () => window.deleteTraderProfile?.(),
        'reset-step': () => {
            const step = Number(trigger?.dataset?.step ?? 0);
            window.showResetStep?.(Number.isFinite(step) ? step : 0);
        },
    };

    const fn = actions[action];
    if (!fn) return false;
    fn();
    return true;
}

function updateRangeOutput(input) {
    const outputId = input?.dataset?.output;
    if (!outputId) return false;
    const output = document.getElementById(outputId);
    if (!output) return false;
    output.textContent = `${input.value}${input.dataset.suffix || ''}`;
    return true;
}

function isThemeControl(target) {
    return target?.matches?.('input[name="theme"], input[name="font"], input[type="color"][id^="ct-"]');
}

function handleImportInput(event) {
    const target = event.target;
    const kind = target?.dataset?.import;
    if (!kind) return false;
    const handlers = {
        json: window.importData,
        fondexx: window.importFondexxReport,
        'fondexx-trades': window.importFondexxTrades,
        ppro: window.importPPROReport,
    };
    const fn = handlers[kind];
    if (typeof fn !== 'function') return false;
    const files = Array.from(target.files || []);
    if (files.length <= 1) {
        fn(event);
        return true;
    }

    files.forEach((file) => {
        fn({
            ...event,
            target: {
                files: [file],
                dataset: target.dataset,
                value: '',
            },
        });
    });
    target.value = '';
    showToast(`Запущено імпорт ${files.length} файлів`);
    return true;
}

function activateMainTab(trigger) {
    const tab = trigger?.dataset?.tab;
    if (!tab || typeof window.switchMainTab !== 'function') return false;
    window.switchMainTab(tab);
    if (trigger.classList?.contains('mobile-more-item')) window.closeMobileMoreMenu?.();
    return true;
}

function activateSidebarFormTab(trigger) {
    const tab = trigger?.dataset?.tab;
    if (!tab || typeof window.switchTab !== 'function') return false;
    window.switchTab(tab);
    return true;
}

function bindDeclarativeActions() {
    document.addEventListener('click', (event) => {
        const trigger = event.target?.closest?.('[data-action]');
        if (trigger && activateAction(trigger.dataset.action, trigger, event)) {
            event.preventDefault();
            return;
        }

        const tabTrigger = event.target?.closest?.('.sidebar-nav-item[data-tab], .mobile-nav-btn[data-tab], .mobile-more-item[data-tab], .dash-open-calendar-tab-btn[data-tab], .recent-trades-link[data-tab]');
        if (tabTrigger && activateMainTab(tabTrigger)) event.preventDefault();

        const formTabTrigger = event.target?.closest?.('.sidebar .tab-btn[data-tab]');
        if (formTabTrigger && activateSidebarFormTab(formTabTrigger)) event.preventDefault();
    });

    document.addEventListener('keydown', (event) => {
        if (event.target?.matches?.('[data-action="sos-input"]') && event.key === 'Enter') {
            event.preventDefault();
            window.sendSOSMessage?.();
            return;
        }

        if (event.target?.matches?.('[data-action="data-chat-input"]') && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            window.sendDataChatMessage?.();
            return;
        }

        if (event.key !== 'Enter' && event.key !== ' ') return;
        const trigger = event.target?.closest?.('[data-action]');
        if (trigger?.matches('[role="button"], button') && activateAction(trigger.dataset.action, trigger, event)) {
            event.preventDefault();
            return;
        }

        const tabTrigger = event.target?.closest?.('.sidebar-nav-item[data-tab], .mobile-nav-btn[data-tab], .mobile-more-item[data-tab], .dash-open-calendar-tab-btn[data-tab], .recent-trades-link[data-tab]');
        if (tabTrigger?.matches('button, [role="button"]') && activateMainTab(tabTrigger)) event.preventDefault();

        const formTabTrigger = event.target?.closest?.('.sidebar .tab-btn[data-tab]');
        if (formTabTrigger?.matches('button, [role="button"]') && activateSidebarFormTab(formTabTrigger)) event.preventDefault();
    });

    document.addEventListener('change', (event) => {
        const target = event.target;
        if (handleImportInput(event)) return;
        if (isThemeControl(target)) {
            window.applyTheme?.();
            return;
        }
        if (target?.matches?.('[data-action="date-select"]')) {
            window.selectDateFromInput?.(target.value);
            return;
        }
        if (target?.matches?.('[data-action="stats-equity-mode"]')) {
            window.toggleStatsEquityMode?.(target.checked, target.id === 'compare-stats-equity-advanced-toggle' ? 'compare' : 'main');
            return;
        }
        if (target?.matches?.('[data-action="trade-date-symbol-select"]')) {
            window.populateSymbolSelect?.(target.value);
        }
    });

    document.addEventListener('input', (event) => {
        const target = event.target;
        if (target?.matches?.('[data-action="tag-search-input"]')) {
            window.showTagSearchSuggestions?.(target);
            return;
        }
        if (isThemeControl(target)) {
            window.applyTheme?.();
            return;
        }
        if (target?.matches?.('input[type="range"][data-output]')) updateRangeOutput(target);
    });

    document.addEventListener('focusin', (event) => {
        const target = event.target;
        if (target?.matches?.('[data-action="tag-search-input"]')) window.showTagSearchSuggestions?.(target);
    });

    document.addEventListener('focusout', (event) => {
        if (!event.target?.matches?.('[data-action="tag-search-input"]')) return;
        window.setTimeout(() => {
            const suggestions = document.getElementById('tag-search-suggestions');
            if (suggestions) suggestions.style.display = 'none';
        }, 150);
    });

    document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!form?.matches?.('[data-action="sheet-mapping-form"]')) return;
        event.preventDefault();
        window.saveSheetMapping?.();
    });
}

async function initEnhancements() {
    await loadPartials();
    setExternalLinkDefaults();
    enhanceIconButtons();
    guardLargeImports();
    improveResetCodeInput();
    trackDayFormChanges();
    addKeyboardShortcuts();
    addLiveRegions();
    bindDeclarativeActions();
    setNetworkState();

    window.addEventListener('online', () => {
        setNetworkState();
        showToast('Інтернет знову є');
    });
    window.addEventListener('offline', setNetworkState);
    document.addEventListener('DOMContentLoaded', () => {
        setExternalLinkDefaults();
        enhanceIconButtons();
    });

    window.setTimeout(() => {
        if (window.renderView) window.renderView();
    }, 600);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEnhancements, { once: true });
} else {
    initEnhancements();
}
