let authKeysReady = false;

export function initAuthKeyboardEvents() {
    if (authKeysReady) return;
    authKeysReady = true;
    document.addEventListener('keydown', (event) => {
        if (event.defaultPrevented || event.isComposing || event.key !== 'Enter'
            || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const handlers = {
            'auth-nick': 'handleAuth', 'auth-pass': 'handleAuth', 'auth-email': 'handleAuth',
            'auth-fname': 'handleAuth', 'auth-lname': 'handleAuth',
            'reset-nick': 'sendResetCode', 'reset-email': 'sendResetCode',
            'reset-code': 'verifyResetCode',
            'reset-new-pass': 'applyNewPassword', 'reset-confirm-pass': 'applyNewPassword',
        };
        const handler = handlers[event.target?.id];
        if (!handler || typeof window[handler] !== 'function') return;
        event.preventDefault();
        void window[handler]();
    });
}

export function initGlobalAppEvents({ shiftDate, closeSOSModal }) {
    document.addEventListener('click', (event) => {
        // .stats-bar-item wraps every dropdown trigger and panel pair.
        if (!event.target.closest('.stats-bar-item')) {
            if (window.closeStatsDropdown) window.closeStatsDropdown();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.defaultPrevented || event.isComposing) return;
        if (event.key === 'Escape') {
            const preview = document.getElementById('image-preview');
            if (preview) preview.style.display = 'none';
            closeSOSModal();
            const nameModal = document.getElementById('name-modal');
            if (nameModal) nameModal.style.display = 'none';
            if (window.closeStatsDropdown) window.closeStatsDropdown();
            if (document.getElementById('team-sidebar')?.classList.contains('open')) window.closeTeamSidebar();
            window.closeDashboardMentor?.();
            return;
        }

        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const tag = event.target.tagName;
        const id = event.target.id;
        if (event.key === 'Enter') {
            if (id === 'new-error-input') { window.addNewErrorType?.(); return; }
            if (['trade-pnl', 'trade-gross', 'trade-comm', 'trade-locates', 'trade-kf'].includes(id)) { window.saveEntry?.(); return; }
            if (id === 'new-team-name') { window.createNewTeam?.(); return; }
            if (id === 'modal-fname' || id === 'modal-lname') { window.saveProfileName?.(); return; }
            return;
        }

        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;
        // Trade arrows belong to the trade viewer; never also change its day.
        if (document.getElementById('view-trades')?.classList.contains('active')) return;
        if (event.key === 'ArrowLeft') shiftDate(-1);
        if (event.key === 'ArrowRight') shiftDate(1);
    });
}
