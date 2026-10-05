import { assessDrawdownRisk } from '../../../js/drawdown_risk_core.js';

export function createRiskTools({ db, userId }) {
    return {
        async get_risk_state(args = {}) {
            const to = dateOrEmpty(args.to) || todayNy();
            const from = dateOrEmpty(args.from) || shiftDate(to, -120);
            const [days, profile] = await Promise.all([
                db.getDays(userId, { from, to, limit: 120 }),
                db.getProfileSettings(userId),
            ]);
            const settings = profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
            const dayRows = (days || [])
                .map((day) => ({ date: day.trade_date, pnl: Number(day.pnl) }))
                .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(day.pnl))
                .sort((a, b) => a.date.localeCompare(b.date));

            const monthKey = to.slice(0, 7);
            const prevKey = previousMonthKey(monthKey);
            const dayloss = resolveMonthlyDayloss(settings, monthKey);
            const previousDayloss = resolveMonthlyDayloss(settings, prevKey);
            const assessment = assessDrawdownRisk({
                days: dayRows,
                deposit: settings.deposit,
                dayloss,
                previousDayloss,
            });
            const baseRisk = Math.abs(Number(dayloss)) || 1000;
            const recommendedRisk = Math.round(baseRisk * (assessment.riskMultiplier ?? 1) * 100) / 100;
            return {
                from,
                to,
                level: assessment.level,
                reason: assessment.reason,
                text: assessment.text,
                riskMultiplier: assessment.riskMultiplier,
                pullback: assessment.pullback,
                monthPnl: assessment.monthPnl,
                monthR: assessment.monthR,
                prevMonthR: assessment.prevMonthR,
                equityR: assessment.equityR,
                baseRisk,
                recommendedRisk,
                sampleDays: dayRows.length,
            };
        },
    };
}

function dateOrEmpty(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
}

function todayNy() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function shiftDate(iso, days) {
    const date = new Date(`${iso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function previousMonthKey(monthKey) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return '';
    const date = new Date(Date.UTC(year, month - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resolveMonthlyDayloss(settings = {}, monthKey = '') {
    const monthly = settings.monthlyDayloss;
    if (monthKey && monthly && typeof monthly === 'object' && monthly[monthKey] != null) {
        const value = Number(monthly[monthKey]);
        if (Number.isFinite(value)) return value;
    }
    const fallback = Number(settings.defaultDayloss);
    return Number.isFinite(fallback) ? fallback : -1000;
}
