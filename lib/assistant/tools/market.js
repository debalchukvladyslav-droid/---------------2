import { fetchMassiveAggregates, massiveApiKey } from '../../massive_client.js';

const MAX_BARS = 60;

export function createMarketTools({ db, userId }) {
    return {
        async get_market_data(args = {}, ctx = {}) {
            const pageContext = ctx.pageContext || {};
            const ticker = String(args.ticker || pageContext?.tradeKey?.ticker || '').trim().toUpperCase();
            const date = dateOrEmpty(args.date) || pageContext?.tradeKey?.date || pageContext?.date || todayNy();
            if (!ticker) return { error: 'ticker_required' };

            let criteria = [];
            try {
                criteria = await db.getCriteriaSnapshot(userId, { ticker, tradeDate: date });
            } catch {
                criteria = [];
            }

            let bars = [];
            let barsError = null;
            if (massiveApiKey()) {
                try {
                    const response = await fetchMassiveAggregates({
                        ticker,
                        multiplier: 5,
                        timespan: 'minute',
                        from: date,
                        to: date,
                    });
                    const results = Array.isArray(response?.results) ? response.results : [];
                    bars = results.slice(0, MAX_BARS).map((bar) => ({
                        time: bar.t ? new Date(bar.t).toISOString() : null,
                        open: bar.o ?? null,
                        high: bar.h ?? null,
                        low: bar.l ?? null,
                        close: bar.c ?? null,
                        volume: bar.v ?? null,
                    }));
                } catch (error) {
                    barsError = String(error?.message || 'market_fetch_failed').slice(0, 200);
                }
            } else {
                barsError = 'market_api_key_missing';
            }

            return {
                ticker,
                date,
                criteria: (criteria || []).slice(0, 3).map((row) => ({
                    provider: row.provider,
                    tradeDate: row.trade_date,
                    completeness: row.completeness,
                    fetchStatus: row.fetch_status,
                    metrics: boundMetrics({
                        atr14: row.atr14,
                        avgVol14: row.avg_vol14,
                        dayVolume: row.day_volume,
                        volPlay14: row.vol_play14,
                        atrPlay14: row.atr_play14,
                        sessionHigh: row.session_high,
                        sessionLow: row.session_low,
                    }),
                })),
                bars,
                barCount: bars.length,
                barsError,
                note: 'Bars are capped for assistant use; prefer criteria snapshots when present.',
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

function boundMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(metrics).slice(0, 40)) {
        if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
        else if (typeof value === 'string') out[key] = value.slice(0, 120);
        else if (typeof value === 'boolean') out[key] = value;
    }
    return out;
}
