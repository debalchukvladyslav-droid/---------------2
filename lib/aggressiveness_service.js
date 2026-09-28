import {
    REQUIRED_SERIES,
    BREADTH_FIELDS,
    SCORE_VERSION,
    addCalendarDays,
    aggressivenessStatus,
    displaySessionDate,
    mechanicalByDateFromSignals,
    previousTradingDay,
    recentAggressiveness,
    scoreCalendar,
    scoreSessionFromBars,
} from './aggressiveness_core.js';
import { buildBacktestReport, leaveOneMonthOutScores } from './aggressiveness_backtest.js';
import {
    SERIES_CATALOG,
    applySeriesScale,
    createBreadthProvider,
    createMarketDataProvider,
    seriesScale,
    seriesSymbol,
} from './market_data_provider.js';

export function planGaugeWrite({ existing, computed }) {
    if (!computed?.complete) return { action: 'keep', reason: 'incomplete' };
    if (existing) return { action: 'keep', reason: 'immutable' };
    const row = regimeRow(computed);
    if ([row.micro_small_score, row.speculative_score, row.broad_score, row.stress_score].some((value) => value == null)) {
        return { action: 'keep', reason: 'unpersistable' };
    }
    return { action: 'insert', row };
}

export function regimeRow(computed, now = new Date()) {
    const features = computed.features || {};
    const components = computed.components || {};
    const mechanical = computed.mechanical || null;
    return {
        date: computed.sessionDate,
        score_version: SCORE_VERSION,
        market_data_through_date: computed.infoThrough,
        base_score: round(computed.ruleScore),
        live_score: computed.displayScore,
        live_adjustment: 0,
        rule_score: round(computed.ruleScore),
        analog_score: round(computed.analogScore),
        confidence: round(computed.confidence, 2),
        micro_small_score: round(components.smallMicro),
        small_micro_score: round(components.smallMicro),
        breadth_score: round(components.breadth),
        speculative_score: round(components.speculative),
        broad_score: round(components.broadMarket),
        stress_score: round(components.macro),
        macro_score: round(components.macro),
        narrow_penalty: 0,
        meltup_penalty: 0,
        spy_1d: round(features.spy1d, 6),
        spy_3d: round(features.spy3d, 6),
        spy_5d: round(features.spy5d, 6),
        spy_10d: round(features.spy10d, 6),
        spy_20d: round(features.spy20d, 6),
        spy_rv5: round(features.spyRv5, 6),
        spy_rv10: round(features.spyRv10, 6),
        spy_distance_20d_high: round(features.spyDistance20dHigh, 6),
        qqq_rs5: round(features.qqqRs5, 6),
        qqq_rs10: round(features.qqqRs10, 6),
        iwm_rs1: round(features.iwmRs1, 6),
        iwm_rs3: round(features.iwmRs3, 6),
        iwm_rs5: round(features.iwmRs5, 6),
        iwm_rs10: round(features.iwmRs10, 6),
        iwc_rs1: round(features.iwcRs1, 6),
        iwc_rs3: round(features.iwcRs3, 6),
        iwc_rs5: round(features.iwcRs5, 6),
        iwc_rs10: round(features.iwcRs10, 6),
        xbi_rs3: round(features.xbiRs3, 6),
        xbi_rs5: round(features.xbiRs5, 6),
        xbi_rs10: round(features.xbiRs10, 6),
        arkk_rs3: round(features.arkkRs3, 6),
        arkk_rs5: round(features.arkkRs5, 6),
        arkk_rs10: round(features.arkkRs10, 6),
        smh_rs5: round(features.smhRs5, 6),
        smh_rs10: round(features.smhRs10, 6),
        nyse_decliner_ratio: round(features.nyseDeclinerRatio, 6),
        nasdaq_decliner_ratio: round(features.nasdaqDeclinerRatio, 6),
        nyse_down_volume_share: round(features.nyseDownVolumeShare, 6),
        nasdaq_down_volume_share: round(features.nasdaqDownVolumeShare, 6),
        nyse_new_low_share: round(features.nyseNewLowShare, 6),
        nasdaq_new_low_share: round(features.nasdaqNewLowShare, 6),
        vix: round(features.vix, 4),
        vix_1d: round(features.vix1d, 6),
        vix_3d: round(features.vix3d, 6),
        vix_5d: round(features.vix5d, 6),
        us10y: round(features.us10y, 4),
        us10y_1d_bp: round(features.us10y1dBp, 4),
        us10y_5d_bp: round(features.us10y5dBp, 4),
        us10y_10d_bp: round(features.us10y10dBp, 4),
        oil: round(features.oil, 4),
        oil_1d: round(features.oil1d, 6),
        oil_3d: round(features.oil3d, 6),
        oil_5d: round(features.oil5d, 6),
        oil_10d: round(features.oil10d, 6),
        analog_expected_r: round(computed.analogExpectedR, 6),
        analog_positive_rate: round(computed.analogPositiveRate, 6),
        analog_sample_size: computed.analogSampleSize || 0,
        mechanical_entries: mechanical?.entries ?? null,
        mechanical_total_r: mechanical?.totalR ?? null,
        mechanical_r_per_trade: mechanical?.rPerTrade ?? null,
        mechanical_win_rate: mechanical?.winRate ?? null,
        mechanical_avg_winner: mechanical?.avgWinner ?? null,
        mechanical_avg_loser: mechanical?.avgLoser ?? null,
        info_through: computed.infoThrough,
        live_frozen: true,
        live_updated_at: now.toISOString(),
        calculated_at: now.toISOString(),
        created_at: now.toISOString(),
        features: features,
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
        baseScore: computed.ruleScore ?? computed.baseScore ?? null,
        ruleScore: computed.ruleScore ?? null,
        analogScore: computed.analogScore ?? null,
        liveScore: computed.displayScore ?? null,
        liveAdjustment: 0,
        displayScore: computed.displayScore ?? null,
        label: computed.label ?? null,
        tone: computed.tone ?? null,
        components: computed.components ?? null,
        missing: computed.missing || [],
        coverageGaps: computed.coverageGaps || [],
        breadthUnavailable: Boolean(computed.breadthUnavailable),
        stale: Boolean(computed.stale),
        confidence: computed.confidence ?? null,
        drivers: computed.drivers || [],
        weightsRenormalized: Boolean(computed.weightsRenormalized),
        omittedBlocks: computed.omittedBlocks || [],
        analogExpectedR: computed.analogExpectedR ?? null,
        analogPositiveRate: computed.analogPositiveRate ?? null,
        analogSampleSize: computed.analogSampleSize ?? null,
        trainDays: computed.trainDays ?? null,
        updatedAt: extras.updatedAt || null,
        delta: extras.delta ?? null,
        persisted: Boolean(extras.persisted),
        immutable: true,
    };
}

export function payloadFromStored(row, extras = {}) {
    const score = Math.round(Number(row.live_score));
    const status = aggressivenessStatus(score);
    const smallMicro = numberOrNull(row.small_micro_score ?? row.micro_small_score);
    const breadth = numberOrNull(row.breadth_score);
    const speculative = numberOrNull(row.speculative_score);
    const broad = numberOrNull(row.broad_score);
    const macro = numberOrNull(row.macro_score ?? row.stress_score);
    const analog = numberOrNull(row.analog_score);
    return payloadFromComputed({
        complete: true,
        sessionDate: row.date,
        infoThrough: row.market_data_through_date || row.info_through,
        ruleScore: numberOrNull(row.rule_score ?? row.base_score),
        analogScore: analog,
        displayScore: status.score,
        label: status.label,
        tone: status.tone,
        components: {
            smallMicro,
            breadth,
            speculative,
            broadMarket: broad,
            macro,
            microSmall: smallMicro,
            broad,
            stress: macro,
            analog,
            ruleScore: numberOrNull(row.rule_score ?? row.base_score),
            narrowPenalty: 0,
            meltUpPenalty: 0,
            liveAdjustment: 0,
        },
        confidence: numberOrNull(row.confidence),
        missing: [],
        coverageGaps: breadth == null ? [...BREADTH_FIELDS] : [],
        breadthUnavailable: breadth == null,
        analogExpectedR: numberOrNull(row.analog_expected_r),
        analogPositiveRate: numberOrNull(row.analog_positive_rate),
        analogSampleSize: row.analog_sample_size == null ? null : Number(row.analog_sample_size),
        stale: false,
    }, extras);
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
                        await store.writeBars(symbol, fetched, provider.name || 'yahoo');
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

export async function loadBreadthHistory(provider, store, from, to) {
    let rows = [];
    if (store?.readBreadth) {
        try {
            rows = await store.readBreadth(from, to);
        } catch (error) {
            console.warn('[Aggressiveness] breadth cache read skipped:', error?.message || error);
        }
    }
    let report = {
        provider: provider?.id || 'none',
        unavailable: provider?.available !== true,
        missingFields: provider?.available ? [] : [...BREADTH_FIELDS],
        rows: [],
    };
    if (provider?.available && provider.getDailyBreadth) {
        try {
            report = await provider.getDailyBreadth(from, to);
            if (report.rows?.length && store?.writeBreadth) {
                await store.writeBreadth(report.rows, report.provider).catch((error) => {
                    console.warn('[Aggressiveness] breadth cache write skipped:', error?.message || error);
                });
            }
        } catch (error) {
            report = {
                provider: provider.id || 'breadth',
                unavailable: true,
                missingFields: [...BREADTH_FIELDS],
                rows: [],
                message: error.message || 'breadth unavailable',
            };
        }
    }
    const byDate = {};
    for (const row of rows || []) byDate[row.date] = row;
    for (const row of report.rows || []) byDate[row.date] = { ...byDate[row.date], ...row };
    return {
        byDate,
        missingFields: report.missingFields?.length ? report.missingFields : (Object.keys(byDate).length ? [] : [...BREADTH_FIELDS]),
        provider: report.provider,
        unavailable: report.unavailable && Object.keys(byDate).length === 0,
    };
}

export function liveQuoteMap(snapshot, env = process.env) {
    const quotes = snapshot?.quotes || {};
    const mapped = {};
    for (const spec of SERIES_CATALOG) {
        const symbol = seriesSymbol(spec, env);
        const quote = quotes[symbol];
        if (!quote) continue;
        mapped[spec.key] = {
            change: Number.isFinite(Number(quote.change)) ? Number(quote.change) : null,
            fromPrevClose: Number.isFinite(Number(quote.fromPrevClose ?? quote.change)) ? Number(quote.fromPrevClose ?? quote.change) : null,
            fromOpen: Number.isFinite(Number(quote.fromOpen)) ? Number(quote.fromOpen) : null,
        };
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

async function resolveMechanical(options) {
    if (options.mechanicalByDate) return options.mechanicalByDate;
    if (!options.loadSignals) return {};
    try {
        const signals = await options.loadSignals();
        return mechanicalByDateFromSignals(signals);
    } catch (error) {
        console.warn('[Aggressiveness] mechanical history skipped:', error?.message || error);
        return {};
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
            provider = createMarketDataProvider(env, options.fetchImpl, { authToken: options.authToken || '', allowPublic: true });
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
    const breadthProvider = options.breadthProvider || createBreadthProvider(env);
    const breadth = options.breadthByDate
        ? { byDate: options.breadthByDate, missingFields: options.breadthMissingFields || [], unavailable: false, provider: 'injected' }
        : await loadBreadthHistory(breadthProvider, store, addCalendarDays(sessionDate, -520), previousTradingDay(sessionDate));
    const mechanicalByDate = await resolveMechanical(options);
    const scored = scoreSessionFromBars(history.barsByKey, sessionDate, {
        mechanicalByDate,
        breadthByDate: breadth.byDate,
    });
    if (!scored.complete && existing) {
        const stored = payloadFromStored(existing, { updatedAt: existing.calculated_at || existing.created_at });
        stored.history = historyPoints(history.barsByKey, sessionDate, mechanicalByDate, breadth.byDate);
        stored.immutable = true;
        return stored;
    }
    if (!scored.complete) {
        const last = existing || (store?.readLatest ? await optionalStore(() => store.readLatest(SCORE_VERSION)) : null);
        return {
            ...payloadFromComputed(scored),
            message: 'Data incomplete',
            lastValid: last ? payloadFromStored(last) : null,
            providerMissing: history.missing,
            breadthMissingFields: breadth.missingFields,
            breadthProvider: breadth.provider,
        };
    }

    const decision = planGaugeWrite({ existing, computed: { ...scored, mechanical: mechanicalByDate[sessionDate] || null } });
    let persisted = false;
    if (store && decision.action === 'insert') {
        persisted = Boolean(await optionalStore(() => store.insertRegime(decision.row)));
    }
    const progression = historyPoints(history.barsByKey, sessionDate, mechanicalByDate, breadth.byDate);
    const previous = store?.readPrevious ? await optionalStore(() => store.readPrevious(sessionDate, SCORE_VERSION)) : null;
    const previousScore = previous ? Number(previous.live_score) : null;
    const payload = existing && decision.action !== 'insert'
        ? payloadFromStored(existing, { updatedAt: existing.calculated_at || existing.created_at, persisted })
        : payloadFromComputed(scored, { updatedAt: now.toISOString(), persisted });
    if (existing && decision.action !== 'insert') {
        payload.displayScore = Math.round(Number(existing.live_score));
        const status = aggressivenessStatus(payload.displayScore);
        payload.label = status.label;
        payload.tone = status.tone;
        payload.liveScore = status.score;
    }
    payload.delta = Number.isFinite(previousScore) ? round(payload.displayScore - previousScore, 1) : null;
    payload.history = stampProgression(progression, sessionDate, payload.displayScore, scored);
    payload.immutable = true;
    payload.breadthMissingFields = breadth.missingFields;
    payload.breadthProvider = breadth.provider;
    payload.breadthUnavailable = scored.breadthUnavailable;
    return payload;
}

export async function buildHistoricalBacktest(barsByKey, mechanicalByDate, dates, options = {}) {
    const breadthByDate = options.breadthByDate || {};
    const scored = scoreCalendar(barsByKey, mechanicalByDate, dates, { breadthByDate }).map((day) => ({
        ...day,
        mechanical: mechanicalByDate?.[day.sessionDate] || null,
    }));
    const report = buildBacktestReport(scored.filter((day) => day.complete));
    const heldOut = leaveOneMonthOutScores(barsByKey, mechanicalByDate, dates, { breadthByDate });
    const monthKeys = [...new Set(dates.map((date) => String(date).slice(0, 7)))].sort();
    const proofMonths = new Set(monthKeys.slice(4));
    report.leaveOneMonthOut = heldOut;
    report.walkForward = {
        method: 'expanding',
        minTrainMonths: 4,
        causal: true,
        monthFrozen: true,
        weights: report.weights,
        weightsChanged: false,
        note: 'Кожен тестовий місяць порахований тим самим рушієм, але калібрування заморожене до першого дня місяця. Результати цього місяця в quintile і analog не входять.',
        folds: heldOut.folds.filter((fold) => proofMonths.has(fold.label)),
    };
    report.sessions = scored.filter((day) => day.complete).map(sessionRow);
    report.engineDays = scored.filter((day) => day.complete);
    report.breadthUnavailable = scored.every((day) => day.breadthUnavailable);
    report.note = 'Walk-forward scores use only market data and mechanical results from before each session. In-sample fit is not the proof. Confidence does not change the score. Breadth is omitted, not proxied, when the provider has no exchange diary.';
    return report;
}

function sessionRow(day) {
    const mechanical = day.mechanical || {};
    return {
        date: day.sessionDate,
        previousMarketDate: day.infoThrough,
        aggressivenessScore: day.displayScore,
        ruleScore: round(day.ruleScore, 2),
        analogScore: round(day.analogScore, 2),
        smallMicroScore: round(day.components?.smallMicro, 2),
        breadthScore: round(day.components?.breadth, 2),
        speculativeScore: round(day.components?.speculative, 2),
        broadMarketScore: round(day.components?.broadMarket, 2),
        macroScore: round(day.components?.macro, 2),
        mechanicalEntries: mechanical.entries ?? null,
        mechanicalTotalR: mechanical.totalR ?? null,
        mechanicalRPerTrade: mechanical.rPerTrade ?? null,
    };
}

function historyPoints(barsByKey, sessionDate, mechanicalByDate, breadthByDate) {
    return recentAggressiveness(barsByKey, sessionDate, 30, { mechanicalByDate, breadthByDate });
}

function stampProgression(series, sessionDate, displayScore, scored) {
    const next = (series || []).map((point) => ({ ...point }));
    const last = next.at(-1);
    const score = Number(displayScore);
    if (last && last.date === sessionDate && Number.isFinite(score)) {
        last.score = Math.round(score);
        last.ruleScore = scored?.ruleScore ?? last.ruleScore;
        last.analogScore = scored?.analogScore ?? last.analogScore;
        last.infoThrough = scored?.infoThrough || last.infoThrough;
    }
    return next;
}

function round(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const factor = 10 ** digits;
    return Math.round((number + Number.EPSILON) * factor) / factor;
}

function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export async function refreshDisplayScore(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    try {
        const provider = options.provider || createMarketDataProvider(options.env || process.env, options.fetchImpl || fetch, { allowPublic: true });
        return await buildGauge({ ...options, now, provider });
    } catch (error) {
        return { ok: false, incomplete: true, message: 'Data incomplete', error: error?.message || String(error) };
    }
}
