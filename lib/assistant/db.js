const DEFAULT_SELECT_TRADES = 'id,user_id,trade_date,ticker,side,entry_price,exit_price,shares,pnl,setup,payload';
const DEFAULT_SELECT_DAYS = 'user_id,trade_date,pnl,gross_pnl,commissions,locates,kf,notes,ai_advice,daily_metrics';

export function createAssistantDb({ url, serviceKey, fetchImpl = fetch } = {}) {
    const base = String(url || '').replace(/\/$/, '');
    const key = String(serviceKey || '');
    if (!base || !key) {
        const error = new Error('Supabase assistant env is not configured');
        error.status = 500;
        throw error;
    }

    async function rest(path, { method = 'GET', body, prefer } = {}) {
        const headers = {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        };
        if (prefer) headers.Prefer = prefer;
        const response = await fetchImpl(`${base}/rest/v1/${path}`, {
            method,
            headers,
            body: body == null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(25000),
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!response.ok) {
            const error = new Error(data?.message || data?.error || `Assistant DB ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }

    return {
        rest,
        async getProfileSettings(userId) {
            const rows = await rest(`profiles?id=eq.${encodeURIComponent(userId)}&select=settings,nick`);
            return rows?.[0] || null;
        },
        async getUserSetting(userId, settingKey) {
            const rows = await rest(
                `user_settings?user_id=eq.${encodeURIComponent(userId)}&key=eq.${encodeURIComponent(settingKey)}&select=value`,
            );
            return rows?.[0]?.value ?? null;
        },
        async getDay(userId, tradeDate) {
            const rows = await rest(
                `journal_days?user_id=eq.${encodeURIComponent(userId)}&trade_date=eq.${encodeURIComponent(tradeDate)}&select=${DEFAULT_SELECT_DAYS}`,
            );
            return rows?.[0] || null;
        },
        async getDays(userId, { from, to, limit = 60 } = {}) {
            const caps = Math.min(120, Math.max(1, Number(limit) || 60));
            let path = `journal_days?user_id=eq.${encodeURIComponent(userId)}&select=${DEFAULT_SELECT_DAYS}&order=trade_date.desc&limit=${caps}`;
            if (from) path += `&trade_date=gte.${encodeURIComponent(from)}`;
            if (to) path += `&trade_date=lte.${encodeURIComponent(to)}`;
            return rest(path);
        },
        async getTradeById(userId, tradeId) {
            const rows = await rest(
                `trades?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(tradeId)}&deleted_at=is.null&select=${DEFAULT_SELECT_TRADES}`,
            );
            return rows?.[0] || null;
        },
        async getTrades(userId, {
            from = '',
            to = '',
            ticker = '',
            setup = '',
            side = '',
            limit = 100,
            offset = 0,
        } = {}) {
            const caps = Math.min(100, Math.max(1, Number(limit) || 100));
            const start = Math.max(0, Number(offset) || 0);
            let path = `trades?user_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null&select=${DEFAULT_SELECT_TRADES}&order=trade_date.desc&limit=${caps}&offset=${start}`;
            if (from) path += `&trade_date=gte.${encodeURIComponent(from)}`;
            if (to) path += `&trade_date=lte.${encodeURIComponent(to)}`;
            if (ticker) path += `&ticker=eq.${encodeURIComponent(String(ticker).toUpperCase())}`;
            if (side) path += `&side=ilike.${encodeURIComponent(side)}`;
            if (setup) path += `&setup=ilike.*${encodeURIComponent(setup)}*`;
            return rest(path);
        },
        async getRecentCoachInsight(userId) {
            const rows = await rest(
                `ai_coach_insights?user_id=eq.${encodeURIComponent(userId)}&status=eq.ready&select=trade_date,severity,title,summary,created_at&order=created_at.desc&limit=1`,
            );
            return rows?.[0] || null;
        },
        async getCriteriaSnapshot(userId, { ticker, tradeDate } = {}) {
            let path = `trade_criteria_snapshots?user_id=eq.${encodeURIComponent(userId)}&select=ticker,trade_date,provider,atr14,avg_vol14,day_volume,vol_play14,atr_play14,session_high,session_low,completeness,fetch_status,calculated_at&order=calculated_at.desc&limit=3`;
            if (ticker) path += `&ticker=eq.${encodeURIComponent(String(ticker).toUpperCase())}`;
            if (tradeDate) path += `&trade_date=eq.${encodeURIComponent(tradeDate)}`;
            return rest(path);
        },
    };
}
