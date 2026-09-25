import crypto from 'node:crypto';
import { supabaseRest, verifySupabaseUser } from './google_sheet_sync.js';
import {
    CLIENT_ERROR_NOTIFY_WINDOW_MS,
    acceptClientError,
    formatClientErrorReport,
} from './client_error_report.js';

const ADMIN_EMAIL = process.env.REGISTRATION_ADMIN_EMAIL || 'debalchukvladyslav@gmail.com';
const noticedAt = new Map();

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function cleanHeader(value, max = 180) {
    return String(Array.isArray(value) ? value[0] : value || '').trim().slice(0, max);
}

function requestIp(req) {
    const forwarded = cleanHeader(req.headers['x-forwarded-for'], 200);
    return (forwarded.split(',')[0] || cleanHeader(req.headers['x-real-ip'], 64) || '').trim();
}

function sourceHash(req) {
    return crypto
        .createHash('sha256')
        .update(`${requestIp(req)}\n${cleanHeader(req.headers['user-agent'])}`)
        .digest('hex')
        .slice(0, 32);
}

function readBody(req) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch { return null; }
    }
    return null;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}

function locallyNotified(fingerprint, now) {
    const at = noticedAt.get(fingerprint) || 0;
    return now - at < CLIENT_ERROR_NOTIFY_WINDOW_MS;
}

function rememberNotice(fingerprint, now) {
    noticedAt.set(fingerprint, now);
    if (noticedAt.size < 300) return;
    for (const [key, at] of noticedAt) {
        if (now - at >= CLIENT_ERROR_NOTIFY_WINDOW_MS) noticedAt.delete(key);
    }
}

async function sendAdminEmail(report) {
    const apiKey = String(process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) return false;
    const from = String(process.env.REGISTRATION_EMAIL_FROM || 'Trading Journal <onboarding@resend.dev>').trim();
    const text = formatClientErrorReport(report);
    const bucket = Math.floor(Date.parse(report.happenedAt) / CLIENT_ERROR_NOTIFY_WINDOW_MS);
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `client-error-${report.fingerprint}-${bucket}`,
        },
        body: JSON.stringify({
            from,
            to: [ADMIN_EMAIL],
            subject: `Помилка журналу: ${report.nick || 'гість'} — ${report.message}`.slice(0, 140),
            html: `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(text)}</pre>`,
        }),
    });
    return response.ok;
}

function reportFileName(report) {
    const who = String(report.nick || report.email || 'гість')
        .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
        .trim()
        .slice(0, 40) || 'гість';
    const stamp = String(report.happenedAt || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
    return `помилка ${who} ${stamp}.txt`;
}

function accountCaption(report) {
    const who = [report.nick, report.email].filter(Boolean).join(' · ') || 'гість, ще не увійшов';
    const lines = [`Акаунт: ${who}`];
    if (report.userId) lines.push(`ID: ${report.userId}`);
    if (report.message) lines.push(report.message);
    return lines.join('\n').slice(0, 900);
}

async function sendAdminTelegram(report) {
    const token = String(process.env.ERROR_ALERT_TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(process.env.ERROR_ALERT_TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) return false;
    const text = formatClientErrorReport(report);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', accountCaption(report));
    form.append('document', new File([text], reportFileName(report), { type: 'text/plain' }));
    const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
    });
    if (response.ok) return true;
    const fallback = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text.slice(0, 3900),
            disable_web_page_preview: true,
        }),
    });
    return fallback.ok;
}

async function profileFor(user) {
    if (!user?.id) return null;
    try {
        const rows = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(user.id)}&select=id,nick,email,role&limit=1`,
        );
        return rows?.[0] || null;
    } catch {
        return null;
    }
}

export async function handleClientErrorReport(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }
    const body = readBody(req);
    let user = null;
    try {
        user = await verifySupabaseUser(req.headers.authorization || '', { requireApproved: false });
    } catch {
        user = null;
    }
    const profile = await profileFor(user);
    const now = new Date();
    const context = {
        isAdmin: profile?.role === 'admin',
        userId: profile?.id || null,
        nick: profile?.nick || '',
        email: profile?.email || user?.email || '',
        userAgent: cleanHeader(req.headers['user-agent']),
        sourceHash: sourceHash(req),
        now,
    };
    const sinceBurst = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const sinceNotice = new Date(now.getTime() - CLIENT_ERROR_NOTIFY_WINDOW_MS).toISOString();

    try {
        const result = await acceptClientError(body, context, {
            recentCount: async (report) => {
                const rows = await supabaseRest(
                    `client_error_reports?source_hash=eq.${report.sourceHash}&created_at=gte.${encodeURIComponent(sinceBurst)}&select=id&limit=21`,
                );
                return Array.isArray(rows) ? rows.length : 0;
            },
            wasNotified: async (fingerprint) => {
                if (locallyNotified(fingerprint, now.getTime())) return true;
                const rows = await supabaseRest(
                    `client_error_reports?fingerprint=eq.${fingerprint}&notified_at=not.is.null&created_at=gte.${encodeURIComponent(sinceNotice)}&select=id&limit=1`,
                );
                return Array.isArray(rows) && rows.length > 0;
            },
            insert: async (report) => {
                const rows = await supabaseRest('client_error_reports', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify({
                        fingerprint: report.fingerprint,
                        kind: report.kind,
                        message: report.message,
                        stack: report.stack,
                        page: report.page,
                        tab: report.tab,
                        user_id: report.userId,
                        nick: report.nick,
                        email: report.email,
                        user_agent: report.userAgent,
                        source_hash: report.sourceHash,
                        scenario: report.scenario,
                        location: report.location,
                        happened_at: report.happenedAt,
                    }),
                });
                return { id: rows?.[0]?.id || null };
            },
            markNotified: async (id) => {
                await supabaseRest(`client_error_reports?id=eq.${encodeURIComponent(id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ notified_at: new Date().toISOString() }),
                });
            },
            notify: async (report) => {
                const [email, telegram] = await Promise.all([
                    sendAdminEmail(report).catch(() => false),
                    sendAdminTelegram(report).catch(() => false),
                ]);
                const sent = email || telegram;
                if (sent) rememberNotice(report.fingerprint, now.getTime());
                return sent;
            },
        });
        return sendJson(res, result.status || 200, {
            ok: result.ok,
            skipped: result.skipped,
            dropped: result.dropped,
            stored: result.stored,
            notified: result.notified,
            error: result.error,
        });
    } catch (error) {
        console.error('[client-errors]', error?.message || error);
        return sendJson(res, 500, { ok: false, error: 'Error report failed' });
    }
}
