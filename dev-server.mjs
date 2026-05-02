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
function readLocalClientConfig() {
    try {
        const source = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
        const getString = (name) => {
            const re = new RegExp(`${name}\\s*:\\s*(['"])(.*?)\\1`);
            return source.match(re)?.[2] || '';
        };
        return {
            supabaseUrl: getString('supabaseUrl'),
            supabaseAnonKey: getString('supabaseAnonKey'),
        };
    } catch {
        return {};
    }
}

const localClientConfig = readLocalClientConfig();
const SUPABASE_URL = (process.env.SUPABASE_URL || localClientConfig.supabaseUrl || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || localClientConfig.supabaseAnonKey || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const CNN_FEAR_GREED_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([DEFAULT_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-pro']);
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const FEAR_GREED_CACHE_TTL_MS = 10 * 60 * 1000;
let fearGreedCache = { ts: 0, payload: null };

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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

async function handleFearGreed(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }
    if (req.method !== 'GET') {
        sendJson(res, 405, { message: 'Method not allowed' });
        return;
    }

    const authResult = await verifySupabaseAuth(req.headers.authorization);
    if (!authResult.ok) {
        sendJson(res, authResult.status, { message: authResult.message });
        return;
    }

    if (fearGreedCache.payload && Date.now() - fearGreedCache.ts < FEAR_GREED_CACHE_TTL_MS) {
        sendJson(res, 200, { ...fearGreedCache.payload, cached: true });
        return;
    }

    try {
        const raw = await fetchCnnFearGreed();
        const payload = normalizeFearGreedPayload(raw);
        fearGreedCache = { ts: Date.now(), payload };
        sendJson(res, 200, payload);
    } catch (e) {
        const degraded = {
            provider: 'cnn',
            sourceUrl: 'https://www.cnn.com/markets/fear-and-greed',
            degraded: true,
            reason: e.message || 'Fear & Greed fetch failed',
            updatedAt: new Date().toISOString(),
        };
        fearGreedCache = { ts: Date.now(), payload: degraded };
        sendJson(res, 200, degraded);
    }
}

async function fetchCnnFearGreed() {
    const response = await fetch(CNN_FEAR_GREED_URL, {
        headers: {
            accept: 'application/json',
            referer: 'https://edition.cnn.com/',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.message || `CNN Fear & Greed error ${response.status}`);
    return data;
}

function normalizeFearGreedPayload(raw) {
    const fg = raw?.fear_and_greed || {};
    const score = normalizeScore(fg.score);
    const rating = normalizeRating(fg.rating, score);
    return {
        provider: 'cnn',
        sourceUrl: 'https://www.cnn.com/markets/fear-and-greed',
        score,
        rating,
        ratingLabel: ratingToLabel(rating),
        timestamp: normalizeTimestamp(fg.timestamp),
        previous: {
            close: normalizeScore(fg.previous_close),
            week: normalizeScore(fg.previous_1_week),
            month: normalizeScore(fg.previous_1_month),
            year: normalizeScore(fg.previous_1_year),
        },
        updatedAt: new Date().toISOString(),
    };
}

function normalizeScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function normalizeRating(value, score) {
    const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (raw) return raw;
    const n = Number(score);
    if (!Number.isFinite(n)) return 'neutral';
    if (n <= 25) return 'extreme_fear';
    if (n < 45) return 'fear';
    if (n <= 55) return 'neutral';
    if (n < 75) return 'greed';
    return 'extreme_greed';
}

function ratingToLabel(rating) {
    return {
        extreme_fear: 'Extreme Fear',
        fear: 'Fear',
        neutral: 'Neutral',
        greed: 'Greed',
        extreme_greed: 'Extreme Greed',
    }[rating] || 'Neutral';
}

function normalizeTimestamp(value) {
    if (!value) return null;
    const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
    if (u.pathname === '/api/fear-greed') {
        handleFearGreed(req, res).catch((e) => {
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
