const PREMARKET_START = 4 * 60;
const MARKET_OPEN = 9 * 60 + 30;
const FOCUS_WINDOW_END = 10 * 60;
const MARKET_CLOSE = 16 * 60;

function pad(value) { return String(value).padStart(2, '0'); }

export function getNewYorkParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).reduce((result, item) => ({ ...result, [item.type]: item.value }), {});
    return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function durationLabel(minutes) {
    const safe = Math.max(0, Math.round(minutes));
    const hours = Math.floor(safe / 60);
    const rest = safe % 60;
    return hours ? `${hours}г ${pad(rest)}хв` : `${rest} хв`;
}

export function deriveSessionPhase({ weekday, hour, minute }) {
    const now = Number(hour) * 60 + Number(minute);
    if (weekday === 'Sat' || weekday === 'Sun') return { key: 'weekend', label: 'Ринок закритий', tone: 'quiet', countdown: 'Вихідний у Нью-Йорку' };
    if (now < PREMARKET_START) return { key: 'prep', label: 'Підготовка', tone: 'quiet', countdown: `До pre-market ${durationLabel(PREMARKET_START - now)}` };
    if (now < MARKET_OPEN) return { key: 'premarket', label: 'Pre-market LIVE', tone: 'live', countdown: `До відкриття ${durationLabel(MARKET_OPEN - now)}` };
    if (now < FOCUS_WINDOW_END) return { key: 'focus', label: 'Opening range', tone: 'focus', countdown: `Фокус-вікно ще ${durationLabel(FOCUS_WINDOW_END - now)}` };
    if (now < MARKET_CLOSE) return { key: 'regular', label: 'Основна сесія', tone: 'regular', countdown: 'Pre-market вікно завершено' };
    return { key: 'review', label: 'Розбір сесії', tone: 'quiet', countdown: 'Час зафіксувати висновки' };
}

export function buildReadiness(day = {}) {
    const goal = String(day.sessionGoal || '').trim();
    const plan = String(day.sessionPlan || '').trim();
    const setups = Array.isArray(day.sessionSetups) ? day.sessionSetups.filter(Boolean) : [];
    const selfRating = Math.max(0, Math.min(10, Number(day.sessionReadiness) || 0));
    const checks = [{ label: 'Ціль', done: Boolean(goal) }, { label: 'План', done: Boolean(plan) }, { label: 'Сетапи', done: setups.length > 0 }];
    const score = Math.round((checks.filter((item) => item.done).length / checks.length) * 60 + (selfRating / 10) * 40);
    const missing = checks.filter((item) => !item.done).map((item) => item.label.toLowerCase());
    return { score, selfRating, checks, goal, plan, setups, tone: score >= 80 ? 'ready' : score >= 55 ? 'caution' : 'blocked', label: score >= 80 ? 'Готовий за планом' : score >= 55 ? 'Потрібна увага' : 'Спершу підготуйся', hint: missing.length ? `Заповни: ${missing.join(', ')}` : 'План сесії сформований' };
}
