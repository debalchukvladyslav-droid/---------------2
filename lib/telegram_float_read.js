import { floatsForDate } from './telegram_float.js';

function env(name) {
    const value = process.env[name];
    return typeof value === 'string' ? value.trim() : '';
}

export function telegramFloatStatus(chat = '') {
    const apiId = env('TELEGRAM_API_ID');
    const apiHash = env('TELEGRAM_API_HASH');
    const session = env('TELEGRAM_STRING_SESSION');
    const configuredChat = chat || env('TELEGRAM_FLOAT_CHAT');
    const missing = [
        !apiId ? 'TELEGRAM_API_ID' : '',
        !apiHash ? 'TELEGRAM_API_HASH' : '',
        !session ? 'TELEGRAM_STRING_SESSION' : '',
        !configuredChat ? 'групу' : '',
    ].filter(Boolean);
    return {
        connected: missing.length === 0,
        chat: configuredChat,
        missing,
    };
}

function messageTime(message) {
    const value = message?.date;
    if (value instanceof Date) return value.getTime();
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? number * 1000 : number;
}

export async function readTelegramFloats(dates, chat = '') {
    const status = telegramFloatStatus(chat);
    if (!status.connected) {
        const note = status.missing.includes('групу')
            ? 'Вкажіть групу Telegram, де Валєра відповідає на тікери.'
            : 'Telegram-акаунт ще не підключено. Потрібні API ID, API Hash і сесія користувача, бо вхід ботом не читає групу.';
        return { connected: false, floats: {}, note };
    }
    let TelegramClient;
    let StringSession;
    try {
        ({ TelegramClient } = await import('telegram'));
        ({ StringSession } = await import('telegram/sessions/index.js'));
    } catch {
        return {
            connected: false,
            floats: {},
            note: 'На сервері не встановлено клієнт Telegram.',
        };
    }
    const wanted = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))))];
    if (!wanted.length) return { connected: true, floats: {}, note: '' };
    const oldest = wanted.reduce((min, date) => (date < min ? date : min));
    const stopBefore = Date.parse(`${oldest}T00:00:00.000Z`) - 36 * 60 * 60 * 1000;
    const client = new TelegramClient(
        new StringSession(env('TELEGRAM_STRING_SESSION')),
        Number(env('TELEGRAM_API_ID')),
        env('TELEGRAM_API_HASH'),
        { connectionRetries: 2 },
    );
    await client.connect();
    try {
        if (!await client.checkAuthorization()) {
            return { connected: false, floats: {}, note: 'Сесія Telegram недійсна. Підключіть акаунт знову.' };
        }
        const entity = await client.getEntity(status.chat);
        const raw = [];
        for await (const message of client.iterMessages(entity, { limit: 800 })) {
            const at = messageTime(message);
            if (at != null && at < stopBefore) break;
            raw.push({
                id: message.id,
                date: at,
                text: message.message || message.text || '',
                fromUsername: message.sender?.username || message._sender?.username || '',
                fromName: message.sender?.firstName || message._sender?.firstName || '',
                replyToId: message.replyTo?.replyToMsgId || message.replyToMsgId || null,
            });
        }
        const floats = {};
        wanted.forEach((date) => {
            const day = floatsForDate(raw, date);
            Object.entries(day).forEach(([ticker, shares]) => {
                floats[`${date}|${ticker}`] = shares;
            });
        });
        return { connected: true, floats, note: '' };
    } finally {
        await client.disconnect().catch(() => {});
    }
}
