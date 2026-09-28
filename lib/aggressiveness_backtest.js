import {
    FEATURES,
    SCORE_VERSION,
    resolveWeights,
    scoreCalendar,
} from './aggressiveness_core.js';

export function bucketId(score) {
    const value = Math.round(Number(score));
    if (!Number.isFinite(value)) return null;
    if (value <= 19) return '0-19';
    if (value <= 39) return '20-39';
    if (value <= 59) return '40-59';
    if (value <= 79) return '60-79';
    return '80-100';
}

export const BUCKET_ORDER = ['0-19', '20-39', '40-59', '60-79', '80-100'];

function emptyBucket(id) {
    return {
        id,
        days: 0,
        trades: 0,
        totalR: 0,
        rPerTrade: null,
        medianRPerTrade: null,
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
        dailyR: [],
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
        rPerTrade: entries > 0 ? totalR / entries : null,
        wins,
        avgWinner: mechanical.avgWinner ?? day.mechanicalAvgWinner,
        avgLoser: mechanical.avgLoser ?? day.mechanicalAvgLoser,
    };
}

function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
        bucket.dailyR.push(mechanical.rPerTrade);
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
        medianRPerTrade: round(median(bucket.dailyR), 4),
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
    const ranked = [...days].filter((day) => {
        const mechanical = mechanicalOf(day);
        return mechanical.entries > 0 && Number.isFinite(Number(day.displayScore ?? day.liveScore ?? day.score));
    });
    ranked.sort((left, right) => Number(right.displayScore ?? right.liveScore ?? right.score) - Number(left.displayScore ?? left.liveScore ?? left.score));
    const count = Math.max(1, Math.round(ranked.length * 0.2));
    const top = summarizeDays(ranked.slice(0, count));
    const bottom = summarizeDays(ranked.slice(-count));
    return {
        sample: ranked.length,
        count,
        ranked: 'days with mechanical entries',
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
        medianRPerTrade: summary.medianRPerTrade,
        winRate: summary.winRate,
        positiveDayPct: summary.positiveDayPct,
        topVsBottomR: tails.rPerTradeSpread,
    };
}

function groupMonths(days) {
    const months = new Map();
    const ordered = [...days].sort((left, right) => String(left.sessionDate || left.date).localeCompare(String(right.sessionDate || right.date)));
    for (const day of ordered) {
        const key = monthKey(day.sessionDate || day.date);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(day);
    }
    return months;
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
        causal: true,
        weights: resolveWeights(),
        weightsChanged: false,
        folds,
    };
}

export function leaveOneMonthOutScores(barsByKey, mechanicalByDate, dates, options = {}) {
    const months = new Map();
    for (const date of dates) {
        const key = monthKey(date);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(date);
    }
    const folds = [];
    for (const [key, testDates] of months) {
        const scored = scoreCalendar(barsByKey, mechanicalByDate, testDates, {
            breadthByDate: options.breadthByDate || {},
            trainFilter: (sessionDate) => monthKey(sessionDate) !== key,
        }).filter((day) => day.complete).map((day) => ({
            ...day,
            mechanical: mechanicalByDate?.[day.sessionDate] || null,
        }));
        folds.push(foldResult(key, scored, [...months.keys()].filter((item) => item !== key && item < key)));
    }
    return {
        method: 'leave-one-month-out',
        diagnostic: true,
        usesFuture: false,
        weights: resolveWeights(),
        weightsChanged: false,
        folds,
    };
}

function pearson(xs, ys) {
    if (xs.length < 3 || xs.length !== ys.length) return null;
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    let numerator = 0;
    let dx = 0;
    let dy = 0;
    for (let index = 0; index < xs.length; index += 1) {
        const left = xs[index] - meanX;
        const right = ys[index] - meanY;
        numerator += left * right;
        dx += left * left;
        dy += right * right;
    }
    if (!(dx > 0) || !(dy > 0)) return null;
    return numerator / Math.sqrt(dx * dy);
}

function ranks(values) {
    const order = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
    const rank = new Array(values.length);
    let cursor = 0;
    while (cursor < order.length) {
        let end = cursor;
        while (end + 1 < order.length && order[end + 1].value === order[cursor].value) end += 1;
        const averageRank = (cursor + end) / 2 + 1;
        for (let index = cursor; index <= end; index += 1) rank[order[index].index] = averageRank;
        cursor = end + 1;
    }
    return rank;
}

export function featureDiagnostics(days) {
    const grouped = new Map();
    for (const day of days) {
        const mechanical = mechanicalOf(day);
        if (!(mechanical.entries > 0) || !day.assignments) continue;
        for (const [key, assignment] of Object.entries(day.assignments)) {
            if (!Number.isFinite(assignment?.value) || assignment.quintile == null) continue;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push({
                value: assignment.value,
                quintile: assignment.quintile,
                entries: mechanical.entries,
                totalR: mechanical.totalR,
                rPerTrade: mechanical.rPerTrade,
                positive: mechanical.totalR > 0,
            });
        }
    }
    return FEATURES.map((feature) => {
        const rows = grouped.get(feature.key) || [];
        const quintiles = [1, 2, 3, 4, 5].map((id) => {
            const bucket = rows.filter((row) => row.quintile === id);
            const trades = bucket.reduce((sum, row) => sum + row.entries, 0);
            const totalR = bucket.reduce((sum, row) => sum + row.totalR, 0);
            return {
                id: `Q${id}`,
                sample: bucket.length,
                trades,
                avgR: trades > 0 ? round(totalR / trades, 4) : null,
                medianR: round(median(bucket.map((row) => row.rPerTrade)), 4),
                positiveDayRate: bucket.length ? round(bucket.filter((row) => row.positive).length / bucket.length, 4) : null,
            };
        });
        const xs = rows.map((row) => row.value);
        const ys = rows.map((row) => row.rPerTrade);
        return {
            key: feature.key,
            label: feature.label,
            block: feature.block,
            sample: rows.length,
            correlation: round(pearson(xs, ys), 4),
            spearman: round(pearson(ranks(xs), ranks(ys)), 4),
            quintiles,
            note: 'Quintiles are the buckets each day fell into using only earlier history. Correlation is descriptive and is not the score.',
        };
    }).filter((feature) => feature.sample > 0);
}

export function buildBacktestReport(scoredDays) {
    const days = scoredDays.filter((day) => day.complete !== false && Number.isFinite(Number(day.displayScore ?? day.liveScore)));
    return {
        scoreVersion: SCORE_VERSION,
        weightsChanged: false,
        weights: resolveWeights(),
        target: 'mechanical R per trade on the scored session. Information cutoff is the prior close. The same scoreSession engine produces these rows.',
        days: days.length,
        buckets: bucketStats(days),
        tails: tailComparison(days),
        walkForward: expandingWalkForward(days),
        leaveOneMonthOut: null,
        featureDiagnostics: featureDiagnostics(days),
        systemHealth: null,
    };
}

function round(value, digits = 4) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const factor = 10 ** digits;
    return Math.round((number + Number.EPSILON) * factor) / factor;
}
