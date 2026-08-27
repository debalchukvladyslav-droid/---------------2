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
    const checks = { pnl: hasPnl(day), thought: hasText(day.notes) || hasText(day.nextSessionImprovement), sessionStart: hasText(day.sessionGoal) || hasText(day.sessionPlan) || hasText(day.sessionReadiness), sessionEnd: day.sessionDone === true || day.sessionReviewDone === true || hasText(day.nextSessionImprovement), screenshots: screenshotsCount(day) > 0 };
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

    const habits = {
        core: { label: 'PnL + думка дня', done: 0, total: workDays, weight: 10 },
        pnl: { label: 'PnL дня', done: 0, total: workDays, weight: 5 },
        thought: { label: 'Думка або висновок дня', done: 0, total: workDays, weight: 5 },
        sessionStart: { label: 'Початок сесії', done: 0, total: workDays, weight: 3 },
        sessionEnd: { label: 'Завершення сесії', done: 0, total: workDays, weight: 3 },
        screenshots: { label: 'Розбір скріншотів', done: 0, total: workDays, weight: 2 },
    };
    monthEntries.forEach(([, day]) => {
        const result = dailyCore(day);
        Object.keys(result.checks).forEach((key) => { if (result.checks[key]) habits[key].done += 1; });
        if (result.checks.pnl && result.checks.thought) habits.core.done += 1;
    });

    const relevantReviews = reviews.filter((review) => review?.active && String(review.trade_date || '').startsWith(prefix));
    const completedReviews = relevantReviews.filter((review) => review.final_status === 'normal' || review.final_status === 'bad').length;
    if (relevantReviews.length) habits.stops = { label: 'Розбір стопів', done: completedReviews, total: relevantReviews.length, weight: 2 };

    const activeWeeks = new Set(workDates.filter((date) => date <= todayKey).map(weekKey));
    const recordedLearningDates = new Set([...(Array.isArray(learningDates) ? learningDates : []), learnCache?.date].filter((date) => String(date || '').startsWith(prefix)));
    const learnedWeeks = new Set([...recordedLearningDates].map(weekKey));
    const learningDone = [...activeWeeks].filter((week) => learnedWeeks.has(week)).length;
    habits.learning = { label: 'Навчання раз на тиждень', done: learningDone, total: activeWeeks.size, weight: 1 };

    const score = workDays ? Math.max(0, Math.min(10, Math.round((habits.core.done / workDays) * 100) / 10)) : 0;
    const label = score >= 8.5 ? 'Системно' : score >= 7 ? 'Добре' : score >= 5 ? 'Набирає ритм' : 'Потрібна увага';
    const gaps = Object.values(habits).map((item) => ({ ...item, ratio: item.total ? item.done / item.total : 1 })).filter((item) => item.ratio < .8).sort((a, b) => b.weight - a.weight || a.ratio - b.ratio).slice(0, 6);
    return { score, label, activeDays: habits.core.done, workDays, absentDays: absentDates.size, gaps, details: 'Поточний місяць до сьогодні включно. Оцінка — це частка вже минулих робочих днів, у яких одночасно записані PnL і думка дня. Майбутні та позначені як відсутність дні не входять у план.' };
}
