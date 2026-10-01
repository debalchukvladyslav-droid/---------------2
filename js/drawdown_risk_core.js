/** Підказка біля відкату: місяць задає тон, 10% депозиту — жорстке гальмо. */

const LEVELS = ['calm', 'soften', 'cut', 'quarter', 'pause'];
const ACCOUNT_ENTER = { soften: 0.05, cut: 0.10, quarter: 0.15, pause: 0.20 };
const ACCOUNT_EXIT = { soften: 0.02, cut: 0.05, quarter: 0.10, pause: 0.15 };

function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(number * 100) / 100;
}

function levelRank(level) {
    const index = LEVELS.indexOf(level);
    return index < 0 ? 0 : index;
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
            monthPnl: monthPnl[monthKey],
            pullback: money(peak - equity),
        };
    });
}

function stepAccount(level, ratio) {
    let escalated = 'calm';
    if (ratio >= ACCOUNT_ENTER.pause) escalated = 'pause';
    else if (ratio >= ACCOUNT_ENTER.quarter) escalated = 'quarter';
    else if (ratio >= ACCOUNT_ENTER.cut) escalated = 'cut';
    else if (ratio >= ACCOUNT_ENTER.soften) escalated = 'soften';
    if (levelRank(escalated) > levelRank(level)) return escalated;

    let next = level;
    while (next !== 'calm' && ratio < ACCOUNT_EXIT[next]) {
        next = LEVELS[levelRank(next) - 1];
    }
    return next;
}

function latchAccount(curve, deposit) {
    let level = 'calm';
    curve.forEach((point) => {
        level = stepAccount(level, point.pullback / deposit);
    });
    const current = curve[curve.length - 1];
    return {
        level,
        ratio: current ? current.pullback / deposit : 0,
    };
}

function accountText(level, ratio) {
    const percent = Math.max(1, Math.round(ratio * 100));
    if (level === 'pause') return `Відкат ${percent}% депозиту. Пауза і розбір.`;
    if (level === 'quarter') return `Відкат ${percent}% депозиту. Ризик на чверть.`;
    if (level === 'cut') return `Відкат ${percent}% депозиту. Варто порізати ризик удвічі.`;
    if (level === 'soften') return `Відкат ${percent}% депозиту. Можна трохи зменшити ризик.`;
    return '';
}

function monthlyAdvice({ monthNow, monthPeak, prevMonthPnl, dayloss, previousDayloss }) {
    const lossLine = Math.max(1, Math.abs(money(dayloss)) || 1000);
    const prevLine = Math.max(1, Math.abs(money(previousDayloss)) || lossLine);
    const prevRed = prevMonthPnl <= -prevLine;
    const monthRed = monthNow < -0.004;
    const monthSerious = monthNow <= -lossLine;
    const giveback = Math.max(0, money(monthPeak - monthNow));
    const ratio = monthPeak > 0 ? giveback / monthPeak : 0;
    const meaningfulGiveback = giveback >= lossLine;
    const mostGiveback = monthPeak > 0 && ratio >= 0.5 && meaningfulGiveback;
    const someGiveback = monthPeak > 0 && ratio >= 0.3 && meaningfulGiveback;

    if (prevRed && monthRed) {
        return { level: 'pause', text: 'Другий місяць у мінусі. Пауза або ризик на чверть.' };
    }
    if (monthSerious || (monthRed && mostGiveback)) {
        return { level: 'cut', text: 'Місяць у мінусі. Поріж ризик удвічі.' };
    }
    if (prevRed && mostGiveback) {
        return { level: 'quarter', text: 'Минулий місяць у мінусі, і цей віддає прибуток. Поріж ризик.' };
    }
    if (monthNow > 0 && mostGiveback) {
        return { level: 'cut', text: 'Віддав більшу частину місяця. Варто порізати ризик.' };
    }
    if (prevRed && someGiveback) {
        return { level: 'cut', text: 'Минулий місяць у мінусі, і цей віддає прибуток. Поріж ризик.' };
    }
    if (monthRed) {
        return { level: 'soften', text: 'Місяць у мінусі. Можна трохи зменшити ризик.' };
    }
    if (monthNow > 0 && someGiveback) {
        return { level: 'soften', text: 'Віддаєш прибуток місяця. Можна трохи зменшити ризик.' };
    }
    if (prevRed) {
        return { level: 'soften', text: 'Минулий місяць у мінусі. Тримай ризик меншим.' };
    }
    return { level: 'calm', text: '' };
}

function chooseText(level, account, monthly) {
    if (level === 'calm') return '';
    const accountRank = levelRank(account.level);
    const monthlyRank = levelRank(monthly.level);
    if (accountRank >= monthlyRank && accountRank >= levelRank('cut')) return accountText(account.level, account.ratio);
    if (monthlyRank >= accountRank && monthly.text) return monthly.text;
    if (account.text) return account.text;
    return monthly.text || '';
}

export function assessDrawdownRisk({ days, deposit, dayloss = -1000, previousDayloss = -1000 } = {}) {
    const curve = buildCurve(normalizeDays(days));
    if (!curve.length) {
        return { level: 'calm', text: '', reason: 'empty', pullback: 0, accountRatio: 0 };
    }

    const last = curve[curve.length - 1];
    const monthKey = last.date.slice(0, 7);
    const prevKey = previousMonthKey(monthKey);
    let monthPeak = 0;
    curve.forEach((point) => {
        if (point.date.slice(0, 7) !== monthKey) return;
        monthPeak = Math.max(monthPeak, point.monthPnl);
    });
    const prevPoint = [...curve].reverse().find((point) => point.date.slice(0, 7) === prevKey);
    const depositValue = Number(deposit);
    const hasDeposit = Number.isFinite(depositValue) && depositValue > 0;
    const account = hasDeposit
        ? latchAccount(curve, depositValue)
        : { level: 'calm', ratio: 0 };
    account.text = accountText(account.level, account.ratio);
    const monthly = monthlyAdvice({
        monthNow: last.monthPnl,
        monthPeak,
        prevMonthPnl: prevPoint ? prevPoint.monthPnl : 0,
        dayloss,
        previousDayloss,
    });
    const level = LEVELS[Math.max(levelRank(account.level), levelRank(monthly.level))];

    return {
        level,
        text: chooseText(level, account, monthly),
        reason: levelRank(account.level) >= levelRank(monthly.level) && account.level !== 'calm' ? 'account' : monthly.level === 'calm' ? 'calm' : 'month',
        pullback: last.pullback,
        accountRatio: account.ratio,
        monthPnl: last.monthPnl,
        monthPeak: money(monthPeak),
    };
}
