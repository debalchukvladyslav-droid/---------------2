import { requireAdmin, sendJson } from './service_bots.js';
import { supabaseRest } from './google_sheet_sync.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}

export function publicSiteUrl() {
    const raw = [
        process.env.APP_PUBLIC_URL,
        process.env.NEXT_PUBLIC_SITE_URL,
        process.env.VERCEL_PROJECT_PRODUCTION_URL,
        process.env.VERCEL_URL,
    ].map(value => String(value || '').trim()).find(Boolean) || 'https://traderjournal-six.vercel.app';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        return new URL(withProtocol).origin;
    } catch {
        return 'https://traderjournal-six.vercel.app';
    }
}

export function approvalEmailContent(profile, siteUrl = publicSiteUrl()) {
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || profile?.nick || '';
    const greeting = name ? `Привіт, ${escapeHtml(name)}!` : 'Привіт!';
    const safeUrl = escapeHtml(siteUrl);
    return {
        subject: 'Ваш акаунт схвалено',
        html: `
            <h2>Ваш акаунт схвалено</h2>
            <p>${greeting}</p>
            <p>Адміністратор схвалив вашу заявку на доступ до Trading Journal.</p>
            <p>Тепер можна увійти на сайт з тим самим email і паролем, які ви вказали під час реєстрації.</p>
            <p><a href="${safeUrl}">Увійти в журнал</a></p>
        `,
    };
}

export async function sendApprovalEmail(profile, { fetchImpl = fetch } = {}) {
    const to = String(profile?.email || '').trim();
    if (!to) return { sent: false, reason: 'У профілі немає email' };
    if (profile?.settings?.registration_request?.approval_notified_at) {
        return { sent: true, reason: 'already_sent' };
    }
    const apiKey = String(process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY is not configured' };
    const from = String(process.env.REGISTRATION_EMAIL_FROM || 'Trading Journal <onboarding@resend.dev>').trim();
    const content = approvalEmailContent(profile);
    const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `registration-approved-${profile.id}`,
        },
        body: JSON.stringify({
            from,
            to: [to],
            subject: content.subject,
            html: content.html,
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Approval email failed: ${response.status} ${body}`.slice(0, 300));
    }
    return { sent: true };
}

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        if (req.method === 'GET') {
            const rows = await supabaseRest(
                'profiles?select=id,nick,email,first_name,last_name,team,role,settings,created_at&order=created_at.desc',
            );
            const requests = (rows || []).filter(row =>
                row.role !== 'admin'
                && row.settings?.account_approved !== true
                && row.settings?.registration_request?.status !== 'rejected'
            );
            return sendJson(res, 200, { ok: true, requests });
        }
        if (req.method !== 'PATCH') {
            res.setHeader('Allow', 'GET, PATCH');
            return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        }
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const userId = String(body.user_id || '').trim();
        const action = String(body.action || '').trim();
        if (!userId || !['approve', 'reject'].includes(action)) {
            return sendJson(res, 400, { ok: false, error: 'Invalid request' });
        }
        const rows = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(userId)}&select=id,nick,email,first_name,last_name,settings&limit=1`,
        );
        const profile = rows?.[0];
        if (!profile) return sendJson(res, 404, { ok: false, error: 'Profile not found' });
        const now = new Date().toISOString();
        const settings = {
            ...(profile.settings || {}),
            account_approved: action === 'approve',
            account_blocked: action === 'reject',
            registration_request: {
                ...(profile.settings?.registration_request || {}),
                status: action === 'approve' ? 'approved' : 'rejected',
                decided_at: now,
            },
        };
        let email = { sent: false };
        if (action === 'approve') {
            try {
                email = await sendApprovalEmail({ ...profile, settings });
                if (email.sent && email.reason !== 'already_sent') {
                    settings.registration_request.approval_notified_at = now;
                }
            } catch (error) {
                console.error('[Registration approval email]', error?.message || error);
                email = { sent: false, reason: error?.message || String(error) };
            }
        }
        await supabaseRest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ settings, updated_at: now }),
        });
        return sendJson(res, 200, {
            ok: true,
            status: settings.registration_request.status,
            email_sent: email.sent === true,
            email_error: email.sent ? '' : (email.reason || ''),
        });
    } catch (error) {
        return sendJson(res, error?.status || 500, { ok: false, error: error?.message || String(error) });
    }
}
