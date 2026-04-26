export function initGlobalAppEvents({ shiftDate, closeSOSModal }) {
    document.addEventListener('click', (event) => {
        // .stats-bar-item wraps every dropdown trigger and panel pair.
        if (!event.target.closest('.stats-bar-item')) {
            if (window.closeStatsDropdown) window.closeStatsDropdown();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            document.getElementById('image-preview').style.display = 'none';
            closeSOSModal();
            const nameModal = document.getElementById('name-modal');
            if (nameModal) nameModal.style.display = 'none';
            if (window.closeStatsDropdown) window.closeStatsDropdown();
            if (document.getElementById('team-sidebar')?.classList.contains('open')) window.closeTeamSidebar();
            return;
        }

        const tag = event.target.tagName;
        const id = event.target.id;
        if (event.key === 'Enter') {
            if (id === 'auth-nick' || id === 'auth-pass' || id === 'auth-email') { window.handleAuth?.(); return; }
            if (id === 'reset-nick') { window.sendResetCode?.(); return; }
            if (id === 'reset-code') { window.verifyResetCode?.(); return; }
            if (id === 'reset-new-pass' || id === 'reset-confirm-pass') { window.applyNewPassword?.(); return; }
            if (id === 'new-error-input') { window.addNewErrorType?.(); return; }
            if (['trade-pnl', 'trade-gross', 'trade-comm', 'trade-locates', 'trade-kf'].includes(id)) { window.saveEntry?.(); return; }
            if (id === 'new-team-name') { window.createNewTeam?.(); return; }
            if (id === 'modal-fname' || id === 'modal-lname') { window.saveProfileName?.(); return; }
            return;
        }

        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (event.key === 'ArrowLeft') shiftDate(-1);
        if (event.key === 'ArrowRight') shiftDate(1);
    });
}
