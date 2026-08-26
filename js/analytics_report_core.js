const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const REPORT_SECTION_DEFAULTS = {
    cover: true, calendar: true, kpis: true, equity: true, weekdays: true, hourly: true,
    entryPrice: true, winLoss: true, drawdown: true, costs: true,
    insights: true, tradeTypes: true, bestExit: false, comparison: true, trades: false,
};

export function normalizeReportPeriod(period = {}) {
    const type = ['all', 'year', 'month', 'week', 'custom'].includes(period.type) ? period.type : 'all';
    const value = String(period.value || '');
    let from = ISO_DATE_RE.test(period.from || '') ? period.from : '';
    let to = ISO_DATE_RE.test(period.to || '') ? period.to : '';
    if (from && to && from > to) [from, to] = [to, from];
    return { id: String(period.id || `${type}-${value || from || 'all'}`), type, value, from, to, label: String(period.label || '') };
}

export function dateMatchesReportPeriod(dateStr, rawPeriod) {
    if (!ISO_DATE_RE.test(dateStr)) return false;
    const period = normalizeReportPeriod(rawPeriod);
    if (period.type === 'all') return true;
    if (period.type === 'year') return dateStr.startsWith(`${period.value}-`);
    if (period.type === 'month') return dateStr.startsWith(period.value);
    if (period.type === 'custom') return (!period.from || dateStr >= period.from) && (!period.to || dateStr <= period.to);
    if (period.type === 'week') {
        const start = period.from || period.value;
        if (!ISO_DATE_RE.test(start)) return false;
        const end = new Date(`${start}T12:00:00`);
        end.setDate(end.getDate() + 6);
        const endIso = end.toISOString().slice(0, 10);
        return dateStr >= start && dateStr <= endIso;
    }
    return true;
}

export function reportPeriodLabel(rawPeriod) {
    const period = normalizeReportPeriod(rawPeriod);
    if (period.label) return period.label;
    if (period.type === 'all') return 'За весь час';
    if (period.type === 'year') return `${period.value} рік`;
    if (period.type === 'month') return period.value;
    if (period.type === 'week') return `Тиждень від ${period.from || period.value}`;
    return `${period.from || '…'} — ${period.to || '…'}`;
}

function finite(value) {
    const number = Number(String(value ?? '').replace(',', '.'));
    return Number.isFinite(number) ? number : 0;
}

function dayPnl(day = {}) {
    if (day.pnl !== null && day.pnl !== undefined && day.pnl !== '') return finite(day.pnl);
    if (day.gross_pnl !== null && day.gross_pnl !== undefined && day.gross_pnl !== '') return finite(day.gross_pnl);
    if (day.ppro?.net) return finite(day.ppro.net);
    if (day.fondexx?.net) return finite(day.fondexx.net);
    if (day.ppro?.gross) return finite(day.ppro.gross);
    if (day.fondexx?.gross) return finite(day.fondexx.gross);
    return 0;
}

function dayCosts(day = {}) {
    const commissions = day.commissions !== null && day.commissions !== undefined && day.commissions !== ''
        ? finite(day.commissions) : finite(day.fondexx?.comm) + finite(day.ppro?.comm);
    const locates = day.locates !== null && day.locates !== undefined && day.locates !== ''
        ? finite(day.locates) : finite(day.fondexx?.locates) + finite(day.ppro?.locates);
    return { commissions, locates };
}

function tradeTypeMatches(day, trade, selectedTypes) {
    if (!selectedTypes?.length) return true;
    const values = [
        trade?.type, trade?.tradeType, trade?.setupType, trade?.sheet?.tradeType,
        ...Object.keys(day?.tradeTypesData || {}).filter((key) => finite(day.tradeTypesData[key]?.pnl) !== 0),
    ].map((value) => String(value || '').toLowerCase());
    return selectedTypes.some((type) => values.includes(String(type).toLowerCase()));
}

function flattenTrades(dateStr, day, selectedTypes) {
    return (Array.isArray(day?.trades) ? day.trades : [])
        .filter((trade) => tradeTypeMatches(day, trade, selectedTypes))
        .map((trade) => ({
            date: dateStr,
            ticker: String(trade.symbol || trade.ticker || trade.sheet?.ticker || '—'),
            side: String(trade.side || trade.direction || '—'),
            type: String(trade.type || trade.tradeType || trade.sheet?.tradeType || '—'),
            entry: String(trade.entryTime || trade.time || trade.sheet?.entryTime || '—'),
            exit: String(trade.exitTime || trade.sheet?.exitTime || '—'),
            entryPrice: finite(trade.entryPrice ?? trade.price ?? trade.sheet?.entryPrice),
            exitPrice: finite(trade.exitPrice ?? trade.sheet?.exitPrice),
            pnl: finite(trade.net ?? trade.pnl ?? trade.profit ?? trade.sheet?.profitFact),
            kf: finite(trade.kf ?? trade.profitRisk ?? trade.sheet?.profitRisk),
        }));
}

export function summarizeReportPeriod({ journal = {}, period, selectedTypes = [] } = {}) {
    const days = Object.entries(journal)
        .filter(([date]) => dateMatchesReportPeriod(date, period))
        .map(([date, day]) => ({ date, day: day || {}, pnl: dayPnl(day) }))
        .filter(({ day }) => !selectedTypes.length || Object.keys(day.tradeTypesData || {}).some((type) => selectedTypes.includes(type)))
        .sort((a, b) => a.date.localeCompare(b.date));

    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let commissions = 0;
    let locates = 0;
    const weekdays = [0, 0, 0, 0, 0];
    const errors = new Map();
    const tradeTypes = new Map();
    const equityRows = [];
    const trades = [];
    const hourlyMap = new Map();
    const entryPriceMap = new Map();

    days.forEach(({ date, day, pnl }) => {
        equity += pnl;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.min(maxDrawdown, equity - peak);
        if (pnl > 0) { wins++; grossProfit += pnl; }
        else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); }
        else breakeven++;
        const costs = dayCosts(day);
        commissions += costs.commissions;
        locates += costs.locates;
        const weekday = new Date(`${date}T12:00:00`).getDay();
        if (weekday >= 1 && weekday <= 5) weekdays[weekday - 1] += pnl;
        (day.errors || []).forEach((error) => errors.set(error, (errors.get(error) || 0) + 1));
        Object.entries(day.tradeTypesData || {}).forEach(([type, metrics]) => {
            const current = tradeTypes.get(type) || { pnl: 0, kf: 0, days: 0 };
            current.pnl += finite(metrics?.pnl);
            current.kf += finite(metrics?.kf);
            current.days++;
            tradeTypes.set(type, current);
        });
        const dayTrades = flattenTrades(date, day, selectedTypes);
        trades.push(...dayTrades);
        dayTrades.forEach((trade) => {
            const hour = String(trade.entry || '').match(/^(\d{1,2})/)?.[1];
            if (hour !== undefined) hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + trade.pnl);
            const rawEntry = trade.entryPrice;
            if (Number.isFinite(rawEntry) && rawEntry > 0) {
                const bucket = rawEntry < 5 ? '< $5' : rawEntry < 10 ? '$5–10' : rawEntry < 20 ? '$10–20' : rawEntry < 50 ? '$20–50' : '$50+';
                entryPriceMap.set(bucket, (entryPriceMap.get(bucket) || 0) + trade.pnl);
            }
        });
        equityRows.push({ date, pnl, equity });
    });

    const totalDays = wins + losses + breakeven;
    const sortedPnl = days.map((row) => row.pnl);
    return {
        id: normalizeReportPeriod(period).id,
        label: reportPeriodLabel(period),
        range: { from: days[0]?.date || '', to: days.at(-1)?.date || '' },
        kpis: {
            totalPnl: equity,
            winRate: totalDays ? wins / totalDays * 100 : 0,
            profitFactor: grossLoss ? grossProfit / grossLoss : (grossProfit ? Infinity : 0),
            avgWin: wins ? grossProfit / wins : 0,
            avgLoss: losses ? grossLoss / losses : 0,
            bestDay: sortedPnl.length ? Math.max(...sortedPnl) : 0,
            worstDay: sortedPnl.length ? Math.min(...sortedPnl) : 0,
            tradeDays: totalDays,
            maxDrawdown: Math.abs(maxDrawdown),
            commissions,
            locates,
            wins, losses, breakeven,
        },
        equity: equityRows,
        weekdays,
        hourly: [...hourlyMap.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([label, value]) => ({ label: `${label}:00`, value })),
        entryPrice: [...entryPriceMap.entries()].map(([label, value]) => ({ label, value })),
        errors: [...errors.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
        tradeTypes: [...tradeTypes.entries()].map(([label, metrics]) => ({ label, ...metrics })),
        trades,
        warnings: days.length ? [] : ['У вибраному періоді немає даних.'],
    };
}

export function buildReportComparison(periods = []) {
    if (periods.length < 2) return [];
    const base = periods[0];
    return periods.slice(1).map((period) => ({
        label: period.label,
        totalPnl: period.kpis.totalPnl - base.kpis.totalPnl,
        winRate: period.kpis.winRate - base.kpis.winRate,
        profitFactor: Number.isFinite(period.kpis.profitFactor) && Number.isFinite(base.kpis.profitFactor)
            ? period.kpis.profitFactor - base.kpis.profitFactor : null,
        maxDrawdown: period.kpis.maxDrawdown - base.kpis.maxDrawdown,
    }));
}

export function validateAnalyticsExportConfig(config = {}) {
    const errors = [];
    if (!Array.isArray(config.periods) || !config.periods.length) errors.push('Додайте хоча б один часовий проміжок.');
    (config.periods || []).forEach((period) => {
        const normalized = normalizeReportPeriod(period);
        if (normalized.type === 'year' && !/^\d{4}$/.test(normalized.value)) errors.push('Рік має складатися з чотирьох цифр.');
        if (normalized.type === 'month' && !/^\d{4}-\d{2}$/.test(normalized.value)) errors.push('Місяць має формат РРРР-ММ.');
        if (normalized.type === 'custom' && (!normalized.from || !normalized.to)) errors.push('Для власного діапазону вкажіть початкову й кінцеву дати.');
    });
    if (!Object.values(config.sections || {}).some(Boolean)) errors.push('Оберіть хоча б один розділ звіту.');
    return { valid: errors.length === 0, errors };
}

export function buildAnalyticsReportData(config = {}, contexts = []) {
    const validation = validateAnalyticsExportConfig(config);
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    const safeContexts = contexts.length ? contexts : [{ label: 'Поточний профіль', journal: {} }];
    const groups = safeContexts.map((context) => {
        const periods = config.periods.map((period) => summarizeReportPeriod({
            journal: context.journal || {},
            period,
            selectedTypes: config.tradeTypes || [],
        }));
        return { label: context.label || 'Профіль', periods, comparison: buildReportComparison(periods) };
    });
    return { config, groups, createdAt: new Date().toISOString(), warnings: groups.flatMap((group) => group.periods.flatMap((period) => period.warnings)) };
}

export function makeAnalyticsPdfFilename(config = {}, identity = {}, now = new Date()) {
    const profile = config.identity?.nick && identity.nick ? identity.nick : 'anonymous';
    const periods = config.periods || [];
    const range = periods.length === 1
        ? reportPeriodLabel(periods[0]).replace(/[^\p{L}\p{N}-]+/gu, '-')
        : `${periods.length}-periods`;
    return `analytics_${profile}_${range}_${now.toISOString().slice(0, 10)}.pdf`.replace(/-+/g, '-');
}
