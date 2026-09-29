/**
 * Share float posted in the trading group.
 * People send a ticker, and @Shs_valera_bot replies to that message with a size such as 1.49M.
 */

const BOT_USERNAME = 'shs_valera_bot';
const SKIP_TICKERS = new Set(['YES', 'NO', 'USD', 'ETF', 'IPO', 'CEO', 'ATH', 'OTC', 'NYSE', 'NASDAQ', 'AMEX']);

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function parseShareCount(text) {
    const source = String(text || '').replace(/\u00a0/g, ' ');
    const match = source.match(/(\d+(?:[.,]\d+)?)\s*([kmbкмб])(?!\p{L})/iu);
    if (!match) return null;
    const number = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(number) || number <= 0) return null;
    const suffix = match[2].toLowerCase();
    const scale = suffix === 'k' || suffix === 'к' ? 1e3
        : suffix === 'm' || suffix === 'м' ? 1e6
        : 1e9;
    return Math.round(number * scale);
}

export function tickersInText(text) {
    const found = String(text || '').toUpperCase().match(/\b[A-Z]{1,10}\b/g) || [];
    return [...new Set(found.filter((ticker) => !SKIP_TICKERS.has(ticker)))];
}

export function isValeraMessage(message) {
    const username = String(message?.fromUsername || '').replace(/^@/, '').toLowerCase();
    if (username === BOT_USERNAME) return true;
    const name = String(message?.fromName || '').toLocaleLowerCase('uk-UA');
    return name.includes('валєра') || name.includes('валера');
}

function calendarDate(epochMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(epochMs));
    return parts;
}

function onTradeDate(epochMs, tradeDate) {
    if (!Number.isFinite(epochMs)) return false;
    return calendarDate(epochMs, 'Europe/Kyiv') === tradeDate
        || calendarDate(epochMs, 'America/New_York') === tradeDate;
}

export function chatRecord(dialog) {
    const entity = dialog?.entity || {};
    const className = String(entity.className || '');
    if (className === 'User') return null;
    if (!(dialog?.isGroup || dialog?.isChannel || className === 'Channel' || className === 'Chat')) return null;
    const title = String(dialog?.title || dialog?.name || entity.title || 'Без назви').trim() || 'Без назви';
    const username = String(entity.username || '').replace(/^@/, '');
    let key = '';
    if (username) key = `@${username}`;
    else if (className === 'Channel' && entity.id != null && entity.accessHash != null) key = `channel:${entity.id}:${entity.accessHash}`;
    else if (entity.id != null) key = `chat:${entity.id}`;
    if (!key) return null;
    return { key, title: username ? `${title} (@${username})` : title };
}

export function floatsForDate(messages = [], tradeDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tradeDate || ''))) return {};
    const byId = new Map();
    messages.forEach((message) => {
        if (message?.id != null) byId.set(message.id, message);
    });
    const found = new Map();
    messages.forEach((message) => {
        if (!isValeraMessage(message)) return;
        const shares = parseShareCount(message.text);
        if (shares == null) return;
        const parent = message.replyToId != null ? byId.get(message.replyToId) : null;
        const when = finite(message.date) ?? finite(parent?.date);
        if (!onTradeDate(when, tradeDate)) return;
        const tickers = tickersInText(`${parent?.text || ''}\n${message.text || ''}`);
        tickers.forEach((ticker) => {
            const previous = found.get(ticker);
            if (!previous || when >= previous.at) found.set(ticker, { shares, at: when });
        });
    });
    return Object.fromEntries([...found].map(([ticker, value]) => [ticker, value.shares]));
}
