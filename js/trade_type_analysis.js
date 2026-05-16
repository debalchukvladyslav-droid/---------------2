import { applyAutoTradeTypesData, DEFAULT_TRADE_TYPES, normalizeTradeTypesList, classifyTradeTypeGroup } from './data_utils.js';

function isDayKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00$';
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}$`;
}

function normalizeJournal(journal = {}) {
    const out = {};
    for (const [dateStr, entry] of Object.entries(journal || {})) {
        if (!isDayKey(dateStr)) continue;
        out[dateStr] = applyAutoTradeTypesData({ ...(entry || {}) });
    }
    return out;
}

function dateInRecentWindow(dateStr, recentDays) {
    if (!recentDays) return true;
    const date = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(date.getTime())) return true;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Number(recentDays));
    cutoff.setHours(0, 0, 0, 0);
    return date >= cutoff;
}

function summarize(values = []) {
    let pnl = 0;
    let win = 0;
    let loss = 0;
    let be = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let kfSum = 0;
    let kfCount = 0;

    values.forEach((item) => {
        const value = Number(item.pnl);
        if (!Number.isFinite(value)) return;
        pnl += value;
        if (value > 0) {
            win += 1;
            grossWin += value;
        } else if (value < 0) {
            loss += 1;
            grossLoss += Math.abs(value);
        } else {
            be += 1;
        }
        const kf = Number(item.kf);
        if (Number.isFinite(kf) && kf !== 0) {
            kfSum += kf;
            kfCount += 1;
        }
    });

    const days = win + loss + be;
    const decisive = win + loss;
    const winRate = decisive ? (win / decisive) * 100 : 0;
    const avgDay = days ? pnl / days : 0;
    const avgWin = win ? grossWin / win : 0;
    const avgLoss = loss ? grossLoss / loss : 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
    const avgKf = kfCount ? kfSum / kfCount : null;

    return { days, win, loss, be, pnl, winRate, avgDay, avgWin, avgLoss, profitFactor, avgKf };
}

export function buildTradeTypeInsightRows(journal = {}, options = {}) {
    const normalized = normalizeJournal(journal);
    const types = normalizeTradeTypesList(options.tradeTypes || DEFAULT_TRADE_TYPES);
    const buckets = Object.fromEntries(types.map((type) => [type, []]));

    for (const [dateStr, entry] of Object.entries(normalized)) {
        if (!dateInRecentWindow(dateStr, options.recentDays)) continue;
        const data = entry.tradeTypesData && typeof entry.tradeTypesData === 'object' ? entry.tradeTypesData : {};
        for (const type of types) {
            const item = data[type];
            if (!item || item.pnl === '' || item.pnl === null || item.pnl === undefined) continue;
            buckets[type].push({ dateStr, pnl: Number(item.pnl), kf: Number(item.kf) });
        }
    }

    return types.map((type) => {
        const summary = summarize(buckets[type]);
        const advice = getTradeTypeAdvice(summary);
        return { type, ...summary, advice };
    }).filter((row) => row.days > 0).sort((a, b) => {
        const aScore = (a.pnl * 1.4) + (a.avgDay * 8) + Math.min(a.days, 12);
        const bScore = (b.pnl * 1.4) + (b.avgDay * 8) + Math.min(b.days, 12);
        return bScore - aScore;
    });
}

export function getTradeTypeAdvice(row) {
    if (!row || row.days < 3) return { tone: 'watch', text: 'даних мало, поки тільки збирати статистику' };
    if (row.pnl > 0 && row.profitFactor >= 1.4 && row.avgDay > 0) return { tone: 'focus', text: 'сильна точка входу, тримати в основному фокусі' };
    if (row.pnl > 0 && row.winRate < 45 && row.avgWin > row.avgLoss * 1.4) return { tone: 'asymmetry', text: 'працює через асиметрію, головне не різати плюси зарано' };
    if (row.pnl < 0 && row.winRate >= 50 && row.avgLoss > row.avgWin) return { tone: 'risk', text: 'часто правий напрямок, але мінус більший за плюс, треба стискати стоп/ризик' };
    if (row.pnl < 0) return { tone: 'reduce', text: 'забирає результат, зменшити ризик і додати фільтр входу' };
    return { tone: 'filter', text: 'нейтральна зона, брати тільки найчистіші сетапи' };
}

export function buildTradeTypeAIContext(journal = {}, options = {}) {
    const rows = buildTradeTypeInsightRows(journal, options);
    if (!rows.length) return '\n\nАНАЛІЗ ТИПІВ ВХОДУ: даних по типах входу поки немає.';

    const limit = Number(options.limit) || 6;
    const lines = rows.slice(0, limit).map((row, index) => {
        const pf = row.profitFactor === Infinity ? '∞' : row.profitFactor.toFixed(2);
        const kf = row.avgKf === null ? '' : `, середній КФ ${row.avgKf.toFixed(2)}`;
        return `${index + 1}. ${row.type}: PnL ${money(row.pnl)}, ${row.days} дн., WR ${row.winRate.toFixed(0)}%, PF ${pf}, середній день ${money(row.avgDay)}${kf}. Висновок: ${row.advice.text}.`;
    });

    const best = rows.find((row) => row.pnl > 0);
    const worst = [...rows].reverse().find((row) => row.pnl < 0);
    const header = [
        '',
        '',
        'АНАЛІЗ ТИПІВ ВХОДУ:',
        'Кожен тип входу вважай окремою логікою. Не змішуй висновки між ними.',
        best ? `Головний фокус зараз: ${best.type} (${money(best.pnl)}).` : '',
        worst ? `Зона ризику: ${worst.type} (${money(worst.pnl)}).` : '',
    ].filter(Boolean);

    return `${header.join('\n')}\n${lines.join('\n')}`;
}

export function buildDayTradeTypeAIContext(dayEntry = {}) {
    const entry = applyAutoTradeTypesData({ ...(dayEntry || {}) });
    const data = entry.tradeTypesData && typeof entry.tradeTypesData === 'object' ? entry.tradeTypesData : {};
    const rows = Object.entries(data)
        .map(([type, item]) => ({ type, pnl: Number(item?.pnl), kf: Number(item?.kf) }))
        .filter((row) => Number.isFinite(row.pnl))
        .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

    if (!rows.length) return '\nТипи входу за день: не визначені.';
    return '\nТипи входу за день:\n' + rows.map((row) => {
        const kf = Number.isFinite(row.kf) && row.kf !== 0 ? `, КФ ${row.kf.toFixed(2)}` : '';
        return `- ${row.type}: ${money(row.pnl)}${kf}`;
    }).join('\n');
}

export function buildTradeSpecificTypeAIContext(trade = {}, journal = {}) {
    const rawType = String(trade?.type || trade?.sheet?.tradeType || '').toLowerCase();
    const type = classifyTradeTypeGroup(trade) || (rawType.includes('short') ? DEFAULT_TRADE_TYPES[0] : null);
    const overall = buildTradeTypeAIContext(journal, { limit: 4, recentDays: 90 });
    if (!type) return `${overall}\n\nТип поточної угоди: не визначений. Якщо бачиш його з контексту, аналізуй як окрему логіку входу.`;
    return `${overall}\n\nТип поточної угоди: ${type}. Оцінюй угоду саме крізь логіку цього типу входу, а не як універсальний сетап.`;
}
