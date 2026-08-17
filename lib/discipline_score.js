const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clean = (value) => String(value || '').trim();
export function minutesFromTime(value) { const match = clean(value).match(/^(\d{1,2}):(\d{2})/); if (!match) return null; const h = Number(match[1]); const m = Number(match[2]); return h < 24 && m < 60 ? h * 60 + m : null; }
export function shortRiskReward(trade = {}) { const entry = finite(trade.entry); const stop = finite(trade.stop); const exit = finite(trade.exit); if (entry == null || stop == null || exit == null || stop <= entry) return null; return Number(((entry - exit) / (stop - entry)).toFixed(2)); }
export function gradeDiscipline(trade = {}) {
    let score = 100; const reasons = []; const strengths = []; const setup = clean(trade.setup || trade.setupType).toLowerCase(); const time = minutesFromTime(trade.opened || trade.time || trade.entryTime); const rvol = finite(trade.rvol); const atr = finite(trade.atr); const entry = finite(trade.entry); const stop = finite(trade.stop); const pump = /pump|dump|памп/.test(setup); const orb = /orb|opening range/.test(setup);
    if (!setup) { score -= 20; reasons.push('Setup не класифіковано'); } else strengths.push('Setup визначено');
    if (time == null) { score -= 10; reasons.push('Час входу не записано'); } else if (time < 240 || time > 570) { score -= 35; reasons.push('Вхід поза 04:00–09:30 ET'); } else strengths.push('Вхід у премаркет');
    if (rvol == null || rvol <= 0) { score -= 15; reasons.push('RVOL не підтверджено'); } else if (pump && rvol <= 5) { score -= 20; reasons.push('Pump short без RVOL > 5x'); } else strengths.push('RVOL підтверджено');
    if (atr == null || atr <= 0) { score -= 8; reasons.push('ATR не записано'); }
    if (entry == null || stop == null) { score -= 15; reasons.push('Немає повного risk plan'); } else if (stop <= entry) { score -= 30; reasons.push('Stop для short має бути вище entry'); } else strengths.push('Валідна геометрія ризику');
    const rr = shortRiskReward(trade); const plannedRr = finite(trade.plannedRiskReward || trade.plannedRR);
    if (plannedRr != null && plannedRr < 1.5) { score -= 12; reasons.push('Запланований R/R нижче 1.5'); } else if (plannedRr != null) strengths.push('Плановий R/R ≥ 1.5');
    if (trade.chased === true || /chas(e|ed|ing)|погон|доган/.test(clean(trade.mistake || trade.notes).toLowerCase())) { score -= 25; reasons.push('Погоня за входом'); }
    if (orb && time != null && time < 570) { score -= 15; reasons.push('ORB позначено до завершення opening range'); }
    score = Math.max(0, Math.min(100, score)); const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'F';
    return { score, grade, reasons, strengths, riskReward: rr, version: 'discipline-v1', outcomeIndependent: true };
}
