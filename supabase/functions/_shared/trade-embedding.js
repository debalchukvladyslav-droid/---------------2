const clean = (value, max = 600) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const number = (value) => {
    const parsed = Number(String(value ?? '').replace(',', '.').replace(/[^0-9+\-.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
};
const field = (label, value) => clean(value) ? `${label}: ${clean(value)}` : '';

export function tradeIdentity(trade, tradeDate, occurrence = 0) {
    return [clean(tradeDate, 10), clean(trade?.symbol || trade?.ticker, 20).toUpperCase(), clean(trade?.opened || trade?.entryTime, 40), clean(trade?.entry, 30), clean(trade?.type || 'SHORT', 40).toUpperCase(), String(Math.max(0, Number(occurrence) || 0))].join('|');
}

export function canonicalTradeText({ trade, day, tradeDate }) {
    const analysis = trade?.analysisResult;
    const analysisText = typeof analysis === 'string' ? analysis : analysis && typeof analysis === 'object' ? analysis.summary || analysis.explanation || analysis.analysis || JSON.stringify(analysis) : '';
    const tickerMetrics = day?.tickers?.[trade?.symbol] || day?.tickers?.[trade?.ticker] || {};
    const mistakes = trade?.mistakes ?? analysis?.mistakes ?? day?.errors;
    const net = number(trade?.net);
    return [
        'Domain: US equities short trading, New York pre-market 04:00-09:30 ET', field('Trade date', tradeDate),
        field('Direction', trade?.type || 'SHORT'), field('Ticker', clean(trade?.symbol || trade?.ticker, 20).toUpperCase()),
        field('Opened', trade?.opened || trade?.entryTime), field('Closed', trade?.closed || trade?.exitTime),
        field('Setup', trade?.setup ?? trade?.setupType ?? analysis?.setup ?? analysis?.pattern), field('Entry', trade?.entry),
        field('Stop', trade?.stop), field('Exit', trade?.exit), field('Quantity', trade?.qty),
        field('RVOL', trade?.rvol ?? tickerMetrics?.rvol ?? day?.rvol), field('ATR', trade?.atr ?? tickerMetrics?.atr ?? day?.atr),
        field('Net result', net === null ? trade?.net : net), field('Mistakes', Array.isArray(mistakes) ? mistakes.join('; ') : mistakes),
        field('Trader notes', day?.notes), field('Trade analysis', analysisText),
    ].filter(Boolean).join('\n').slice(0, 8000);
}

export function enumerateTrades(day, tradeDate) {
    const seen = new Map();
    return (Array.isArray(day?.trades) ? day.trades : []).map((trade) => {
        const base = tradeIdentity(trade, tradeDate, 0).replace(/\|0$/, '');
        const occurrence = seen.get(base) || 0;
        seen.set(base, occurrence + 1);
        return { trade, identity: tradeIdentity(trade, tradeDate, occurrence), text: canonicalTradeText({ trade, day, tradeDate }) };
    }).filter((item) => item.text.length >= 20 && clean(item.trade?.symbol || item.trade?.ticker, 20));
}
