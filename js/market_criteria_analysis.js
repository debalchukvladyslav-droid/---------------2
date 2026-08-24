const DEFINITIONS = [
    { key: 'atr', label: 'ATR', ranges: [[0, .3, 'до 0.30'], [.3, .5, '0.30–0.50'], [.5, .75, '0.50–0.75'], [.75, 1, '0.75–1.00'], [1, 1.5, '1.00–1.50'], [1.5, 2, '1.50–2.00'], [2, Infinity, 'від 2.00']] },
    { key: 'shs_float', label: 'Float', ranges: [[0, 5e6, 'до 5M'], [5e6, 10e6, '5–10M'], [10e6, 20e6, '10–20M'], [20e6, 50e6, '20–50M'], [50e6, 100e6, '50–100M'], [100e6, Infinity, 'від 100M']] },
    { key: 'avg_vol', label: 'Avg Vol 14', ranges: [[0, 5e5, 'до 500K'], [5e5, 1e6, '500K–1M'], [1e6, 2e6, '1–2M'], [2e6, 5e6, '2–5M'], [5e6, 10e6, '5–10M'], [10e6, Infinity, 'від 10M']] },
    { key: 'vol', label: 'Vol попереднього дня', ranges: [[0, 5e5, 'до 500K'], [5e5, 1e6, '500K–1M'], [1e6, 2e6, '1–2M'], [2e6, 5e6, '2–5M'], [5e6, 10e6, '5–10M'], [10e6, Infinity, 'від 10M']] },
    { key: 'vol_play', label: 'VolPlay', ranges: [[0, .5, 'до 0.50x'], [.5, 1, '0.50–1.00x'], [1, 2, '1.00–2.00x'], [2, 3, '2.00–3.00x'], [3, 5, '3.00–5.00x'], [5, Infinity, 'від 5.00x']] },
];

function finite(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function tradeGross(trade) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    return finite(trade?.gross ?? trade?.grossPnl ?? sheet.gross);
}

export function buildMarketCriteriaGroups(journal = {}, allowedDates = null, tradeType = '') {
    const groups = DEFINITIONS.map((definition) => ({ ...definition, buckets: definition.ranges.map(([, , label]) => ({ label, trades: 0, pnl: 0, wins: 0, grossProfit: 0, grossLoss: 0 })) }));
    for (const [date, day] of Object.entries(journal || {})) {
        if (allowedDates && !allowedDates.has(date)) continue;
        for (const trade of Array.isArray(day?.trades) ? day.trades : []) {
            const type = String(trade?.type ?? trade?.sheet?.tradeType ?? '').trim();
            if (tradeType && type !== tradeType) continue;
            const pnl = tradeGross(trade);
            const metrics = trade?.marketCriteria || day?.tradePolygons?.[String(trade?.symbol || trade?.ticker || '').toUpperCase()];
            if (pnl === null || !metrics) continue;
            groups.forEach((group) => {
                const value = finite(metrics[group.key]);
                if (value === null) return;
                const index = group.ranges.findIndex(([from, to]) => value >= from && value < to);
                if (index < 0) return;
                const bucket = group.buckets[index];
                bucket.trades += 1;
                bucket.pnl += pnl;
                if (pnl > 0) { bucket.wins += 1; bucket.grossProfit += pnl; }
                if (pnl < 0) bucket.grossLoss += Math.abs(pnl);
            });
        }
    }
    return groups.map((group) => ({
        key: group.key,
        label: group.label,
        buckets: group.buckets.filter((bucket) => bucket.trades).map((bucket) => ({
            ...bucket,
            pnl: Number(bucket.pnl.toFixed(2)),
            winRate: Number((bucket.wins / bucket.trades * 100).toFixed(1)),
            profitFactor: bucket.grossLoss ? Number((bucket.grossProfit / bucket.grossLoss).toFixed(2)) : (bucket.grossProfit ? Infinity : 0),
        })).sort((a, b) => b.pnl - a.pnl),
    })).filter((group) => group.buckets.length);
}
