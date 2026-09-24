import { SCORE_VERSION, nextTradingDay, resolveWeights } from './aggressiveness_core.js';

export function bucketId(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return null;
    if (value < 20) return '0-20';
    if (value < 40) return '20-40';
    if (value < 60) return '40-60';
    if (value < 80) return '60-80';
    return '80-100';
}

export const BUCKET_ORDER = ['0-20', '20-40', '40-60', '60-80', '80-100'];

function emptyBucket(id) {
    return {
        id,
        days: 0,
        trades: 0,
        totalR: 0,
        rPerTrade: null,
        winRate: null,
        avgWinner: null,
        avgLoser: null,
        positiveDayPct: null,
        wins: 0,
        losses: 0,
        winnerR: 0,
        loserR: 0,
        positiveDays: 0,
        tradedDays: 0,
    };
}

function mechanicalOf(day) {
    const mechanical = day.mechanical || {};
    const entries = Number(mechanical.entries ?? day.mechanicalEntries ?? 0) || 0;
    const totalR = Number(mechanical.totalR ?? day.mechanicalTotalR ?? 0) || 0;
    const winRate = mechanical.winRate ?? day.mechanicalWinRate;
    const wins = mechanical.wins != null ? Number(mechanical.wins) : (Number.isFinite(Number(winRate)) ? Number(winRate) * entries : null);
    return {
        entries,
        totalR,
        wins,
        avgWinner: mechanical.avgWinner ?? day.mechanicalAvgWinner,
        avgLoser: mechanical.avgLoser ?? day.mechanicalAvgLoser,
    };
}

export function summarizeDays(days) {
    const bucket = emptyBucket('sample');
    for (const day of days) {
        bucket.days += 1;
        const mechanical = mechanicalOf(day);
        if (!(mechanical.entries > 0)) continue;
        bucket.tradedDays += 1;
        bucket.trades += mechanical.entries;
        bucket.totalR += mechanical.totalR;
        if (mechanical.totalR > 0) bucket.positiveDays += 1;
        if (mechanical.wins != null) {
            const wins = Math.max(0, Math.min(mechanical.entries, mechanical.wins));
            const losses = Math.max(0, mechanical.entries - wins);
            bucket.wins += wins;
            bucket.losses += losses;
            if (Number.isFinite(Number(mechanical.avgWinner))) bucket.winnerR += Number(mechanical.avgWinner) * wins;
            if (Number.isFinite(Number(mechanical.avgLoser))) bucket.loserR += Number(mechanical.avgLoser) * losses;
        }
    }
    return {
        days: bucket.days,
        trades: bucket.trades,
        totalR: round(bucket.totalR),
        rPerTrade: bucket.trades > 0 ? round(bucket.totalR / bucket.trades, 4) : null,
        winRate: bucket.trades > 0 && bucket.wins + bucket.losses > 0 ? round(bucket.wins / bucket.trades, 4) : null,
        avgWinner: bucket.wins > 0 ? round(bucket.winnerR / bucket.wins, 4) : null,
        avgLoser: bucket.losses > 0 ? round(bucket.loserR / bucket.losses, 4) : null,
        positiveDayPct: bucket.tradedDays > 0 ? round(bucket.positiveDays / bucket.tradedDays, 4) : null,
    };
}

export function bucketStats(days) {
    const groups = new Map(BUCKET_ORDER.map((id) => [id, []]));
    for (const day of days) {
        const id = bucketId(day.displayScore ?? day.liveScore ?? day.score);
        if (groups.has(id)) groups.get(id).push(day);
    }
    return BUCKET_ORDER.map((id) => ({ id, ...summarizeDays(groups.get(id)) }));
}

export function tailComparison(days) {
    const ranked = [...days].filter((day) => Number.isFinite(Number(day.displayScore ?? day.liveScore ?? day.score)));
    ranked.sort((a, b) => Number(b.displayScore ?? b.liveScore ?? b.score) - Number(a.displayScore ?? a.liveScore ?? a.score));
    const count = Math.max(1, Math.round(ranked.length * 0.2));
    const top = summarizeDays(ranked.slice(0, count));
    const bottom = summarizeDays(ranked.slice(-count));
    return {
        sample: ranked.length,
        count,
        top,
        bottom,
        rPerTradeSpread: top.rPerTrade != null && bottom.rPerTrade != null ? round(top.rPerTrade - bottom.rPerTrade, 4) : null,
    };
}

function monthKey(isoDate) {
    return String(isoDate).slice(0, 7);
}

function foldResult(label, testDays, trainMonths) {
    const summary = summarizeDays(testDays);
    const tails = tailComparison(testDays);
    return {
        label,
        trainMonths,
        scoreVersion: SCORE_VERSION,
        weightsChanged: false,
        days: summary.days,
        trades: summary.trades,
        totalR: summary.totalR,
        rPerTrade: summary.rPerTrade,
        winRate: summary.winRate,
        positiveDayPct: summary.positiveDayPct,
        topVsBottomR: tails.rPerTradeSpread,
    };
}

export function expandingWalkForward(days, { minTrainMonths = 4 } = {}) {
    const months = groupMonths(days);
    const keys = [...months.keys()];
    const folds = [];
    for (let index = minTrainMonths; index < keys.length; index += 1) {
        const testKey = keys[index];
        folds.push(foldResult(testKey, months.get(testKey), keys.slice(0, index)));
    }
    return {
        method: 'expanding',
        minTrainMonths,
        weights: resolveWeights(),
        weightsChanged: false,
        folds,
    };
}

export function leaveOneMonthOut(days) {
    const months = groupMonths(days);
    const keys = [...months.keys()];
    return {
        method: 'leave-one-month-out',
        weights: resolveWeights(),
        weightsChanged: false,
        folds: keys.map((key) => foldResult(key, months.get(key), keys.filter((item) => item !== key))),
    };
}

function groupMonths(days) {
    const months = new Map();
    const ordered = [...days].sort((a, b) => String(a.sessionDate).localeCompare(String(b.sessionDate)));
    for (const day of ordered) {
        const key = monthKey(day.sessionDate);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(day);
    }
    return months;
}

export function featureStability(days) {
    const months = groupMonths(days);
    const features = [
        ['microSmall', 'Micro/Small breadth'],
        ['speculative', 'Speculative appetite'],
        ['broad', 'Broad market'],
        ['stress', 'Stress safety'],
    ];
    return features.map(([key, label]) => {
        const monthly = [];
        for (const [month, rows] of months) {
            const high = rows.filter((day) => component(day, key) >= 60);
            const low = rows.filter((day) => component(day, key) <= 40);
            const highSummary = summarizeDays(high);
            const lowSummary = summarizeDays(low);
            if (highSummary.trades < 5 || lowSummary.trades < 5) continue;
            monthly.push({
                month,
                spread: highSummary.rPerTrade - lowSummary.rPerTrade,
            });
        }
        const signs = monthly.map((item) => Math.sign(item.spread));
        const positive = signs.filter((sign) => sign > 0).length;
        const direction = positive >= signs.length - positive ? 1 : -1;
        const sameDirection = signs.filter((sign) => sign === direction).length;
        const withoutOutlier = monthly.length > 1
            ? monthly.filter((item) => item !== monthly.reduce((peak, row) => Math.abs(row.spread) > Math.abs(peak.spread) ? row : peak))
            : [];
        const outlierStillAgrees = withoutOutlier.length > 0
            && Math.sign(withoutOutlier.reduce((sum, item) => sum + item.spread, 0)) === direction;
        const stable = monthly.length >= 3 && sameDirection / monthly.length >= 0.7 && outlierStillAgrees;
        return {
            feature: key,
            label,
            months: monthly.length,
            stable,
            higherScoreBetter: stable && direction > 0,
            weightUpdate: null,
        };
    });
}

function component(day, key) {
    return Number(day.components?.[key] ?? day[key]);
}

export function attachSessionMechanical(scoredDays, mechanicalByDate = {}) {
    return scoredDays.map((day) => ({
        ...day,
        outcomeDate: day.sessionDate,
        infoThrough: day.infoThrough,
        mechanical: mechanicalByDate[day.sessionDate] || null,
        nextSessionDate: nextTradingDay(day.sessionDate),
    }));
}

export function buildBacktestReport(scoredDays) {
    const days = scoredDays.filter((day) => day.complete !== false && Number.isFinite(Number(day.displayScore ?? day.liveScore)));
    return {
        scoreVersion: SCORE_VERSION,
        weightsChanged: false,
        weights: resolveWeights(),
        target: 'mechanical R per trade on the scored session (information cutoff is the prior close)',
        days: days.length,
        buckets: bucketStats(days),
        tails: tailComparison(days),
        walkForward: expandingWalkForward(days),
        leaveOneMonthOut: leaveOneMonthOut(days),
        featureReviews: featureStability(days),
        systemHealth: null,
    };
}

function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
