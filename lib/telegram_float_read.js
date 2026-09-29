import { chatRecord, floatsForDate } from './telegram_float.js';

function env(name) {
    const value = process.env[name];
    return typeof value === 'string' ? value.trim() : '';
}

function accountMissing() {
    return [
        !env('TELEGRAM_API_ID') ? 'TELEGRAM_API_ID' : '',
        !env('TELEGRAM_API_HASH') ? 'TELEGRAM_API_HASH' : '',
        !env('TELEGRAM_STRING_SESSION') ? 'TELEGRAM_STRING_SESSION' : '',
    ].filter(Boolean);
}

export function telegramFloatStatus(chat = '') {
    const configuredChat = chat || env('TELEGRAM_FLOAT_CHAT');
    const missing = [
        ...accountMissing(),
        !configuredChat ? 'групу' : '',
    ].filter(Boolean);
    return {
        connected: missing.length === 0,
        chat: configuredChat,
        missing,
    };
}

function disconnectedNote(missing) {
    return missing.includes('групу')
        ? 'Вкажіть групу Telegram, де Валєра відповідає на тікери.'
        : 'Telegram-акаунт ще не підключено. Потрібні API ID, API Hash і сесія користувача, бо вхід ботом не читає групу.';
}

async function loadTelegram() {
    try {
        const telegram = await import('telegram');
        const sessions = await import('telegram/sessions/index.js');
        return { TelegramClient: telegram.TelegramClient, Api: telegram.Api, StringSession: sessions.StringSession };
    } catch {
        return null;
    }
}

function inputPeer(Api, key) {
    const text = String(key || '').trim();
    if (text.startsWith('channel:')) {
        const [, id, accessHash] = text.split(':');
        return new Api.InputPeerChannel({ channelId: BigInt(id), accessHash: BigInt(accessHash) });
    }
    if (text.startsWith('chat:')) return new Api.InputPeerChat({ chatId: BigInt(text.slice(5)) });
    return text;
}

async function withClient(run) {
    if (accountMissing().length) {
        return { connected: false, note: disconnectedNote(accountMissing()) };
    }
    const loaded = await loadTelegram();
    if (!loaded) return { connected: false, note: 'На сервері не встановлено клієнт Telegram.' };
    const client = new loaded.TelegramClient(
        new loaded.StringSession(env('TELEGRAM_STRING_SESSION')),
        Number(env('TELEGRAM_API_ID')),
        env('TELEGRAM_API_HASH'),
        { connectionRetries: 2 },
    );
    await client.connect();
    try {
        if (!await client.checkAuthorization()) {
            return { connected: false, note: 'Сесія Telegram недійсна. Підключіть акаунт знову.' };
        }
        return await run(client, loaded.Api);
    } finally {
        await client.disconnect().catch(() => {});
    }
}

function messageTime(message) {
    const value = message?.date;
    if (value instanceof Date) return value.getTime();
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? number * 1000 : number;
}

export async function listTelegramChats() {
    const result = await withClient(async (client) => {
        const dialogs = await client.getDialogs({ limit: 400 });
        const chats = dialogs
            .map((dialog) => chatRecord(dialog))
            .filter(Boolean)
            .sort((a, b) => a.title.localeCompare(b.title, 'uk'));
        return { connected: true, chats, note: chats.length ? '' : 'Груп у цьому акаунті не знайдено.' };
    });
    if (result.connected === false) return { ...result, chats: [] };
    return result;
}

export async function readTelegramFloats(dates, chat = '') {
    const status = telegramFloatStatus(chat);
    if (!status.connected) return { connected: false, floats: {}, note: disconnectedNote(status.missing) };
    const wanted = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))))];
    if (!wanted.length) return { connected: true, floats: {}, note: '' };
    const oldest = wanted.reduce((min, date) => (date < min ? date : min));
    const stopBefore = Date.parse(`${oldest}T00:00:00.000Z`) - 36 * 60 * 60 * 1000;
    const result = await withClient(async (client, Api) => {
        const peer = inputPeer(Api, status.chat);
        const entity = typeof peer === 'string' ? await client.getEntity(peer) : peer;
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
    });
    if (result.connected === false) return { ...result, floats: {} };
    return result;
}
