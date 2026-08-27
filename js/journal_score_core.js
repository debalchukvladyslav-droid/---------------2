import { getNyseDaySchedule } from './nyse_calendar.js';

function hasText(value) { return String(value ?? '').trim().length > 0; }
function hasValues(value) { return value && typeof value === 'object' && Object.values(value).some((item) => hasText(item) || Number(item)); }
function screenshotsCount(day) { const groups = day?.screenshots && typeof day.screenshots === 'object' ? Object.values(day.screenshots) : []; return groups.reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0); }
function hasPnl(day) {
    const netPresent = day?.pnl !== null && day?.pnl !== undefined && day?.pnl !== '';
    const grossPresent = day?.gross_pnl !== null && day?.gross_pnl !== undefined && day?.gross_pnl !== '';
    const tradeEvidence = (Array.isArray(day?.trades) && day.trades.length > 0)
        || hasValues(day?.tradeTypesData) || hasValues(day?.fondexx) || hasValues(day?.ppro)
        || hasText(day?.fondexxSource) || hasText(day?.pproSource);
    if (tradeEvidence) return true;
    if ((netPresent && Number(day.pnl) !== 0) || (grossPresent && Number(day.gross_pnl) !== 0)) return true;
    // A manually completed break-even day may legitimately contain zero PnL.
    return (netPresent || grossPresent) && (
        hasText(day?.notes) || hasText(day?.nextSessionImprovement)
        || hasText(day?.sessionGoal) || hasText(day?.sessionPlan)
        || day?.sessionDone === true || day?.sessionReviewDone === true
    );
}
function monthKey(now) { const date = now instanceof Date ? now : new Date(now || Date.now()); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function localDateKey(now) { const date = now instanceof Date ? now : new Date(now || Date.now()); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function weekKey(dateStr) { const date = new Date(`${dateStr}T12:00:00Z`); const monday = new Date(date); const day = monday.getUTCDay() || 7; monday.setUTCDate(monday.getUTCDate() - day + 1); return monday.toISOString().slice(0, 10); }
function monthWorkDates(now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    const year = date.getFullYear();
    const month = date.getMonth();
    const result = [];
    for (let day = 1, last = new Date(year, month + 1, 0).getDate(); day <= last; day += 1) {
        const current = new Date(year, month, day);
        if (current.getDay() === 0 || current.getDay() === 6) continue;
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (getNyseDaySchedule(dateStr)?.type === 'closed') continue;
        result.push(dateStr);
    }
    return result;
}

export function isJournalActivityDay(day) {
    if (!day || typeof day !== 'object') return false;
    return hasPnl(day) || hasText(day.notes) || hasText(day.nextSessionImprovement) || hasText(day.sessionGoal) || hasText(day.sessionPlan) || hasText(day.sessionReadiness) || day.sessionDone === true || day.sessionReviewDone === true || (Array.isArray(day.checkedParams) && day.checkedParams.length > 0) || (Array.isArray(day.errors) && day.errors.length > 0) || hasValues(day.sliders) || screenshotsCount(day) > 0;
}

function dailyCore(day) {
    const checks = {
        pnl: hasPnl(day),
        thought: hasText(day.notes) || hasText(day.nextSessionImprovement),
        sessionStart: hasText(day.sessionGoal) || hasText(day.sessionPlan) || hasText(day.sessionReadiness),
        sessionEnd: day.sessionDone === true || day.sessionReviewDone === true || hasText(day.nextSessionImprovement),
    };
    return { checks };
}

export function calculateJournalScore({ journal = {}, reviews = [], learnCache = null, learningDates = [], now = new Date() } = {}) {
    const prefix = `${monthKey(now)}-`;
    const todayKey = localDateKey(now);
    const calendarWorkDates = monthWorkDates(now).filter((date) => date <= todayKey);
    const absentDates = new Set(calendarWorkDates.filter((date) => journal?.[date]?.traderAbsent === true));
    const workDates = calendarWorkDates.filter((date) => !absentDates.has(date));
    const workDateSet = new Set(workDates);
    const monthEntries = Object.entries(journal).filter(([date, day]) => date.startsWith(prefix) && workDateSet.has(date) && isJournalActivityDay(day));
    const workDays = workDates.length;

    const core = { label: 'PnL + думка дня', done: 0, total: workDays, weight: 10 };
    const session = { label: 'Початок + завершення сесії', done: 0, total: workDays, weight: 6 };
    monthEntries.forEach(([, day]) => {
        const result = dailyCore(day);
        if (result.checks.pnl && result.checks.thought) core.done += 1;
        if (result.checks.sessionStart) session.done += 0.5;
        if (result.checks.sessionEnd) session.done += 0.5;
    });

    const coreRatio = workDays ? core.done / workDays : 0;
    const sessionRatio = workDays ? session.done / workDays : 0;
    const relevantReviews = reviews.filter((review) => {
        const date = String(review?.trade_date || '');
        return review?.active && date.startsWith(prefix) && date <= todayKey && workDateSet.has(date);
    });
    const completedReviews = relevantReviews.filter((review) => review.final_status === 'normal' || review.final_status === 'bad').length;
    const stops = { label: 'Розбір стопів', done: completedReviews, total: relevantReviews.length, weight: 1 };
    const stopsRatio = stops.total ? stops.done / stops.total : 0;
    const score = workDays ? Math.max(0, Math.min(10, Math.round((coreRatio * 6 + sessionRatio * 3 + stopsRatio) * 10) / 10)) : 0;
    const label = score >= 8.5 ? 'Системно' : score >= 7 ? 'Добре' : score >= 5 ? 'Набирає ритм' : 'Потрібна увага';
    const gaps = [
        { ...core, ratio: core.total ? core.done / core.total : 1 },
        { ...session, ratio: session.total ? session.done / session.total : 1 },
        { ...stops, ratio: stopsRatio },
    ];
    return { score, label, activeDays: core.done, workDays, absentDays: absentDates.size, gaps, details: 'Поточний місяць до сьогодні включно. PnL + думка дня дають 60% оцінки. Сесія дає 30%: початок і завершення мають по половині денного бала. Розбір усіх стопів дає 10%. Майбутні та позначені як відсутність дні не входять у план.' };
}
