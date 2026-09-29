import { supabaseRest, verifySupabaseUser } from './google_sheet_sync.js';
import {
    CALCULATION_VERSION,
    DEFAULT_HIGH_LOW_SESSION,
    DEFAULT_VOLUME_SESSION,
    calculateEntryCriteria,
    decideSnapshotWrite,
    normalizeSessionClock,
    parseEntryInstant,
    presentSnapshot,
    zonedDateTimeToUtcMs,
} from './massive_criteria.js';
import { deriveSheetMarket, isEligibleCriteriaDate } from './sheet_criteria_export.js';
import { fetchMassiveAggregates } from './massive_client.js';

const TICKER_RE = /^[A-Z0-9.\-]{1,15}$/;

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function isoDate(value) {
    const date = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function addDays(dateStr, days) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return next.toISOString().slice(0, 10);
}

function tradeTicker(trade) {
    return String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
}

async function loadStoredTrade(userId, tradeDate, tradeId) {
    const rows = await supabaseRest(
        `journal_days?user_id=eq.${encodeURIComponent(userId)}&trade_date=eq.${encodeURIComponent(tradeDate)}&select=daily_metrics&limit=1`,
    );
    const trades = Array.isArray(rows?.[0]?.daily_metrics?.trades) ? rows[0].daily_metrics.trades : null;
    if (!trades) return { synced: false, trade: null };
    return { synced: true, trade: trades.find((trade) => String(trade?.id || '') === tradeId) || null };
}

async function readSnapshot(userId, tradeId, entryAt) {
    const rows = await supabaseRest(
        `trade_criteria_snapshots?user_id=eq.${encodeURIComponent(userId)}&trade_id=eq.${encodeURIComponent(tradeId)}&entry_at=eq.${encodeURIComponent(entryAt)}&calculation_version=eq.${CALCULATION_VERSION}&select=*&limit=1`,
    );
    return rows?.[0] || null;
}

function rowFromCriteria(userId, tradeId, tradeDate, ticker, entryAt, criteria) {
    return {
        user_id: userId,
        trade_id: tradeId,
        trade_date: tradeDate,
        ticker,
        entry_at: entryAt,
        atr14: criteria.atr14,
        avg_vol14: criteria.avgVol14,
        day_volume: criteria.dayVolume,
        vol_play14: criteria.volPlay14,
        atr_play14: criteria.atrPlay14,
        session_high: criteria.high,
        session_low: criteria.low,
        last_candle_at: criteria.lastCandleAt,
        high_low_session_start: criteria.highLowSessionStart,
        volume_session_start: criteria.volumeSessionStart,
        provider: criteria.provider,
        adjusted: true,
        completeness: criteria.completeness,
        fetch_status: criteria.fetchStatus,
        status_detail: String(criteria.statusDetail || '').slice(0, 500),
        calculation_version: CALCULATION_VERSION,
        calculated_at: new Date().toISOString(),
        source_meta: criteria.sourceMeta || {},
    };
}

async function saveSnapshot(row, action) {
    if (action === 'insert') {
        const inserted = await supabaseRest('trade_criteria_snapshots', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(row),
        });
        return Array.isArray(inserted) ? inserted[0] : inserted;
    }
    const updated = await supabaseRest(
        `trade_criteria_snapshots?user_id=eq.${encodeURIComponent(row.user_id)}&trade_id=eq.${encodeURIComponent(row.trade_id)}&entry_at=eq.${encodeURIComponent(row.entry_at)}&calculation_version=eq.${CALCULATION_VERSION}&or=(completeness.neq.complete,fetch_status.neq.ok)`,
        {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(row),
        },
    );
    return Array.isArray(updated) ? updated[0] : updated;
}

async function loadMassiveInputs(ticker, tradeDate, entryMs) {
    const dailyFrom = addDays(tradeDate, -70);
    const dailyTo = addDays(tradeDate, -1);
    let daily;
    let minutes;
    try {
        [daily, minutes] = await Promise.all([
            fetchMassiveAggregates({ ticker, timespan: 'day', from: dailyFrom, to: dailyTo, adjusted: true }),
            fetchMassiveAggregates({ ticker, timespan: 'minute', from: String(entryMs - 16 * 60 * 60 * 1000), to: String(entryMs), adjusted: true }),
        ]);
    } catch (error) {
        return {
            failure: {
                fetchStatus: error.fetchStatus || 'error',
                statusDetail: error.message || 'Massive недоступний',
            },
        };
    }
    return { daily, minutes };
}

async function loadSheetExportInputs(ticker, tradeDate, entryMs) {
    const minuteFrom = zonedDateTimeToUtcMs(addDays(tradeDate, -5), '16:00:00');
    let daily;
    let minutes;
    try {
        [daily, minutes] = await Promise.all([
            fetchMassiveAggregates({ ticker, timespan: 'day', from: addDays(tradeDate, -70), to: addDays(tradeDate, -1), adjusted: true }),
            fetchMassiveAggregates({
                ticker,
                timespan: 'minute',
                from: String(minuteFrom || entryMs - 5 * 24 * 60 * 60 * 1000),
                to: String(entryMs),
                adjusted: true,
            }),
        ]);
    } catch (error) {
        return {
            failure: {
                fetchStatus: error.fetchStatus || 'error',
                statusDetail: error.message || 'Massive недоступний',
            },
        };
    }
    return { daily, minutes };
}

async function handleSheetExport(res, { ticker, tradeDate, opened, entryAt }) {
    const entry = parseEntryInstant({ entryAt, tradeDate, opened });
    if (!TICKER_RE.test(ticker)) return sendJson(res, 400, { ok: false, error: 'Невірний тікер' });
    if (!entry) return sendJson(res, 400, { ok: false, error: 'Потрібен точний час входу' });
    if (!isEligibleCriteriaDate(entry.tradeDate)) {
        return sendJson(res, 200, { ok: true, skipped: true, reason: 'recent-date' });
    }
    const loaded = await loadSheetExportInputs(ticker, entry.tradeDate, entry.entryMs);
    if (loaded.failure) {
        const status = loaded.failure.fetchStatus === 'unavailable' ? 503 : 200;
        return sendJson(res, status, { ok: false, error: loaded.failure.statusDetail });
    }
    const criteria = calculateEntryCriteria({
        dailyBars: loaded.daily.results || [],
        minuteBars: loaded.minutes.results || [],
        entryMs: entry.entryMs,
        tradeDate: entry.tradeDate,
        adjusted: loaded.daily.adjusted === true && loaded.minutes.adjusted === true,
        responseIncomplete: loaded.daily.incomplete || loaded.minutes.incomplete,
        quoteDelayed: loaded.daily.delayed || loaded.minutes.delayed,
    });
    const market = deriveSheetMarket({
        dailyBars: loaded.daily.results || [],
        minuteBars: loaded.minutes.results || [],
        tradeDate: entry.tradeDate,
        entryMs: entry.entryMs,
    });
    return sendJson(res, 200, {
        ok: true,
        sheet: {
            ...market,
            atr14: criteria.atr14,
            avgVol14: criteria.avgVol14,
            dayVolume: criteria.dayVolume,
            volPlay14: criteria.volPlay14,
            high: market.high ?? criteria.high,
            low: market.low ?? criteria.low,
        },
    });
}

export default async function handler(req, res) {
    if (req.method === 'GET') {
        try {
            const user = await verifySupabaseUser(req.headers.authorization || '');
            if (!user) return sendJson(res, 401, { ok: false, error: 'Потрібно увійти в акаунт' });
            const tradeId = String(req.query?.tradeId || '').trim();
            const tradeDate = isoDate(req.query?.tradeDate);
            if (!tradeId) return sendJson(res, 400, { ok: false, error: 'Потрібен ідентифікатор угоди' });
            const filter = tradeDate ? `&trade_date=eq.${encodeURIComponent(tradeDate)}` : '';
            const rows = await supabaseRest(
                `trade_criteria_snapshots?user_id=eq.${encodeURIComponent(user.id)}&trade_id=eq.${encodeURIComponent(tradeId)}${filter}&select=*&order=calculated_at.desc&limit=5`,
            );
            return sendJson(res, 200, { ok: true, snapshots: (rows || []).map(presentSnapshot) });
        } catch (error) {
            console.error('[trade-criteria] read failed', error?.status || '');
            return sendJson(res, 500, { ok: false, error: 'Не вдалося прочитати snapshot' });
        }
    }

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    try {
        const user = await verifySupabaseUser(req.headers.authorization || '');
        if (!user) return sendJson(res, 401, { ok: false, error: 'Потрібно увійти в акаунт' });

        if (req.body?.sheetExport === true) {
            return handleSheetExport(res, {
                ticker: String(req.body?.ticker || '').trim().toUpperCase(),
                tradeDate: isoDate(req.body?.tradeDate),
                opened: req.body?.opened,
                entryAt: req.body?.entryAt,
            });
        }

        const tradeId = String(req.body?.tradeId || '').trim();
        const requestedTicker = String(req.body?.ticker || '').trim().toUpperCase();
        const manual = req.body?.manual === true;
        if (!tradeId || tradeId.length > 80) return sendJson(res, 400, { ok: false, error: 'Потрібен ідентифікатор угоди' });

        let ticker = requestedTicker;
        let opened = req.body?.opened;
        let entryAt = req.body?.entryAt;
        let tradeDate = isoDate(req.body?.tradeDate);
        if (tradeDate) {
            const stored = await loadStoredTrade(user.id, tradeDate, tradeId);
            if (stored.synced && !stored.trade) return sendJson(res, 409, { ok: false, error: 'Угода ще не синхронізована' });
            if (stored.trade) {
                ticker = tradeTicker(stored.trade);
                opened = stored.trade.opened || stored.trade.entryTime || stored.trade.time || opened;
                entryAt = '';
            }
        }
        if (!TICKER_RE.test(ticker)) return sendJson(res, 400, { ok: false, error: 'Невірний тікер' });
        const entry = parseEntryInstant({ entryAt, tradeDate, opened });
        if (!entry) return sendJson(res, 400, { ok: false, error: 'Потрібен точний час входу' });

        const highLowSessionStart = normalizeSessionClock(req.body?.highLowSessionStart, DEFAULT_HIGH_LOW_SESSION);
        const volumeSessionStart = normalizeSessionClock(req.body?.volumeSessionStart, DEFAULT_VOLUME_SESSION);
        const existing = await readSnapshot(user.id, tradeId, entry.entryAt);
        const action = decideSnapshotWrite(existing, { manual });
        if (action === 'reuse' && existing) {
            return sendJson(res, 200, { ok: true, reused: true, snapshot: presentSnapshot(existing) });
        }

        const loaded = await loadMassiveInputs(ticker, entry.tradeDate, entry.entryMs);
        const criteria = loaded.failure
            ? calculateEntryCriteria({
                entryMs: entry.entryMs,
                tradeDate: entry.tradeDate,
                highLowSessionStart,
                volumeSessionStart,
                adjusted: true,
                fetchStatus: loaded.failure.fetchStatus,
                statusDetail: loaded.failure.statusDetail,
            })
            : calculateEntryCriteria({
                dailyBars: loaded.daily.results,
                minuteBars: loaded.minutes.results,
                entryMs: entry.entryMs,
                tradeDate: entry.tradeDate,
                highLowSessionStart,
                volumeSessionStart,
                adjusted: loaded.daily.adjusted === true && loaded.minutes.adjusted === true,
                responseIncomplete: loaded.daily.incomplete || loaded.minutes.incomplete,
                quoteDelayed: loaded.daily.delayed || loaded.minutes.delayed,
            });

        if (loaded.failure?.fetchStatus === 'unavailable') {
            return sendJson(res, 503, { ok: false, error: loaded.failure.statusDetail, snapshot: presentSnapshot({ ...criteria, tradeId, tradeDate: entry.tradeDate, ticker, entryAt: entry.entryAt }) });
        }

        const row = rowFromCriteria(user.id, tradeId, entry.tradeDate, ticker, entry.entryAt, criteria);
        let saved = null;
        try {
            saved = await saveSnapshot(row, existing ? 'replace' : 'insert');
        } catch (error) {
            if (!/23505|duplicate/i.test(String(error?.message || ''))) throw error;
            const winner = await readSnapshot(user.id, tradeId, entry.entryAt);
            if (winner && decideSnapshotWrite(winner, { manual }) === 'reuse') {
                return sendJson(res, 200, { ok: true, reused: true, snapshot: presentSnapshot(winner) });
            }
            saved = await saveSnapshot(row, 'replace');
        }
        return sendJson(res, 200, { ok: true, reused: false, snapshot: presentSnapshot(saved || row) });
    } catch (error) {
        console.error('[trade-criteria] calculate failed', error?.status || error?.fetchStatus || '');
        return sendJson(res, 500, { ok: false, error: 'Не вдалося порахувати критерії' });
    }
}
