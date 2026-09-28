const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    return clean || '';
}

function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(String(value).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(number) ? number : null;
}

function roundPrice(value) {
    const number = finite(value);
    if (!(number > 0)) return null;
    return Math.round(number * 10000) / 10000;
}

export function consolidationCents(value) {
    const raw = String(value ?? '').replace(/\s/g, '').replace(',', '.');
    if (!/[0-9]/.test(raw)) return null;
    const cents = Number(raw.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(cents) && cents > 0 ? cents : null;
}

export function formulaStopPrice(entryPrice, cents) {
    const entry = finite(entryPrice);
    const risk = consolidationCents(cents);
    if (!(entry > 0) || risk == null) return null;
    return roundPrice(entry + risk / 100);
}

export function exitKind(reason = '') {
    const normalized = text(reason).toLocaleLowerCase('uk-UA').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ');
    if (/(?:^|\s)(?:по часу|за часом|time)(?:\s|$)/iu.test(normalized)) return 'time';
    if (/стоп|stop|s\/?l|(?:^|\s)sl(?:\s|$)/iu.test(normalized)) return 'stop';
    if (/тейк|take|t\/?p|(?:^|\s)tp(?:\s|$)|target|таргет|ціль|цель/iu.test(normalized)) return 'take';
    return 'other';
}

export function isNotTakenTrade(trade = {}, sheet = {}) {
    const blob = [trade?.type, trade?.tradeType, trade?.classification, sheet?.tradeType].map(text).join(' ');
    return /не\s*(брав|взяв)|not\s*taken|no\s*trade/i.test(blob);
}

function isExplicitLong(trade = {}, sheet = {}) {
    const blob = [trade?.type, trade?.side, trade?.direction, sheet?.fondexxType].map(text).join(' ').toLocaleLowerCase('uk-UA');
    return /long|лонг/.test(blob) && !/short|шорт/.test(blob);
}

function clockText(value) {
    const match = String(value ?? '').match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
    return match ? match[1] : null;
}

function clockMinute(value) {
    const clock = clockText(value);
    if (!clock) return null;
    const [hour, minute] = clock.split(':').map(Number);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

function samePrice(left, right) {
    return left != null && right != null && Math.abs(left - right) < 0.0001;
}

function sheetStores(store) {
    const rows = [];
    Object.values(store && typeof store === 'object' ? store : {}).forEach((byDay) => {
        if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) return;
        Object.entries(byDay).forEach(([date, dayRows]) => {
            if (!ISO_DATE.test(date)) return;
            (Array.isArray(dayRows) ? dayRows : []).forEach((row) => {
                const sheet = row?.sheet && typeof row.sheet === 'object' ? row.sheet : {};
                rows.push({
                    date,
                    symbol: text(row?.symbol || sheet.symbol).toUpperCase(),
                    entryPrice: roundPrice(sheet.entryPrice ?? row?.entry),
                    net: finite(sheet.sheetNet ?? row?.net ?? sheet.profit),
                    sheet,
                });
            });
        });
    });
    return rows;
}

function pickSheetRow(rows, date, symbol, entryPrice, net) {
    const sameDay = rows.filter((row) => row.date === date && row.symbol === symbol);
    const priced = entryPrice == null ? [] : sameDay.filter((row) => samePrice(row.entryPrice, entryPrice));
    if (priced.length) return priced[0];
    if (entryPrice != null) return null;
    if (sameDay.length === 1) return sameDay[0];
    if (net == null) return null;
    const close = sameDay.filter((row) => row.net != null && Math.abs(row.net - net) <= Math.max(5, Math.abs(row.net) * 0.08));
    return close.length === 1 ? close[0] : null;
}

function ownOrSheet(own, main, cumulative, key) {
    if (own != null && own !== '') return own;
    const fromMain = main?.sheet?.[key];
    if (fromMain != null && fromMain !== '') return fromMain;
    const fromCumulative = cumulative?.sheet?.[key];
    if (fromCumulative != null && fromCumulative !== '') return fromCumulative;
    return null;
}

function mergedSheet(trade, date, mainRows, cumulativeRows) {
    const own = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    const symbol = text(trade?.symbol || trade?.ticker || own.symbol).toUpperCase();
    const entryPrice = roundPrice(trade?.entry ?? trade?.entryPrice ?? own.entryPrice);
    const net = finite(trade?.net ?? trade?.pnl ?? own.sheetNet ?? own.profit);
    const main = pickSheetRow(mainRows, date, symbol, entryPrice, net);
    const cumulative = pickSheetRow(cumulativeRows, date, symbol, entryPrice, net);
    const keys = ['entryPrice', 'consolidateCents', 'exit', 'tradeType', 'growthPct', 'riskUsd', 'paperType', 'period', 'exceptions', 'exception', 'traderComment', 'teamLeadComment', 'profitRisk', 'qtyShares', 'sheetNet'];
    const sheet = {};
    keys.forEach((key) => { sheet[key] = ownOrSheet(own[key], main, cumulative, key); });
    return sheet;
}

export function resolveTradeStop({ isShort = true, entryPrice, exitPrice, exitReason, consolidateCents: centsValue } = {}) {
    const cents = consolidationCents(centsValue);
    const entry = roundPrice(entryPrice);
    const exit = roundPrice(exitPrice);
    const formula = formulaStopPrice(entry, cents);
    const kind = exitKind(exitReason);
    const formulaNote = 'Ціна входу плюс консолідація в центах.';
    const missingNote = 'Немає консолідації, щоб порахувати стоп.';
    if (isShort && (kind === 'take' || kind === 'time')) {
        if (formula == null) return { price: null, source: null, cents, note: 'Немає консолідації, щоб порахувати стоп для тейка або виходу по часу.' };
        return { price: formula, source: 'sheet', cents, note: formulaNote };
    }
    const cover = isShort && exit != null && entry != null && kind !== 'take' && kind !== 'time' && (kind === 'stop' || exit > entry);
    if (cover) {
        return { price: exit, source: 'cover', cents, note: 'Після шорта покупка закрила стоп. Лінія на ціні покупки.' };
    }
    if (isShort && formula != null) return { price: formula, source: 'sheet', cents, note: formulaNote };
    if (!isShort && kind === 'stop' && exit != null) {
        return { price: exit, source: 'cover', cents, note: 'Вихід позначено як стоп.' };
    }
    return { price: null, source: null, cents, note: isShort ? missingNote : 'Формула стопа для шорта: ціна входу плюс консолідація. Для лонга лінія не ставиться.' };
}

function sheetSection(sheet) {
    const exceptions = Array.isArray(sheet.exceptions)
        ? sheet.exceptions.map(text).filter(Boolean).join(', ')
        : text(sheet.exceptions || sheet.exception);
    return {
        growthPct: finite(sheet.growthPct),
        riskUsd: finite(sheet.riskUsd),
        consolidateCents: consolidationCents(sheet.consolidateCents),
        paperType: text(sheet.paperType) || null,
        period: text(sheet.period) || null,
        exceptions: exceptions || null,
        traderComment: text(sheet.traderComment) || null,
        teamLeadComment: text(sheet.teamLeadComment) || null,
        profitRisk: finite(sheet.profitRisk),
    };
}

function polygonSection(trade, day, symbol, entryTime) {
    const metrics = trade?.marketCriteria || day?.tradePolygons?.[symbol] || null;
    if (!metrics || typeof metrics !== 'object') {
        return { atr: null, avgVol: null, vol: null, volPlay: null, float: null, volPre: null, asOfDate: null };
    }
    const minute = clockMinute(entryTime);
    const volPre = minute == null ? null : finite(metrics.vol_pre_by_minute?.[String(minute)]);
    return {
        atr: finite(metrics.atr),
        avgVol: finite(metrics.avg_vol),
        vol: finite(metrics.vol),
        volPlay: finite(metrics.vol_play),
        float: text(metrics.shs_float_display) || finite(metrics.shs_float),
        volPre,
        asOfDate: text(metrics.as_of_date) || null,
    };
}

export function collectExportTrades(journal = {}, { from = '', to = '', sheetRows = null, cumulativeSheetRows = null, includeSheet = true, includePolygon = true } = {}) {
    const mainRows = sheetStores(sheetRows);
    const cumulativeRows = sheetStores(cumulativeSheetRows);
    const counters = new Map();
    const trades = [];
    Object.keys(journal || {}).filter((date) => ISO_DATE.test(date) && (!from || date >= from) && (!to || date <= to)).sort().forEach((date) => {
        const day = journal[date] || {};
        (Array.isArray(day.trades) ? day.trades : []).forEach((trade, tradeIndex) => {
            const sheet = mergedSheet(trade, date, mainRows, cumulativeRows);
            if (isNotTakenTrade(trade, sheet)) return;
            const symbol = text(trade?.symbol || trade?.ticker || sheet.symbol).toUpperCase();
            if (!/^[A-Z]{1,10}$/.test(symbol)) return;
            const key = `${date}|${symbol}`;
            const index = (counters.get(key) || 0) + 1;
            counters.set(key, index);
            const entryTime = clockText(trade?.opened || trade?.entryTime || trade?.time || trade?.openTime);
            const exitTime = clockText(trade?.closed || trade?.exited || trade?.exitTime || trade?.closeTime);
            const entryPrice = roundPrice(trade?.entry ?? trade?.entryPrice ?? sheet.entryPrice);
            const exitPrice = roundPrice(trade?.exit ?? trade?.exitPrice ?? trade?.closePrice);
            const exitReason = text(sheet.exit || trade?.exitReason || trade?.closeReason || trade?.exitType || trade?.reason);
            const isShort = !isExplicitLong(trade, sheet);
            const record = {
                id: `${date}:${tradeIndex}:${symbol}`,
                date,
                symbol,
                tradeType: text(sheet.tradeType || trade?.tradeType || trade?.type) || null,
                side: isShort ? 'short' : 'long',
                entryTime,
                exitTime,
                entryPrice,
                exitPrice,
                shares: (() => {
                    const shares = Math.abs(finite(trade?.qty ?? trade?.shares ?? sheet.qtyShares) || 0);
                    return shares > 0 ? shares : null;
                })(),
                result: finite(trade?.net ?? trade?.pnl ?? trade?.profit ?? sheet.sheetNet),
                exitReason: exitReason || null,
                stop: resolveTradeStop({ isShort, entryPrice, exitPrice, exitReason, consolidateCents: sheet.consolidateCents }),
                chart: `charts/${date}_${symbol}_${index}.png`,
            };
            if (includeSheet) record.sheet = sheetSection(sheet);
            if (includePolygon) record.polygon = polygonSection(trade, day, symbol, entryTime);
            trades.push(record);
        });
    });
    return trades;
}

export function buildExportDocument(trades, { from = '', to = '' } = {}) {
    return { version: 1, period: { from, to }, trades };
}

export function analysisPrompt() {
    return [
        '# Розбір угод',
        '',
        'Проаналізуй угоди з trades.json. Картинки графіків лежать у charts/ і названі в полі chart кожної угоди.',
        '',
        'На графіку:',
        '- Вхід — ціна і час відкриття.',
        '- Вихід — ціна і час закриття.',
        '- Стоп — горизонтальна лінія. source "sheet" означає ціна входу плюс консолідація в центах: 1.03 + 10 ц = 1.13. source "cover" означає, що після шорта покупка закрила стоп, і лінія стоїть на ціні цієї покупки.',
        '',
        'Правила:',
        '- Використовуй лише поля, які є в JSON. Якщо поле null або секції sheet чи polygon немає, не вигадуй значення.',
        '- Не підміняй стоп ціною виходу, якщо source не "cover".',
        '- Розібери виконання: чи стоп відповідав консолідації, чи тейк або вихід по часу залишив рух, які типи угод і критерії повторюються в плюсі і в мінусі.',
        '',
    ].join('\n');
}

export function exportFileBase(from, to) {
    const start = ISO_DATE.test(from) ? from : 'period';
    const end = ISO_DATE.test(to) ? to : 'period';
    return `analiz-ugod-${start}_${end}`;
}
