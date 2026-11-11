function editable(target) {
    return target?.isContentEditable || target?.matches?.('input,textarea,select,[contenteditable="true"]');
}

export function shortcutAction(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || editable(event.target)) return '';
    if (event.key === 'ArrowLeft') return 'previous-chart';
    if (event.key === 'ArrowRight') return 'next-chart';
    if (String(event.key || '').toLowerCase() === 'd') return 'toggle-density';
    return '';
}

function moveTrade(delta) {
    const pills = [...document.querySelectorAll('#trade-pill-nav .trade-pill:not([disabled])')];
    if (!pills.length) return false;
    const active = Math.max(0, pills.findIndex((item) => item.classList.contains('active')));
    pills[Math.max(0, Math.min(pills.length - 1, active + delta))]?.click();
    return true;
}

let shortcutsReady = false;
export function initTerminalShortcuts() {
    if (shortcutsReady) return;
    shortcutsReady = true;
    document.addEventListener('keydown', (event) => {
        const action = shortcutAction(event);
        if (!action) return;
        if (action === 'previous-chart' || action === 'next-chart') {
            if (document.getElementById('view-trades')?.classList.contains('active') && moveTrade(action === 'previous-chart' ? -1 : 1)) {
                event.preventDefault();
            }
        } else if (action === 'toggle-density') {
            document.body.classList.toggle('gm-dense-mode');
            document.body.classList.toggle('terminal-dense');
        }
    });
}
