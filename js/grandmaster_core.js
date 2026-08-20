const clean = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const list = (value) => Array.isArray(value) ? value.map((item) => clean(item, 300)).filter(Boolean) : [];
export const tradesOfDay = (day) => Array.isArray(day?.trades) ? day.trades : Array.isArray(day?.daily_metrics?.trades) ? day.daily_metrics.trades : [];
const tradePnl = (trade) => number(trade?.net ?? trade?.pnl ?? trade?.gross);

export function buildTradeBasedReview(day) {
    const trades = tradesOfDay(day); if (!trades.length) return null;
    const wins = trades.filter((trade) => tradePnl(trade) > 0).length;
    const losses = trades.filter((trade) => tradePnl(trade) < 0).length;
    const setups = new Map();
    trades.forEach((trade) => { const setup = clean(trade.setup || trade.setupType || trade.tradeType || trade.type, 80); if (setup) setups.set(setup, (setups.get(setup) || 0) + 1); });
    const topSetup = [...setups].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const mistakes = list(day?.errors ?? day?.daily_metrics?.errors);
    const strengths = [];
    if (wins > losses) strengths.push(`Прибуткових угод: ${wins} із ${trades.length}`);
    if (topSetup) strengths.push(`Найчастіший тип: ${topSetup}`);
    const result = day?.pnl != null ? number(day.pnl) : trades.reduce((sum, trade) => sum + tradePnl(trade), 0);
    return { trade_date: day.trade_date || '', status: 'за угодами', mistakes, strengths, debrief: `За день записано ${trades.length} угод: ${wins} прибуткових, ${losses} збиткових. Результат ${result >= 0 ? '+' : ''}$${result.toFixed(2)}.${topSetup ? ` Найчастіше повторювався тип «${topSetup}».` : ''}`, next_session_rules: mistakes.length ? ['Перед наступною сесією переглянути позначені помилки'] : ['Продовжувати записувати фактичний результат кожної угоди'], evidence: { current_trade_count: trades.length }, model_name: 'trade-data' };
}

export function sparklinePoints(values, width = 160, height = 42, pad = 3) { const nums = values.map(Number).filter(Number.isFinite); if (!nums.length) return ''; const min = Math.min(...nums); const max = Math.max(...nums); const span = max - min || 1; return nums.map((value, index) => `${(pad + index * (width - pad * 2) / Math.max(1, nums.length - 1)).toFixed(1)},${(height - pad - (value - min) / span * (height - pad * 2)).toFixed(1)}`).join(' '); }

export function buildTraderDNA(reviews = [], days = [], feedback = []) {
    const risks = new Map(); const strengths = new Map();
    reviews.slice(0, 7).forEach((review) => { list(review.mistakes).forEach((item) => risks.set(item, (risks.get(item) || 0) + 1)); list(review.strengths).forEach((item) => strengths.set(item, (strengths.get(item) || 0) + 1)); });
    const setups = new Map();
    days.forEach((day) => tradesOfDay(day).forEach((trade) => { const setup = clean(trade.setup || trade.setupType || trade.tradeType || trade.type, 80); if (!setup) return; const row = setups.get(setup) || { wins: 0, count: 0 }; row.count++; if (tradePnl(trade) > 0) row.wins++; setups.set(setup, row); }));
    const best = [...setups].filter(([, value]) => value.count >= 2).sort((a, b) => b[1].wins / b[1].count - a[1].wins / a[1].count)[0];
    if (best) strengths.set(`${best[0]}: ${Math.round(best[1].wins / best[1].count * 100)}% WR`, Math.max(2, best[1].count));
    const negativeFeedback = feedback.filter((item) => Number(item.rating) < 0).length;
    const mistakeLoad = [...risks.values()].reduce((sum, value) => sum + value, 0);
    return { risks: [...risks].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, count]) => ({ label, count })), strengths: [...strengths].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, count]) => ({ label, count })), discipline: Math.max(0, Math.min(100, Math.round(100 - mistakeLoad * 6 - negativeFeedback * 2))) };
}

export function buildGrandmasterView(reviews = [], days = [], feedback = []) {
    const orderedDays = [...days].filter((day) => tradesOfDay(day).length || day?.pnl != null).sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
    const suppliedReviews = [...reviews].sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
    const tradeReview = buildTradeBasedReview(orderedDays[0]);
    const orderedReviews = tradeReview && (!suppliedReviews[0] || String(tradeReview.trade_date) > String(suppliedReviews[0].trade_date)) ? [tradeReview, ...suppliedReviews] : suppliedReviews;
    const lastFive = orderedDays.slice(0, 5).reverse(); const pnls = lastFive.map((day) => number(day.pnl));
    let equity = 0; const equitySeries = pnls.map((value) => equity += value); const cumulativeWinRate = []; let wins = 0;
    lastFive.forEach((day, index) => { if (number(day.pnl) > 0) wins++; cumulativeWinRate.push(Math.round(wins / (index + 1) * 100)); });
    const flaggedDates = new Set(orderedReviews.filter((review) => list(review.mistakes).length).map((review) => review.trade_date));
    const mistakeCost = orderedDays.filter((day) => flaggedDates.has(day.trade_date) && number(day.pnl) < 0).reduce((sum, day) => sum + Math.abs(number(day.pnl)), 0);
    return { latest: orderedReviews[0] || tradeReview, reviews: orderedReviews.slice(0, 5), days: lastFive, pnl: pnls.reduce((a, b) => a + b, 0), winRate: lastFive.length ? Math.round(lastFive.filter((day) => number(day.pnl) > 0).length / lastFive.length * 100) : 0, mistakeCost, equitySeries, cumulativeWinRate, dna: buildTraderDNA(orderedReviews, orderedDays, feedback) };
}
