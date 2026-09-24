import { addCalendarDays, newYorkParts, nextTradingDay, previousTradingDay, isTradingDay } from './aggressiveness_core.js';
import { loadScaledHistory, liveQuoteMap } from './aggressiveness_service.js';
import { SERIES_CATALOG, createMarketDataProvider, seriesSymbol } from './market_data_provider.js';
import { supabaseRest, supabaseRestAll } from './google_sheet_sync.js';
import {
    NEXT_SCORE_VERSION,
    buildEdgeSeries,
    chartRows,
    nextDayBacktest,
    normalizeJournalRows,
    predictNextSession,
    premarketAdjustment,
    tickerDayOutcomes,
} from './next_session_core.js';

export function nextSessionClock(instant = new Date()) {
    const ny = newYorkParts(instant);
    const during = isTradingDay(ny.date) && ny.minutes < 16 * 60;
    const targetDate = during ? ny.date : nextTradingDay(ny.date);
    const featureDate = previousTradingDay(targetDate);
    let phase = 'closed';
    if (during && ny.minutes >= 4 * 60 && ny.minutes < 9 * 60 + 30) phase = 'premarket';
    else if (during && ny.minutes >= 9 * 60 + 30) phase = 'open';
    return { featureDate, targetDate, phase, nowEt: ny.date };
}

function featureDatesEnding(featureDate, count = 14) {
    const dates = [];
    let cursor = featureDate;
    while (cursor && dates.length < count) {
        dates.push(cursor);
        const prior = previousTradingDay(cursor);
        if (!prior || prior >= cursor) break;
        cursor = prior;
    }
    return dates.reverse();
}

export function buildNextSessionPayload({ barsByKey, signals = [], now = new Date(), quotes = null }) {
    const clock = nextSessionClock(now);
    const adjustment = clock.phase === 'premarket' ? premarketAdjustment(quotes) : 0;
    const current = predictNextSession({
        barsByKey,
        signals,
        featureDate: clock.featureDate,
        premarket: adjustment,
    });
    const history = featureDatesEnding(clock.featureDate).map((featureDate) => {
        const row = featureDate === clock.featureDate
            ? current
            : predictNextSession({ barsByKey, signals, featureDate, premarket: 0 });
        return row.complete ? row : null;
    }).filter(Boolean);
    const knownEdges = buildEdgeSeries(tickerDayOutcomes(signals.filter((signal) => signal.tradingDate < clock.targetDate)));
    return {
        status: current.complete ? 'ok' : 'incomplete',
        scoreVersion: NEXT_SCORE_VERSION,
        clock,
        ...current,
        history: chartRows(history, knownEdges),
    };
}

export function buildNextSessionResearch({ barsByKey, signals = [] }) {
    return nextDayBacktest({ barsByKey, signals });
}

export async function loadMechanicalSignals(now = new Date()) {
    try {
        const from = addCalendarDays(newYorkParts(now).date, -800);
        const rows = await supabaseRestAll(`journal_days?select=user_id,trade_date,daily_metrics&trade_date=gte.${from}&order=trade_date.asc`);
        return normalizeJournalRows(rows);
    } catch (error) {
        console.error('next-session mechanical load failed', error);
        return [];
    }
}

async function persistPrediction(payload) {
    if (!payload?.complete) return;
    const body = {
        target_date: payload.targetDate,
        score_version: NEXT_SCORE_VERSION,
        feature_date: payload.featureDate,
        market_leading_score: payload.marketLeading,
        lagged_mechanical_score: payload.laggedMechanical,
        transition_score: payload.transition,
        base_prediction: payload.basePrediction,
        premarket_adjustment: payload.premarketAdjustment,
        final_score: payload.finalScore,
        regime_state: payload.regimeState,
        confidence: payload.confidence,
        mode: payload.mode,
        features: payload.features || {},
    };
    try {
        await supabaseRest('daily_aggressiveness_prediction', {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(body),
        });
        if (payload.premarketAdjustment) {
            await supabaseRest(`daily_aggressiveness_prediction?target_date=eq.${payload.targetDate}&score_version=eq.${NEXT_SCORE_VERSION}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({
                    premarket_adjustment: payload.premarketAdjustment,
                    final_score: payload.finalScore,
                }),
            });
        }
    } catch (error) {
        if (!/relation|does not exist|schema cache|immutable/i.test(String(error?.message || error))) {
            console.error('next-session prediction store failed', error?.message || error);
        }
    }
}

export async function buildLiveNextSession(env = process.env, fetchImpl = fetch, now = new Date(), options = {}) {
    const clock = nextSessionClock(now);
    const provider = options.provider || createMarketDataProvider(env, fetchImpl, { allowPublic: true });
    const history = await loadScaledHistory(provider, options.store || null, clock.targetDate, env);
    const signals = options.signals || await loadMechanicalSignals(now);
    let quotes = null;
    if (clock.phase === 'premarket' && provider?.getLiveQuotes) {
        try {
            const symbols = SERIES_CATALOG.map((spec) => seriesSymbol(spec, env));
            quotes = liveQuoteMap(await provider.getLiveQuotes(symbols), env);
        } catch (error) {
            console.error('next-session premarket quotes failed', error);
        }
    }
    const payload = buildNextSessionPayload({ barsByKey: history.barsByKey, signals, now, quotes });
    if (options.persist !== false) await persistPrediction(payload);
    return payload;
}
