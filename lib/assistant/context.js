const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sanitizePageContext(raw = {}) {
    const tab = String(raw.tab || raw.page || '').trim().slice(0, 40);
    const date = DATE_RE.test(raw.date || '') ? raw.date : '';
    const tradeKey = raw.tradeKey && typeof raw.tradeKey === 'object'
        ? {
            date: DATE_RE.test(raw.tradeKey.date || '') ? raw.tradeKey.date : '',
            tradeIndex: Number.isFinite(Number(raw.tradeKey.tradeIndex)) ? Number(raw.tradeKey.tradeIndex) : null,
            tradeId: raw.tradeKey.tradeId ? String(raw.tradeKey.tradeId).slice(0, 80) : null,
            ticker: String(raw.tradeKey.ticker || '').trim().toUpperCase().slice(0, 16) || null,
        }
        : null;
    return {
        tab: tab || null,
        date: date || null,
        tradeKey: tradeKey && (tradeKey.date || tradeKey.tradeId || tradeKey.ticker) ? tradeKey : null,
    };
}

export async function buildAssistantContext(db, user, pageContext = {}) {
    const safePage = sanitizePageContext(pageContext);
    let profile = null;
    let coachInsight = null;
    try {
        profile = await db.getProfileSettings(user.id);
    } catch {
        profile = null;
    }
    try {
        coachInsight = await db.getRecentCoachInsight(user.id);
    } catch {
        coachInsight = null;
    }
    const settings = profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
    const traderProfile = {
        nick: profile?.nick || null,
        direction: 'short',
        session: '04:00-09:30 America/New_York',
        defaultDayloss: Number.isFinite(Number(settings.defaultDayloss)) ? Number(settings.defaultDayloss) : null,
        deposit: Number.isFinite(Number(settings.deposit)) ? Number(settings.deposit) : null,
        monthlyDayloss: settings.monthlyDayloss && typeof settings.monthlyDayloss === 'object'
            ? Object.fromEntries(Object.entries(settings.monthlyDayloss).slice(0, 24))
            : null,
    };
    return {
        traderProfile,
        pageContext: safePage,
        coachInsight: coachInsight
            ? {
                tradeDate: coachInsight.trade_date,
                severity: coachInsight.severity,
                title: String(coachInsight.title || '').slice(0, 140),
                summary: String(coachInsight.summary || '').slice(0, 400),
            }
            : null,
    };
}
