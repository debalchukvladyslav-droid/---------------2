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
function weekKey(dateStr) { const date = new Date(`${dateStr}T12:00:00Z`); const monday = new Date(date); const day = monday.getUTCDay() || 7; monday.setUTCDate(monday.getUTCDate() - day + 1); return monday.toISOString().slice(0, 10); }

export function isJournalActivityDay(day) {
    if (!day || typeof day !== 'object') return false;
    return hasPnl(day) || hasText(day.notes) || hasText(day.nextSessionImprovement) || hasText(day.sessionGoal) || hasText(day.sessionPlan) || hasText(day.sessionReadiness) || day.sessionDone === true || day.sessionReviewDone === true || (Array.isArray(day.checkedParams) && day.checkedParams.length > 0) || (Array.isArray(day.errors) && day.errors.length > 0) || hasValues(day.sliders) || screenshotsCount(day) > 0;
}

function dailyCore(day) {
    const checks = { pnl: hasPnl(day), thought: hasText(day.notes) || hasText(day.nextSessionImprovement), sessionStart: hasText(day.sessionGoal) || hasText(day.sessionPlan) || hasText(day.sessionReadiness), sessionEnd: day.sessionDone === true || day.sessionReviewDone === true || hasText(day.nextSessionImprovement), screenshots: screenshotsCount(day) > 0 };
    const points = (checks.pnl ? 2.5 : 0) + (checks.thought ? 2.5 : 0) + (checks.sessionStart ? 1 : 0) + (checks.sessionEnd ? 1 : 0) + (checks.screenshots ? 1 : 0);
    return { checks, points };
}

export function calculateJournalScore({ journal = {}, reviews = [], learnCache = null, learningDates = [], now = new Date() } = {}) {
    const prefix = `${monthKey(now)}-`;
    const monthEntries = Object.entries(journal).filter(([date, day]) => date.startsWith(prefix) && isJournalActivityDay(day));
    const activeDates = new Set(monthEntries.map(([date]) => date));
    if (!activeDates.size) return { score: null, label: 'Немає даних', activeDays: 0, details: 'Оцінка рахується лише за поточний місяць.', gaps: [{ label: 'Запишіть PnL і думку першого торгового дня', done: 0, total: 1 }] };

    const habits = {
        pnl: { label: 'PnL дня', done: 0, total: activeDates.size, weight: 5 },
        thought: { label: 'Думка або висновок дня', done: 0, total: activeDates.size, weight: 5 },
        sessionStart: { label: 'Початок сесії', done: 0, total: activeDates.size, weight: 3 },
        sessionEnd: { label: 'Завершення сесії', done: 0, total: activeDates.size, weight: 3 },
        screenshots: { label: 'Розбір скріншотів', done: 0, total: activeDates.size, weight: 2 },
    };
    let dailyPoints = 0;
    monthEntries.forEach(([, day]) => { const result = dailyCore(day); dailyPoints += result.points; Object.keys(result.checks).forEach((key) => { if (result.checks[key]) habits[key].done += 1; }); });
    const dailyScore = dailyPoints / activeDates.size;

    const relevantReviews = reviews.filter((review) => review?.active && String(review.trade_date || '').startsWith(prefix));
    const completedReviews = relevantReviews.filter((review) => review.final_status === 'normal' || review.final_status === 'bad').length;
    const stopScore = relevantReviews.length ? completedReviews / relevantReviews.length : 1;
    if (relevantReviews.length) habits.stops = { label: 'Розбір стопів', done: completedReviews, total: relevantReviews.length, weight: 2 };

    const activeWeeks = new Set([...activeDates].map(weekKey));
    const recordedLearningDates = new Set([...(Array.isArray(learningDates) ? learningDates : []), learnCache?.date].filter((date) => String(date || '').startsWith(prefix)));
    const learnedWeeks = new Set([...recordedLearningDates].map(weekKey));
    const learningDone = [...activeWeeks].filter((week) => learnedWeeks.has(week)).length;
    const learningScore = activeWeeks.size ? learningDone / activeWeeks.size : 0;
    habits.learning = { label: 'Навчання раз на тиждень', done: learningDone, total: activeWeeks.size, weight: 1 };

    const score = Math.max(0, Math.min(10, Math.round((dailyScore + stopScore + learningScore) * 10) / 10));
    const label = score >= 8.5 ? 'Системно' : score >= 7 ? 'Добре' : score >= 5 ? 'Набирає ритм' : 'Потрібна увага';
    const gaps = Object.values(habits).map((item) => ({ ...item, ratio: item.total ? item.done / item.total : 1 })).filter((item) => item.ratio < .8).sort((a, b) => b.weight - a.weight || a.ratio - b.ratio).slice(0, 6);
    return { score, label, activeDays: activeDates.size, gaps, details: 'Поточний місяць. PnL і думка — 5 балів; початок і завершення сесії — 2; скріншоти — 1; стопи — до 1; навчання раз на тиждень — до 1.' };
}
