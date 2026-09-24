import {
    LIVE_EMA_ALPHA,
    REQUIRED_SERIES,
    SCORE_VERSION,
    addCalendarDays,
    aggressivenessStatus,
    displaySessionDate,
    finalAggressiveness,
    previousTradingDay,
    rawLiveAdjustment,
    scoreSessionFromBars,
    sessionPhase,
    smoothLiveAdjustment,
    systemHealth,
} from './aggressiveness_core.js';
import { buildBacktestReport } from './aggressiveness_backtest.js';
import {
    SERIES_CATALOG,
    applySeriesScale,
    createMarketDataProvider,
    seriesScale,
    seriesSymbol,
} from './market_data_provider.js';

const LIVE_THROTTLE_MS = 5 * 60 * 1000;

export function planGaugeWrite({ existing, computed, now = new Date(), nextLive = null }) {
    if (!computed?.complete) return { action: 'keep', reason: 'incomplete' };
    const phase = sessionPhase(now);
    const live = Number.isFinite(Number(nextLive)) ? Number(nextLive) : 0;
    const liveScore = finalAggressiveness(computed.baseScore, computed.components.narrowPenalty, computed.components.meltUpPenalty, live);
    if (!existing) {
        return {
            action: 'insert',
            row: regimeRow(computed, { live, liveScore, frozen: phase === 'frozen', now }),
        };
    }
    if (existing.live_frozen) return { action: 'keep', reason: 'frozen' };
    const updatedAt = existing.live_updated_at ? new Date(existing.live_updated_at).getTime() : 0;
    const fresh = updatedAt && now.getTime() - updatedAt < LIVE_THROTTLE_MS;
    if (fresh && phase !== 'frozen') return { action: 'keep', reason: 'throttled' };
    return {
        action: 'patch',
        patch: {
            live_score: round(liveScore),
            live_adjustment: round(live),
            live_frozen: phase === 'frozen',
            live_updated_at: now.toISOString(),
        },
    };
}

export function regimeRow(computed, { live, liveScore, frozen, now }) {
    const features = computed.features;
    return {
        date: computed.sessionDate,
        score_version: SCORE_VERSION,
        base_score: round(computed.baseScore),
        live_score: round(liveScore),
        live_adjustment: round(live),
        micro_small_score: round(computed.components.microSmall),
        speculative_score: round(computed.components.speculative),
        broad_score: round(computed.components.broad),
        stress_score: round(computed.components.stress),
        narrow_penalty: round(computed.components.narrowPenalty),
        meltup_penalty: round(computed.components.meltUpPenalty),
        spy_1d: round(features.spy1d, 6),
        spy_5d: round(features.spy5d, 6),
        spy_10d: round(features.spy10d, 6),
        spy_20d: round(features.spy20d, 6),
        spy_rv5: round(features.spyRv5, 6),
        qqq_rs5: round(features.qqqRs5, 6),
        qqq_rs10: round(features.qqqRs10, 6),
        iwm_rs5: round(features.iwmRs5, 6),
        iwm_rs10: round(features.iwmRs10, 6),
        iwc_rs5: round(features.iwcRs5, 6),
        iwc_rs10: round(features.iwcRs10, 6),
        xbi_rs5: round(features.xbiRs5, 6),
        xbi_rs10: round(features.xbiRs10, 6),
        arkk_rs5: round(features.arkkRs5, 6),
        arkk_rs10: round(features.arkkRs10, 6),
        smh_rs5: round(features.smhRs5, 6),
        smh_rs10: round(features.smhRs10, 6),
        vix: round(features.vix, 4),
        vix_1d: round(features.vix1d, 6),
        vix_5d: round(features.vix5d, 6),
        us10y: round(features.us10y, 4),
        us10y_5d_bp: round(features.us10y5dBp, 4),
        oil: round(features.oil, 4),
        oil_1d: round(features.oil1d, 6),
        oil_5d: round(features.oil5d, 6),
        info_through: computed.infoThrough,
        live_frozen: frozen,
        live_updated_at: now.toISOString(),
        calculated_at: now.toISOString(),
    };
}

export function payloadFromComputed(computed, extras = {}) {
    return {
        status: computed.complete ? 'ok' : 'incomplete',
        message: computed.complete ? null : 'Data incomplete',
        incomplete: !computed.complete,
        sessionDate: computed.sessionDate,
        infoThrough: computed.infoThrough,
        scoreVersion: SCORE_VERSION,
        baseScore: computed.baseScore ?? null,
        liveScore: computed.liveScore ?? null,
        liveAdjustment: computed.liveAdjustment ?? null,
        displayScore: computed.displayScore ?? null,
        label: computed.label ?? null,
        tone: computed.tone ?? null,
        components: computed.components ?? null,
        missing: computed.missing || [],
        stale: Boolean(computed.stale),
        systemHealth: extras.systemHealth || null,
        updatedAt: extras.updatedAt || null,
        delta: extras.delta ?? null,
        persisted: Boolean(extras.persisted),
        liveFeedIncomplete: Boolean(extras.liveFeedIncomplete),
    };
}

export function payloadFromStored(row, extras = {}) {
    const base = Number(row.base_score);
    const liveScore = Number(row.live_score);
    const display = Math.round(Number.isFinite(liveScore) ? liveScore : base);
    return payloadFromComputed({
        complete: true,
        sessionDate: row.date,
        infoThrough: row.info_through,
        baseScore: base,
        liveScore,
        liveAdjustment: Number(row.live_adjustment),
        displayScore: display,
        label: statusLabel(display),
        tone: statusTone(display),
        components: {
            microSmall: Number(row.micro_small_score),
            speculative: Number(row.speculative_score),
            broad: Number(row.broad_score),
            stress: Number(row.stress_score),
            narrowPenalty: Number(row.narrow_penalty),
            meltUpPenalty: Number(row.meltup_penalty),
            liveAdjustment: Number(row.live_adjustment),
        },
        missing: [],
        stale: false,
    }, extras);
}

function statusLabel(score) {
    if (score <= 19) return 'Мінімальна';
    if (score <= 39) return 'Обережно';
    if (score <= 59) return 'Нейтральна';
    if (score <= 79) return 'Агресивна';
    return 'Максимальна';
}

function statusTone(score) {
    if (score <= 19) return 'minimal';
    if (score <= 39) return 'cautious';
    if (score <= 59) return 'neutral';
    if (score <= 79) return 'aggressive';
    return 'maximal';
}

export async function loadScaledHistory(provider, store, sessionDate, env = process.env, range = {}) {
    const from = range.from || addCalendarDays(sessionDate, -520);
    const to = range.to || previousTradingDay(sessionDate);
    const barsByKey = {};
    const missing = [];
    for (const spec of SERIES_CATALOG) {
        const symbol = seriesSymbol(spec, env);
        let raw = [];
        if (store?.readBars) {
            try {
                raw = await store.readBars(symbol, from, to);
            } catch (error) {
                console.warn('[Aggressiveness] bar cache read skipped:', error?.message || error);
                raw = [];
            }
        }
        const cutoffReady = raw.some((bar) => bar.date >= to);
        if (!cutoffReady) {
            try {
                const fetched = await provider.getDailyBars(symbol, from, to);
                if (store?.writeBars && fetched.length) {
                    try {
                        await store.writeBars(symbol, fetched);
                    } catch (error) {
                        console.warn('[Aggressiveness] bar cache write skipped:', error?.message || error);
                    }
                }
                const merged = new Map(raw.map((bar) => [bar.date, bar]));
                for (const bar of fetched) merged.set(bar.date, bar);
                raw = [...merged.values()];
            } catch (error) {
                missing.push({ key: spec.key, symbol, code: error.code || 'MARKET_PROVIDER_ERROR', message: error.message || '' });
                if (error.code === 'RATE_LIMITED') break;
            }
        }
        barsByKey[spec.key] = applySeriesScale(spec, raw, env);
    }
    return { barsByKey, missing, from, to };
}

export function liveQuoteMap(snapshot, env = process.env) {
    const quotes = snapshot?.quotes || {};
    const mapped = {};
    for (const spec of SERIES_CATALOG) {
        const symbol = seriesSymbol(spec, env);
        const quote = quotes[symbol];
        if (!quote) continue;
        mapped[spec.key] = quote.change;
        if (spec.key === 'US10Y' && Number.isFinite(quote.changePoints)) {
            mapped.US10Y_BP = quote.changePoints * seriesScale(spec, env) * 100;
        }
    }
    const futuresSymbol = String(env.MARKET_VIX_FUTURES_SYMBOL || '').trim();
    if (futuresSymbol && quotes[futuresSymbol]?.change != null) mapped.VIX_FUTURES = quotes[futuresSymbol].change;
    return mapped;
}

async function optionalStore(task) {
    try {
        return await task();
    } catch (error) {
        console.warn('[Aggressiveness] store skipped:', error?.message || error);
        return null;
    }
}

export async function buildGauge(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const env = options.env || process.env;
    const sessionDate = options.sessionDate || displaySessionDate(now);
    const store = options.store || null;
    let provider = options.provider || null;
    if (!provider) {
        try {
            provider = createMarketDataProvider(env, options.fetchImpl, { authToken: options.authToken || '' });
        } catch (error) {
            const last = store?.readLatest ? await optionalStore(() => store.readLatest(SCORE_VERSION)) : null;
            return {
                ...payloadFromComputed({
                    complete: false,
                    sessionDate,
                    infoThrough: previousTradingDay(sessionDate),
                    missing: REQUIRED_SERIES,
                    stale: true,
                    message: 'Data incomplete',
                }),
                message: 'Data incomplete',
                lastValid: last ? payloadFromStored(last) : null,
                providerError: error.code || error.message,
            };
        }
    }

    const existing = store?.readRegime ? await optionalStore(() => store.readRegime(sessionDate, SCORE_VERSION)) : null;
    const history = options.barsByKey
        ? { barsByKey: options.barsByKey, missing: [] }
        : await loadScaledHistory(provider, store, sessionDate, env);
    const computed = scoreSessionFromBars(history.barsByKey, sessionDate, { liveAdjustment: 0 });
    if (!computed.complete) {
        const last = existing || (store?.readLatest ? await optionalStore(() => store.readLatest(SCORE_VERSION)) : null);
        return {
            ...payloadFromComputed(computed),
            message: 'Data incomplete',
            lastValid: last ? payloadFromStored(last) : null,
            providerMissing: history.missing,
        };
    }

    const priorShock = computed.features.vix1d >= 0.08 || computed.features.vix > 25;
    let quotesReady = false;
    let quoteMap = {};
    const phase = sessionPhase(now);
    const needsLive = !existing?.live_frozen && (phase === 'premarket' || phase === 'open' || phase === 'frozen');
    if (needsLive && provider?.getLiveQuotes) {
        const symbols = SERIES_CATALOG.map((spec) => seriesSymbol(spec, env));
        const futures = String(env.MARKET_VIX_FUTURES_SYMBOL || '').trim();
        if (futures) symbols.push(futures);
        try {
            const snapshot = await provider.getLiveQuotes(symbols);
            quoteMap = liveQuoteMap(snapshot, env);
            quotesReady = ['SPY', 'QQQ', 'IWM'].every((key) => Number.isFinite(quoteMap[key]));
        } catch {
            quotesReady = false;
        }
    }
    const raw = quotesReady ? rawLiveAdjustment(quoteMap, { priorShock }) : null;
    const previousLive = existing ? Number(existing.live_adjustment) : null;
    const nextLive = raw == null ? previousLive : smoothLiveAdjustment(previousLive, raw, LIVE_EMA_ALPHA);
    const decision = planGaugeWrite({
        existing,
        computed,
        now,
        nextLive: nextLive ?? 0,
    });
    let persisted = false;
    if (store && decision.action === 'insert') persisted = Boolean(await optionalStore(() => store.insertRegime(decision.row)));
    if (store && decision.action === 'patch') persisted = Boolean(await optionalStore(() => store.patchRegime(sessionDate, SCORE_VERSION, decision.patch)));

    const previous = store?.readPrevious ? await optionalStore(() => store.readPrevious(sessionDate, SCORE_VERSION)) : null;
    const previousScore = previous ? Number(previous.live_score) : null;
    const updatedAt = decision.action === 'patch' ? decision.patch.live_updated_at : (existing?.live_updated_at || now.toISOString());
    if (existing && decision.action !== 'insert') {
        const stored = payloadFromStored(existing, {
            updatedAt,
            persisted,
            liveFeedIncomplete: needsLive && !quotesReady,
            delta: null,
        });
        if (decision.action === 'patch') {
            const status = aggressivenessStatus(decision.patch.live_score);
            stored.liveScore = decision.patch.live_score;
            stored.liveAdjustment = decision.patch.live_adjustment;
            stored.displayScore = status.score;
            stored.label = status.label;
            stored.tone = status.tone;
            stored.components.liveAdjustment = decision.patch.live_adjustment;
        }
        stored.delta = Number.isFinite(previousScore) ? round(stored.displayScore - previousScore, 1) : null;
        stored.immutableBase = true;
        stored.updatedAt = updatedAt;
        return stored;
    }
    const live = Number(decision.row?.live_adjustment ?? nextLive ?? 0);
    const liveScore = Number(decision.row?.live_score ?? finalAggressiveness(
        computed.baseScore,
        computed.components.narrowPenalty,
        computed.components.meltUpPenalty,
        live,
    ));
    const status = aggressivenessStatus(liveScore);
    return {
        ...payloadFromComputed({
            ...computed,
            liveScore,
            liveAdjustment: live,
            displayScore: status.score,
            label: status.label,
            tone: status.tone,
        }),
        delta: Number.isFinite(previousScore) ? round(status.score - previousScore, 1) : null,
        updatedAt: now.toISOString(),
        persisted,
        liveFeedIncomplete: needsLive && !quotesReady,
        immutableBase: false,
    };
}

export async function buildHistoricalBacktest(barsByKey, mechanicalByDate, dates) {
    const scored = [];
    for (const sessionDate of dates) {
        const computed = scoreSessionFromBars(barsByKey, sessionDate, { liveAdjustment: 0 });
        if (!computed.complete) continue;
        scored.push({
            ...computed,
            displayScore: Math.round(finalAggressiveness(
                computed.baseScore,
                computed.components.narrowPenalty,
                computed.components.meltUpPenalty,
                0,
            )),
            mechanical: mechanicalByDate?.[sessionDate] || null,
        });
    }
    const report = buildBacktestReport(scored);
    report.systemHealth = systemHealth(Object.values(mechanicalByDate || {}));
    report.note = 'System Health is reported separately and is not an Aggressiveness input.';
    return report;
}

function round(value, digits = 4) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const factor = 10 ** digits;
    return Math.round((number + Number.EPSILON) * factor) / factor;
}
