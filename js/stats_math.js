export function summarizeJournalPnl(journal = {}) {
    const entries = Object.values(journal)
        .map((entry) => entry?.pnl)
        .filter((value) => value !== '' && value !== null && value !== undefined)
        .map((value) => Number(value))
        .filter(Number.isFinite);

    const wins = entries.filter((value) => value > 0);
    const losses = entries.filter((value) => value < 0);
    const grossProfit = wins.reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    const totalPnl = entries.reduce((sum, value) => sum + value, 0);

    return {
        trades: entries.length,
        wins: wins.length,
        losses: losses.length,
        totalPnl: Number(totalPnl.toFixed(2)),
        winRate: entries.length ? Number(((wins.length / entries.length) * 100).toFixed(2)) : 0,
        profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0),
    };
}
