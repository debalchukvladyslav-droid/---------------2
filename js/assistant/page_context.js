import { state } from '../state.js';

/** Build live page context for the journal assistant. */
export function buildPageContext() {
    const tab = detectActiveTab();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(state.selectedDateStr || '') ? state.selectedDateStr : null;
    const tradeKey = getActiveTradeKey();
    return {
        tab,
        date,
        tradeKey,
    };
}

function detectActiveTab() {
    const activeNav = document.querySelector('.sidebar-nav-item.active[data-tab], .mobile-nav-btn.active[data-tab]');
    if (activeNav?.dataset?.tab) return activeNav.dataset.tab;
    const activeView = document.querySelector('.view-content.active[id^="view-"]');
    if (activeView?.id) return activeView.id.replace(/^view-/, '');
    return null;
}

function getActiveTradeKey() {
    try {
        const getter = window.getActiveTradeContext;
        if (typeof getter === 'function') {
            const active = getter();
            if (active && typeof active === 'object') {
                return {
                    date: active.dateStr || active.date || null,
                    tradeIndex: Number.isFinite(Number(active.tradeIndex)) ? Number(active.tradeIndex) : null,
                    tradeId: active.tradeId || null,
                    ticker: active.ticker || active.symbol || null,
                };
            }
        }
    } catch {
        /* ignore */
    }
    return null;
}
