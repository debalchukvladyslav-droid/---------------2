// === Спільні сигнали «потрібне рев’ю» (черга ментора + календар) ===

function countScreenshotsInDay(data) {
    const s = data?.screenshots || {};
    const keys = ['good', 'normal', 'bad', 'error'];
    return keys.reduce((n, k) => n + (Array.isArray(s[k]) ? s[k].length : 0), 0);
}

function hasSessionPrepOnDay(data) {
    const g = String(data?.sessionGoal ?? '').trim();
    const pl = String(data?.sessionPlan ?? '').trim();
    return !!(g || pl);
}

function notesRequestReview(notes) {
    const t = String(notes || '').toLowerCase();
    return t.includes('#розбір') || t.includes('#review') || t.includes('#ментор');
}

function aiHintsRevenge(ai) {
    const t = String(ai || '').toLowerCase();
    if (!t) return false;
    return (
        t.includes('revenge') ||
        t.includes('ревенж') ||
        t.includes('реванш') ||
        t.includes('помст') ||
        t.includes('tilt') ||
        t.includes('тільт')
    );
}

function pnlFieldEmpty(pnl) {
    return pnl === null || pnl === undefined || (typeof pnl === 'string' && !String(pnl).trim()) || pnl === '';
}

/** Немає PnL або є рух по PnL, але порожні нотатки дня. */
function dayHasIncompleteData(data) {
    if (!data || typeof data !== 'object') return false;
    if (pnlFieldEmpty(data.pnl)) return true;
    const pnl = parseFloat(data.pnl);
    const hasMeaningfulPnl = Number.isFinite(pnl) && Math.abs(pnl) > 1e-9;
    if (hasMeaningfulPnl && !String(data.notes || '').trim()) return true;
    return false;
}

/**
 * Об'єкт дня як у state.appData.journal або злитий рядок journal_days + daily_metrics.
 * @param {object|null|undefined} data
 * @param {number} lossThreshold — поріг «великий мінус» (у черзі зазвичай -200, у календарі часто monthly dayloss)
 * @returns {{ key: string, label: string }[]}
 */
export function reviewReasonsForDay(data, lossThreshold = -200) {
    if (!data || typeof data !== 'object') return [];
    const pnl = parseFloat(data.pnl);
    const hasPnl = Number.isFinite(pnl) && pnl !== 0;
    const reasons = [];

    const mentorEmpty = !String(data.mentor_comment || '').trim();
    if (hasPnl && pnl < 0 && mentorEmpty) reasons.push({ key: 'mentor', label: 'Мінус без коментаря' });
    if (hasPnl && pnl <= lossThreshold) reasons.push({ key: 'big', label: 'Великий мінус' });
    if (Array.isArray(data.errors) && data.errors.length > 0) reasons.push({ key: 'err', label: 'Помилки' });
    if (hasPnl && countScreenshotsInDay(data) === 0) reasons.push({ key: 'scr', label: 'Без скрінів' });
    if (hasPnl && !hasSessionPrepOnDay(data)) reasons.push({ key: 'sess', label: 'Без плану сесії' });
    if (notesRequestReview(data.notes)) reasons.push({ key: 'ask', label: 'Запит розбору' });
    if (aiHintsRevenge(data.ai_advice)) reasons.push({ key: 'ai', label: 'AI: ризик поведінки' });
    if (dayHasIncompleteData(data)) reasons.push({ key: 'inc', label: 'Не заповнені дані' });

    return reasons;
}

/** Злиття рядка Supabase journal_days з розпарсеним daily_metrics для reviewReasonsForDay */
export function mergedJournalDayForReview(row, metrics) {
    const m = metrics && typeof metrics === 'object' ? metrics : {};
    const rowErr = Array.isArray(row?.errors) ? row.errors : [];
    const metErr = Array.isArray(m.errors) ? m.errors : [];
    const errors = metErr.length ? metErr : rowErr;
    return {
        pnl: row?.pnl,
        mentor_comment: row?.mentor_comment,
        notes: row?.notes,
        ai_advice: row?.ai_advice,
        errors,
        screenshots: m.screenshots && typeof m.screenshots === 'object' ? m.screenshots : {},
        sessionGoal: m.sessionGoal,
        sessionPlan: m.sessionPlan,
    };
}
