import { supabase } from './supabase.js';
import { state } from './state.js';
import { loadDayDetails, wasDayRecentlySaved } from './storage.js';
import { createRealtimeEventGate, classifyRealtimeEvent } from './realtime_sync_core.js';

let channel = null;
let activeUserId = null;
let timer = null;
let initialized = false;
let subscriptionTask = Promise.resolve();
const accept = createRealtimeEventGate();

async function refresh(kind, payload = null) {
    if (kind === 'journal') {
        const tradeDate = payload?.new?.trade_date || payload?.old?.trade_date || '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
            if (wasDayRecentlySaved(tradeDate)) return;
            await loadDayDetails(tradeDate, state.myUserId, { force: true }).catch(() => {});
            if (document.getElementById('view-trades')?.classList.contains('active')) {
                window.populateSymbolSelect?.(tradeDate);
            }
        }
        window.renderTradesDatagrid?.();
        window.renderDashboardAI?.();
    } else {
        window.renderGrandmasterDashboard?.();
        window.renderTeamReport?.();
        window.loadLatestCoachInsight?.();
    }
    document.dispatchEvent(new CustomEvent('strum:realtime-synced', { detail: { kind } }));
}

function receive(payload, userId) {
    if (!accept(payload)) return;
    const kind = classifyRealtimeEvent(payload, userId);
    if (kind === 'ignore') return;
    clearTimeout(timer);
    timer = setTimeout(() => refresh(kind, payload), 250);
}

async function replaceSubscription(userId) {
    if (channel && activeUserId === userId) return;

    if (channel) {
        const previousChannel = channel;
        channel = null;
        activeUserId = null;
        await supabase.removeChannel(previousChannel);
    }

    if (!userId) {
        document.documentElement.dataset.realtime = 'offline';
        return;
    }

    const filter = `user_id=eq.${userId}`;
    const nextChannel = supabase
        .channel(`strum-user-${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'journal_days', filter },
            payload => receive({ ...payload, table: 'journal_days' }, userId))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_reviews', filter },
            payload => receive({ ...payload, table: 'daily_reviews' }, userId))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_coach_insights', filter },
            payload => receive({ ...payload, table: 'ai_coach_insights' }, userId));

    // Supabase requires all postgres_changes callbacks before subscribe().
    channel = nextChannel;
    activeUserId = userId;
    nextChannel.subscribe(status => {
        if (channel !== nextChannel) return;
        document.documentElement.dataset.realtime = status === 'SUBSCRIBED' ? 'online' : 'connecting';
    });
}

function subscribe(userId) {
    subscriptionTask = subscriptionTask
        .then(() => replaceSubscription(userId || null))
        .catch(error => {
            document.documentElement.dataset.realtime = 'offline';
            console.error('STRUM Realtime subscription failed:', error);
        });
    return subscriptionTask;
}

export function initRealtimeSync() {
    if (initialized) return;
    initialized = true;

    supabase.auth.onAuthStateChange((_event, session) => subscribe(session?.user?.id));
    supabase.auth.getSession().then(({ data }) => subscribe(data.session?.user?.id));
    window.addEventListener('beforeunload', () => {
        if (channel) supabase.removeChannel(channel);
    }, { once: true });
}
