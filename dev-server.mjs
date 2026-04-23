/**
 * Локальна розробка замість Live Server: статика + POST /api/gemini
 * (як serverless-роут на Vercel). Live Server не вміє POST — дає 405.
 *
 * Запуск (PowerShell):
 *   $env:GEMINI_API_KEY="ваш_ключ"; node dev-server.mjs
 * або *   npm run dev
 * після того як задали GEMINI_API_KEY у системі / .env (див. нижче).
 *
 * Відкрийте http://127.0.0.1:8787/ (не 5500).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const portArgIndex = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
const portArg = portArgIndex >= 0 ? process.argv[portArgIndex + 1] : '';
const PORT = Number(portArg || process.env.PORT) || 8787;

/** Дубль js/supabase.js — для Node без імпорту CDN-модуля */
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://gijarvlerztfggxhuvow.supabase.co').replace(/\/$/, '');
const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || 'sb_publishable_4gU0201mMkinUqwH-4SkWA_eSoNqew6';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([DEFAULT_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-pro']);
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function verifySupabaseAuth(authHeader) {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return { ok: false, status: 401, message: 'Missing auth token' };
    try {
        const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                Authorization: `Bearer ${token}`,
                apikey: SUPABASE_ANON_KEY,
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!authRes.ok) return { ok: false, status: 401, message: 'Invalid auth token' };
        return { ok: true };
    } catch (e) {
        return { ok: false, status: 502, message: e.message || 'Supabase auth check failed' };
    }
}

function isPayloadSizeAllowed(payload) {
    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES;
    } catch {
        return false;
    }
}

async function handleGemini(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' });
        return;
    }

    const authResult = await verifySupabaseAuth(req.headers.authorization);
    if (!authResult.ok) {
        sendJson(res, authResult.status, { message: authResult.message });
        return;
    }
    if (!GEMINI_API_KEY) {
        sendJson(res, 500, {
            message: 'GEMINI_API_KEY not set. In PowerShell: $env:GEMINI_API_KEY="..."; node dev-server.mjs',
        });
        return;
    }

    let body;
    try {
        body = JSON.parse(await readBody(req));
    } catch {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
    }

    const { payload, model: rawModel } = body || {};
    if (!payload || typeof payload !== 'object') {
        sendJson(res, 400, { message: 'Missing payload' });
        return;
    }
    if (!isPayloadSizeAllowed(payload)) {
        sendJson(res, 413, { message: 'AI payload is too large' });
        return;
    }

    const model = typeof rawModel === 'string' && ALLOWED_MODELS.has(rawModel) ? rawModel : DEFAULT_MODEL;
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;

    let geminiRes;
    try {
        geminiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25000),
        });
    } catch (e) {
        sendJson(res, 502, { message: e.message || 'Gemini fetch failed' });
        return;
    }

    let data;
    try {
        data = await geminiRes.json();
    } catch {
        sendJson(res, 502, { message: 'Invalid JSON from Gemini' });
        return;
    }
    if (!geminiRes.ok) {
        sendJson(res, geminiRes.status, {
            message: data?.error?.message || `Gemini error ${geminiRes.status}`,
        });
        return;
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim()
        : '';
    if (!text) {
        sendJson(res, 502, { message: 'Empty response from Gemini' });
        return;
    }
    sendJson(res, 200, { text });
}

function safeJoin(root, urlPath) {
    const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = path.join(root, rel);
    if (!full.startsWith(root)) return null;
    return full;
}

function serveStatic(req, res) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    let pathname = u.pathname;
    if (pathname === '/') pathname = '/index.html';

    const filePath = safeJoin(ROOT, pathname.slice(1));
    if (!filePath) {
        res.writeHead(403);
        res.end();
        return;
    }

    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
            if (!path.extname(pathname)) {
                const indexPath = path.join(ROOT, 'index.html');
                const stream = fs.createReadStream(indexPath);
                res.writeHead(200, { 'Content-Type': MIME['.html'] });
                stream.pipe(res);
                return;
            }
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        const stream = fs.createReadStream(filePath);
        res.writeHead(200, { 'Content-Type': type });
        stream.pipe(res);
    });
}

const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/api/gemini') {
        handleGemini(req, res).catch((e) => {
            console.error(e);
            sendJson(res, 500, { message: e.message || 'Server error' });
        });
        return;
    }
    serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Локальний dev: http://127.0.0.1:${PORT}/\n  (не використовуйте Live Server для AI — там немає POST /api/gemini)\n`);
    if (!GEMINI_API_KEY) {
        console.warn('  Увага: GEMINI_API_KEY порожній — AI повертатиме 500.\n');
    }
});
