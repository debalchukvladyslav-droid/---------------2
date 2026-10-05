/** Ступінчастий risk manager: глибина + тривалість у dayloss, повернення повільніше за різку. */

const LEVELS = ['normal', 'caution', 'reduce', 'defensive', 'pause'];
const RISK_MULTIPLIER = {
    normal: 1,
    caution: 0.75,
    reduce: 0.5,
    defensive: 0.25,
    pause: 0,
};

/** Скільки dayloss треба відіграти від локального мінімуму, щоб увійти в м’якший рівень. */
const RECOVERY_TO_ENTER = {
    defensive: 1,
    reduce: 1,
    caution: 2,
    normal: 3,
};

function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(number * 100) / 100;
}

function levelRank(level) {
    const index = LEVELS.indexOf(level);
    return index < 0 ? 0 : index;
}

function harsher(a, b) {
    return levelRank(a) >= levelRank(b) ? a : b;
}

function lossAbs(dayloss, fallback = 1000) {
    const value = Math.abs(money(dayloss));
    return value > 0 ? value : fallback;
}

function previousMonthKey(monthKey) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return '';
    const date = new Date(Date.UTC(year, month - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeDays(days) {
    return (Array.isArray(days) ? days : [])
        .map((day) => ({
            date: String(day?.date || ''),
            pnl: Number(day?.pnl),
        }))
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(day.pnl))
        .sort((a, b) => a.date.localeCompare(b.date));
}

function buildCurve(days) {
    let equity = 0;
    let peak = 0;
    const monthPnl = {};
    return days.map((day) => {
        const monthKey = day.date.slice(0, 7);
        equity = money(equity + day.pnl);
        peak = money(Math.max(peak, equity));
        monthPnl[monthKey] = money((monthPnl[monthKey] || 0) + day.pnl);
        return {
            date: day.date,
            pnl: money(day.pnl),
            equity,
            peak,
            monthKey,
            monthPnl: monthPnl[monthKey],
            pullback: money(peak - equity),
        };
    });
}

/** Рівень за глибиною в одиницях dayloss (R ≤ 0). */
function levelFromDepthR(r) {
    if (r <= -3) return 'pause';
    if (r <= -2) return 'defensive';
    if (r <= -1) return 'reduce';
    if (r <= -0.5) return 'caution';
    return 'normal';
}

function equitySeverity(pullback, line) {
    if (!(line > 0) || pullback <= 0) return 'normal';
    return levelFromDepthR(-pullback / line);
}

function monthlySeverity(monthR) {
    return levelFromDepthR(monthR);
}

/**
 * Послідовність слабких місяців.
 * Два мінуси самі по собі ≠ pause: потрібна глибина поточного місяця.
 */
function streakSeverity(prevMonthR, currentMonthR) {
    if (prevMonthR <= -2 && currentMonthR <= -1.5) return 'pause';
    if (prevMonthR <= -1 && currentMonthR <= -0.75) return 'defensive';
    // Минулий був помітно червоним, поточний ще мінус, але майже flat → максимум reduce.
    if (prevMonthR <= -1 && currentMonthR < 0) return 'reduce';
    return 'normal';
}

function instantaneousSeverity({ pullback, line, monthR, prevMonthR }) {
    return harsher(
        equitySeverity(pullback, line),
        harsher(monthlySeverity(monthR), streakSeverity(prevMonthR, monthR))
    );
}

function recoveryAllows(level, recoveryR, atPeak) {
    if (level === 'pause') return true;
    if (atPeak) return true;
    const need = RECOVERY_TO_ENTER[level];
    return Number.isFinite(need) ? recoveryR >= need : true;
}

function stepLatchedLevel(latched, severity, recoveryR, atPeak) {
    let next = latched;
    if (levelRank(severity) > levelRank(next)) next = severity;

    while (levelRank(next) > levelRank(severity)) {
        const softer = LEVELS[levelRank(next) - 1];
        if (!recoveryAllows(softer, recoveryR, atPeak)) break;
        next = softer;
    }
    return next;
}

function latchRisk(curve, line, prevMonthByKey) {
    let level = 'normal';
    let trough = 0;
    let peak = 0;

    curve.forEach((point) => {
        peak = point.peak;
        if (point.pullback <= 0) trough = point.equity;
        else trough = Math.min(trough, point.equity);

        const atPeak = point.pullback <= 0;
        const recoveryR = line > 0 ? Math.max(0, (point.equity - trough) / line) : 0;
        const monthR = line > 0 ? point.monthPnl / line : 0;
        const prevMonthR = prevMonthByKey[point.monthKey] ?? 0;
        const severity = instantaneousSeverity({
            pullback: point.pullback,
            line,
            monthR,
            prevMonthR,
        });
        level = stepLatchedLevel(level, severity, recoveryR, atPeak);
    });

    const last = curve[curve.length - 1];
    const atPeak = !last || last.pullback <= 0;
    const recoveryR = last && line > 0 ? Math.max(0, (last.equity - trough) / line) : 0;
    return { level, recoveryR, trough, atPeak };
}

function riskPercent(level) {
    return Math.round((RISK_MULTIPLIER[level] ?? 1) * 100);
}

function buildText(level, { reason, monthR, prevMonthR, equityR, recoveryR }) {
    if (level === 'normal') return '';
    const pct = riskPercent(level);
    const head = `Ризик ${pct}%`;
    const depth = Math.abs(equityR).toFixed(1);
    const monthDepth = Math.abs(monthR).toFixed(1);

    if (reason === 'equity') {
        if (level === 'pause') {
            return `${head}. Відкат від піку ≈ ${depth} дейлос. Пауза до відновлення +1 дейлос від локального мінімуму.`;
        }
        if (level === 'defensive') {
            return `${head}. Глибокий відкат від піку (≈ ${depth} дейлос). Захисний режим.`;
        }
        if (level === 'reduce') {
            return `${head}. Відкат від піку ≈ ${depth} дейлос. Працюй половиною ризику до відновлення.`;
        }
        return `${head}. Невеликий відкат від піку. Трохи зменш розмір.`;
    }

    if (reason === 'streak') {
        if (level === 'pause') {
            return `${head}. Затяжна просадка: попередній місяць сильно мінусовий, поточний продовжує падіння.`;
        }
        if (level === 'defensive') {
            return `${head}. Просадка затяжна: попередній місяць був значно негативним, а поточний продовжує падіння. Захисний режим до відновлення +1 дейлос від локального мінімуму.`;
        }
        return `${head}. Другий місяць залишається слабким, але поточна просадка поки невелика. Працюй ${pct}% стандартного ризику до початку відновлення.`;
    }

    if (level === 'pause') {
        return `${head}. Місяць уже ≈ ${monthDepth} дейлос у мінусі. Пауза або мінімальний ризик.`;
    }
    if (level === 'defensive') {
        return `${head}. Місяць глибоко в мінусі (≈ ${monthDepth} дейлос). Захисний режим.`;
    }
    if (level === 'reduce') {
        return `${head}. Місяць близько −1 дейлос або гірше. Працюй половиною ризику.`;
    }
    if (prevMonthR <= -1 && monthR < 0) {
        return `${head}. Минулий місяць був слабким, поточний ще не відіграв. Тримай ризик меншим.`;
    }
    return `${head}. Місяць у невеликому мінусі. Можна трохи зменшити ризик.`;
}

function pickReason(level, equityLevel, monthLevel, streakLevel) {
    if (level === 'normal') return 'normal';
    if (levelRank(equityLevel) >= levelRank(level) && equityLevel !== 'normal') return 'equity';
    if (levelRank(streakLevel) >= levelRank(level) && streakLevel !== 'normal') return 'streak';
    if (levelRank(monthLevel) >= levelRank(level) && monthLevel !== 'normal') return 'month';
    if (streakLevel !== 'normal') return 'streak';
    if (monthLevel !== 'normal') return 'month';
    if (equityLevel !== 'normal') return 'equity';
    return 'month';
}

export function assessDrawdownRisk({ days, deposit, dayloss = -1000, previousDayloss = -1000 } = {}) {
    const curve = buildCurve(normalizeDays(days));
    if (!curve.length) {
        return {
            level: 'normal',
            text: '',
            reason: 'empty',
            pullback: 0,
            accountRatio: 0,
            riskMultiplier: 1,
            monthR: 0,
            prevMonthR: 0,
            equityR: 0,
        };
    }

    const last = curve[curve.length - 1];
    const monthKey = last.monthKey;
    const prevKey = previousMonthKey(monthKey);
    const line = lossAbs(dayloss);
    const prevLine = lossAbs(previousDayloss, line);

    const monthTotals = {};
    curve.forEach((point) => {
        monthTotals[point.monthKey] = point.monthPnl;
    });

    /** Для кожного місяця — R попереднього (у dayloss того попереднього місяця). */
    const prevMonthByKey = {};
    Object.keys(monthTotals).forEach((key) => {
        const prev = previousMonthKey(key);
        if (!prev || !Object.prototype.hasOwnProperty.call(monthTotals, prev)) {
            prevMonthByKey[key] = 0;
            return;
        }
        // Для попередніх місяців у кривій dayloss поточного/попереднього близькі;
        // фінальний prevMonthR для last рахуємо з previousDayloss нижче.
        prevMonthByKey[key] = monthTotals[prev] / (key === monthKey ? prevLine : line);
    });
    // Уточнення для поточного місяця: нормалізація через previousDayloss.
    if (Object.prototype.hasOwnProperty.call(monthTotals, prevKey)) {
        prevMonthByKey[monthKey] = monthTotals[prevKey] / prevLine;
    }

    const latched = latchRisk(curve, line, prevMonthByKey);
    const monthR = last.monthPnl / line;
    const prevMonthR = prevMonthByKey[monthKey] ?? 0;
    const equityR = last.pullback > 0 ? -last.pullback / line : 0;

    const equityLevel = equitySeverity(last.pullback, line);
    const monthLevel = monthlySeverity(monthR);
    const streakLevel = streakSeverity(prevMonthR, monthR);
    const spot = instantaneousSeverity({
        pullback: last.pullback,
        line,
        monthR,
        prevMonthR,
    });
    const level = latched.level;
    const reason = pickReason(level, equityLevel, monthLevel, streakLevel);

    const depositValue = Number(deposit);
    const accountRatio = Number.isFinite(depositValue) && depositValue > 0
        ? last.pullback / depositValue
        : 0;

    return {
        level,
        text: buildText(level, { reason, monthR, prevMonthR, equityR, recoveryR: latched.recoveryR }),
        reason: level === 'normal' ? 'normal' : reason,
        pullback: last.pullback,
        accountRatio,
        riskMultiplier: RISK_MULTIPLIER[level] ?? 1,
        monthPnl: last.monthPnl,
        monthPeak: money(Math.max(0, ...curve.filter((p) => p.monthKey === monthKey).map((p) => p.monthPnl))),
        monthR,
        prevMonthR,
        equityR,
        spotLevel: spot,
        recoveryR: latched.recoveryR,
    };
}

export { LEVELS, RISK_MULTIPLIER };
