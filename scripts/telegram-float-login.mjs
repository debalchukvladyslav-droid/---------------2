import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');

function loadEnv() {
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
    }
}

function setEnv(key, value) {
    let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text += (text.endsWith('\n') || text === '' ? '' : '\n') + `${line}\n`;
    fs.writeFileSync(envFile, text);
}

async function waitForPassword(hint) {
    const file = path.join(root, '.env.telegram-password');
    console.log(`2FA needed${hint ? ` (${hint})` : ''}. Write the cloud password to .env.telegram-password`);
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
        if (fs.existsSync(file)) {
            const value = fs.readFileSync(file, 'utf8').trim();
            fs.rmSync(file, { force: true });
            if (value) return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Час очікування пароля Telegram вичерпано');
}

loadEnv();
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || '';
if (!apiId || !apiHash) {
    console.error('У .env немає TELEGRAM_API_ID або TELEGRAM_API_HASH');
    process.exit(1);
}

let png = null;
const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/qr.png')) {
        if (!png) {
            res.statusCode = 404;
            res.end();
            return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(png);
        return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>Telegram</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center}img{width:280px;height:280px;background:#fff;padding:12px}</style>
<main><p>Telegram → Налаштування → Пристрої → Підключити пристрій</p><img src="/qr.png?t=${Date.now()}" alt="QR"><script>setInterval(()=>document.querySelector('img').src='/qr.png?t='+Date.now(),2000)</script></main>`);
});

await new Promise((resolve) => server.listen(8791, '127.0.0.1', resolve));
console.log('QR page: http://127.0.0.1:8791/');

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
await client.connect();
const user = await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
        qrCode: async (code) => {
            const token = Buffer.from(code.token).toString('base64url');
            png = await QRCode.toBuffer(`tg://login?token=${token}`, { margin: 1, width: 280 });
            console.log('QR updated');
        },
        onError: async (error) => {
            console.error(error?.errorMessage || error?.message || error);
            return false;
        },
        password: async (hint) => process.env.TELEGRAM_PASSWORD || waitForPassword(hint || ''),
    },
);

const session = client.session.save();
setEnv('TELEGRAM_STRING_SESSION', session);
const name = [user?.firstName, user?.username ? `@${user.username}` : ''].filter(Boolean).join(' ');
console.log(`session-saved ${name || 'user'}`);
await client.disconnect().catch(() => {});
server.close();
process.exit(0);
