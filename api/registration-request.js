import { supabaseRest, verifySupabaseUser } from '../lib/google_sheet_sync.js';

const ADMIN_EMAIL = process.env.REGISTRATION_ADMIN_EMAIL || 'debalchukvladyslav@gmail.com';

function sendJson(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function cleanHeader(value, max = 200) {
    return String(Array.isArray(value) ? value[0] : value || '').trim().slice(0, max);
}

function requestIp(req) {
    const forwarded = cleanHeader(req.headers['x-forwarded-for']);
    return (forwarded.split(',')[0] || cleanHeader(req.headers['x-real-ip']) || '').trim().slice(0, 64);
}

function requestLocation(req) {
    return {
        country: cleanHeader(req.headers['x-vercel-ip-country'], 8),
        region: cleanHeader(req.headers['x-vercel-ip-country-region'], 32),
        city: cleanHeader(req.headers['x-vercel-ip-city'], 100),
        timezone: cleanHeader(req.headers['x-vercel-ip-timezone'], 80),
    };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}

async function sendAdminEmail(profile, registration) {
    const apiKey = String(process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY is not configured' };
    const from = String(process.env.REGISTRATION_EMAIL_FROM || 'Trading Journal <onboarding@resend.dev>').trim();
    const location = [registration.city, registration.region, registration.country].filter(Boolean).join(', ') || 'Unknown';
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `registration-${profile.id}`,
        },
        body: JSON.stringify({
            from,
            to: [ADMIN_EMAIL],
            subject: `Нова заявка на реєстрацію: ${profile.nick || profile.email || profile.id}`,
            html: `
                <h2>Нова заявка на доступ</h2>
                <p><b>Email:</b> ${escapeHtml(profile.email || '')}</p>
                <p><b>Нік:</b> ${escapeHtml(profile.nick || '')}</p>
                <p><b>Ім’я:</b> ${escapeHtml([profile.first_name, profile.last_name].filter(Boolean).join(' '))}</p>
                <p><b>Команда:</b> ${escapeHtml(profile.team || '')}</p>
                <p><b>IP:</b> ${escapeHtml(registration.ip || 'Unknown')}</p>
                <p><b>Приблизна локація:</b> ${escapeHtml(location)}</p>
                <p><b>Час:</b> ${escapeHtml(registration.requested_at)}</p>
                <p>Схвалити або відхилити заявку можна в адмін-панелі сайту.</p>
            `,
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Email notification failed: ${response.status} ${body}`);
    }
    return { sent: true };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }
    try {
        const user = await verifySupabaseUser(req.headers.authorization || '', { requireApproved: false });
        if (!user?.id || !user.email_confirmed_at) {
            return sendJson(res, 401, { ok: false, error: 'Confirmed email session is required' });
        }
        const rows = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(user.id)}&select=id,nick,email,first_name,last_name,team,role,settings&limit=1`,
        );
        const profile = rows?.[0];
        if (!profile) return sendJson(res, 404, { ok: false, error: 'Profile not found' });
        if (profile.role === 'admin' || profile.settings?.account_approved === true) {
            return sendJson(res, 200, { ok: true, status: 'approved' });
        }
        if (
            profile.settings?.account_blocked === true
            || profile.settings?.registration_request?.status === 'rejected'
        ) {
            return sendJson(res, 403, { ok: false, error: 'Registration request was rejected' });
        }

        const previous = profile.settings?.registration_request || {};
        const registration = {
            requested_at: previous.requested_at || new Date().toISOString(),
            confirmed_at: user.email_confirmed_at,
            ip: previous.ip || requestIp(req),
            user_agent: previous.user_agent || cleanHeader(req.headers['user-agent'], 300),
            ...requestLocation(req),
            status: 'pending',
        };
        const settings = {
            ...(profile.settings || {}),
            account_approved: false,
            registration_request: registration,
        };
        await supabaseRest(`profiles?id=eq.${encodeURIComponent(user.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ settings, updated_at: new Date().toISOString() }),
        });

        let email = { sent: false };
        if (!previous.notified_at) {
            try {
                email = await sendAdminEmail(profile, registration);
                if (email.sent) {
                    registration.notified_at = new Date().toISOString();
                    settings.registration_request = registration;
                    await supabaseRest(`profiles?id=eq.${encodeURIComponent(user.id)}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ settings }),
                    });
                }
            } catch (error) {
                console.error('[Registration notification]', error?.message || error);
                email = { sent: false };
            }
        }
        return sendJson(res, 202, { ok: true, status: 'pending', email_sent: email.sent === true });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
}
