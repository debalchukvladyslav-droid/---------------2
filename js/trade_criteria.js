import { state } from './state.js';
import { supabase } from './supabase.js';
import { markJournalDayDirty, saveJournalData } from './storage.js';
import { hasExactEntryTime, presentSnapshot, snapshotIsFrozen } from '../lib/massive_criteria.js';

const attempted = new Set();
const queue = [];
let draining = false;
const BLOCK_KEY = 'tj_criteria_not_synced_v1';

function blockedKeys() {
    try {
        const stored = JSON.parse(sessionStorage.getItem(BLOCK_KEY) || '[]');
        return new Set(Array.isArray(stored) ? stored : []);
    } catch {
        return new Set();
    }
}

function blockKey(key) {
    const keys = blockedKeys();
    keys.add(key);
    sessionStorage.setItem(BLOCK_KEY, JSON.stringify([...keys].slice(-500)));
}

function ownJournal() {
    return state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
}

function tradeKey(dateStr, trade) {
    return `${dateStr}|${trade?.id || ''}|${trade?.symbol || ''}|${trade?.opened || ''}`;
}

export function criteriaSnapshotOf(trade) {
    const raw = trade?.criteriaSnapshot;
    if (!raw || typeof raw !== 'object') return null;
    return presentSnapshot(raw);
}

async function authToken() {
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
    return session.access_token;
}

function projectMarketCriteria(trade, snapshot) {
    const previous = trade.marketCriteria && typeof trade.marketCriteria === 'object' ? trade.marketCriteria : {};
    trade.marketCriteria = {
        shs_float: previous.shs_float ?? null,
        shs_float_display: previous.shs_float_display || '',
        shs_float_raw: previous.shs_float_raw || '',
        vol_pre_by_minute: previous.vol_pre_by_minute || {},
        atr: snapshot.atr14,
        avg_vol: snapshot.avgVol14,
        vol: snapshot.dayVolume,
        vol_play: snapshot.volPlay14,
        atr_play: snapshot.atrPlay14,
        high: snapshot.high,
        low: snapshot.low,
        provider: 'massive',
        source: 'massive',
        as_of_entry: snapshot.entryAt,
        updated_at: snapshot.calculatedAt,
        source_errors: snapshot.fetchStatus === 'ok' ? {} : { massive: snapshot.statusDetail || snapshot.display?.fetchStatus || '' },
    };
}

async function persistSnapshot(dateStr, trade, snapshot) {
    trade.criteriaSnapshot = snapshot;
    projectMarketCriteria(trade, snapshot);
    markJournalDayDirty(dateStr);
    await saveJournalData({ skipEmbedding: true });
}

export async function ensureTradeCriteria(dateStr, trade, { manual = false, highLowSessionStart, volumeSessionStart } = {}) {
    if (!ownJournal() || !trade) return null;
    const ticker = String(trade.symbol || trade.ticker || '').trim().toUpperCase();
    const opened = trade.opened || trade.entryTime || trade.time || '';
    if (!ticker || !trade.id || !hasExactEntryTime(opened)) return null;
    const key = tradeKey(dateStr, trade);
    const current = criteriaSnapshotOf(trade);
    if (!manual && (snapshotIsFrozen(current) || attempted.has(key) || blockedKeys().has(key))) return current;
    attempted.add(key);
    try {
        const response = await fetch('/api/trade-criteria', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${await authToken()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                tradeId: trade.id,
                tradeDate: dateStr,
                ticker,
                opened,
                manual,
                highLowSessionStart,
                volumeSessionStart,
            }),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 409 || payload?.reason === 'not-synced') {
            if (!manual) blockKey(key);
            else attempted.delete(key);
            return null;
        }
        if (!response.ok || !payload.snapshot) throw new Error(payload.error || `HTTP ${response.status}`);
        const snapshot = presentSnapshot(payload.snapshot);
        if (!payload.reused || !current) await persistSnapshot(dateStr, trade, snapshot);
        return snapshot;
    } catch (error) {
        console.warn('[trade-criteria]', ticker, error?.message || error);
        if (manual) attempted.delete(key);
        throw error;
    }
}

function drain() {
    if (draining) return;
    draining = true;
    const step = () => {
        const job = queue.shift();
        if (!job) {
            draining = false;
            return;
        }
        ensureTradeCriteria(job.dateStr, job.trade).catch(() => {}).finally(step);
    };
    step();
}

export function scheduleCriteriaForDates(dates = []) {
    if (!ownJournal()) return;
    const journal = state.appData?.journal || {};
    const blocked = blockedKeys();
    dates.forEach((dateStr) => {
        const trades = journal[dateStr]?.trades;
        if (!Array.isArray(trades)) return;
        trades.forEach((trade) => {
            if (criteriaSnapshotOf(trade) && snapshotIsFrozen(criteriaSnapshotOf(trade))) return;
            const key = tradeKey(dateStr, trade);
            if (attempted.has(key) || blocked.has(key)) return;
            queue.push({ dateStr, trade });
        });
    });
    drain();
}

export async function loadStoredCriteria(dateStr, trade) {
    const current = criteriaSnapshotOf(trade);
    if (current || !trade?.id || !ownJournal()) return current;
    try {
        const response = await fetch(`/api/trade-criteria?tradeId=${encodeURIComponent(trade.id)}&tradeDate=${encodeURIComponent(dateStr)}`, {
            headers: { Authorization: `Bearer ${await authToken()}` },
        });
        const payload = await response.json().catch(() => ({}));
        const snapshot = payload.snapshots?.[0] ? presentSnapshot(payload.snapshots[0]) : null;
        if (!snapshot) return null;
        await persistSnapshot(dateStr, trade, snapshot);
        return snapshot;
    } catch (error) {
        console.warn('[trade-criteria] read', error?.message || error);
        return null;
    }
}
