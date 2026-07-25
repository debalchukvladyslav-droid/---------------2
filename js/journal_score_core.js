function hasText(value) {
    return String(value ?? '').trim().length > 0;
}

function hasValues(value) {
    return value && typeof value === 'object' && Object.values(value).some(item => hasText(item) || Number(item));
}

function screenshotsCount(day) {
    const groups = day?.screenshots && typeof day.screenshots === 'object' ? Object.values(day.screenshots) : [];
    return groups.reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
}

export function isJournalActivityDay(day) {
    if (!day || typeof day !== 'object') return false;
    return hasText(day.notes)
        || hasText(day.nextSessionImprovement)
        || hasText(day.sessionGoal)
        || hasText(day.sessionPlan)
        || hasText(day.sessionReadiness)
        || day.sessionDone === true
        || day.sessionReviewDone === true
        || (Array.isArray(day.checkedParams) && day.checkedParams.length > 0)
        || (Array.isArray(day.errors) && day.errors.length > 0)
        || hasValues(day.sliders)
        || screenshotsCount(day) > 0;
}

function dayJournalScore(day) {
    let score = 0;
    if (hasText(day.notes)) score += 1.25;
    if (hasText(day.nextSessionImprovement)) score += .75;
    if (hasText(day.sessionGoal) || hasText(day.sessionPlan)) score += 1;
    if (hasText(day.sessionReadiness) || day.sessionDone === true) score += .5;
    if (day.sessionReviewDone === true || (Array.isArray(day.errors) && day.errors.length) || (Array.isArray(day.checkedParams) && day.checkedParams.length)) score += 1;
    const hasTrades = (Array.isArray(day?.trades) && day.trades.length > 0) || hasValues(day?.tradeTypesData) || Boolean(day?.fondexx) || Boolean(day?.ppro);
    if (hasTrades) score += 1.5;
    if (screenshotsCount(day)) score += 1;
    return Math.min(7, score);
}

export function calculateJournalScore({ journal = {}, reviews = [], learnCache = null } = {}) {
    const reviewByDate = new Map();
    reviews.forEach(review => {
        if (!review?.trade_date || !review.active) return;
        const current = reviewByDate.get(review.trade_date) || { total: 0, completed: 0 };
        current.total += 1;
        if (review.final_status === 'normal' || review.final_status === 'bad') current.completed += 1;
        reviewByDate.set(review.trade_date, current);
    });
    const activeDates = new Set(Object.entries(journal).filter(([, day]) => isJournalActivityDay(day)).map(([date]) => date));
    if (!activeDates.size) return { score: null, label: 'Немає даних', activeDays: 0, details: 'Позначте день або сесію, щоб почати розрахунок.' };
    let total = 0;
    activeDates.forEach(date => {
        let daily = dayJournalScore(journal[date] || {});
        const review = reviewByDate.get(date);
        if (review?.total) daily += 2 * (review.completed / review.total);
        if (learnCache?.date === date && Object.keys(learnCache.summaries || {}).length) daily += 1;
        total += Math.min(10, daily);
    });
    const score = Math.max(1, Math.min(10, Math.round((total / activeDates.size) * 10) / 10));
    const label = score >= 8.5 ? 'Системно' : score >= 7 ? 'Добре' : score >= 5 ? 'Нерегулярно' : 'Мало записів';
    return { score, label, activeDays: activeDates.size, details: `Активних днів: ${activeDates.size}. Запис дня — до 7 балів, розбір стопів — до 2, навчання — до 1.` };
}
