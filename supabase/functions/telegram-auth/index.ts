/**
 * Telegram Login:
 *  - GET ?action=oauth&return_to=… — повертає URL на oauth.telegram.org/auth (повноекранний вхід, без iframe/popup віджета).
 *  - POST JSON — перевірка hash → Supabase Auth (email+password, сесія для клієнта).
 *
 * Секрети (Dashboard → Edge Functions → Secrets або `supabase secrets set`):
 *   TELEGRAM_BOT_TOKEN — токен бота з @BotFather
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — зазвичай підставляються автоматично
 *
 * У @BotFather для бота: /setdomain — ваш домен (де відкрито журнал).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

function cors(origin: string | null) {
    const allow = origin || '*';
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
}

function callerPageOrigin(req: Request): string | null {
    const o = req.headers.get('Origin')?.trim();
    if (o && o !== 'null') return o;
    const ref = req.headers.get('Referer')?.trim();
    if (!ref) return null;
    try {
        return new URL(ref).origin;
    } catch {
        return null;
    }
}

function strRecord(raw: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v === null || v === undefined) continue;
        out[k] = String(v);
    }
    return out;
}

async function verifyTelegramWidget(auth: Record<string, string>, botToken: string): Promise<boolean> {
    const hash = (auth.hash || '').toLowerCase();
    if (!hash) return false;
    const pairs = Object.keys(auth)
        .filter((k) => k !== 'hash')
        .sort()
        .map((k) => `${k}=${auth[k]}`);
    const dataCheckString = pairs.join('\n');
    const enc = new TextEncoder();
    const secretKeyMaterial = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        secretKeyMaterial,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(dataCheckString));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === hash;
}

async function loginPasswordHex(botToken: string, telegramId: string): Promise<string> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyMaterial,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`pj-tg-login|${telegramId}`));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
    const origin = req.headers.get('Origin');
    const c = cors(origin);
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: c });
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim();

    if (req.method === 'GET') {
        const u = new URL(req.url);
        if (u.searchParams.get('action') !== 'oauth') {
            return new Response(JSON.stringify({ error: 'Use GET ?action=oauth&return_to=… or POST for token exchange' }), {
                status: 404,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        if (!botToken) {
            return new Response(JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN missing' }), {
                status: 500,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        const returnTo = u.searchParams.get('return_to');
        if (!returnTo) {
            return new Response(JSON.stringify({ error: 'return_to required' }), {
                status: 400,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        let returnUrl: URL;
        try {
            returnUrl = new URL(returnTo);
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid return_to' }), {
                status: 400,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        if (returnUrl.protocol !== 'https:' && returnUrl.protocol !== 'http:') {
            return new Response(JSON.stringify({ error: 'Invalid return_to scheme' }), {
                status: 400,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        const pageOrigin = callerPageOrigin(req);
        if (!pageOrigin) {
            return new Response(JSON.stringify({ error: 'Origin/Referer required' }), {
                status: 403,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        if (returnUrl.origin !== pageOrigin) {
            return new Response(JSON.stringify({ error: 'return_to must match site origin' }), {
                status: 403,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }

        const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        const meJson = await meRes.json();
        if (!meJson?.ok || !meJson?.result?.id) {
            return new Response(JSON.stringify({ error: 'Telegram getMe failed' }), {
                status: 502,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        const botId = meJson.result.id as number;
        const oauthBase = 'https://oauth.telegram.org';
        const authUrl =
            `${oauthBase}/auth?bot_id=${encodeURIComponent(String(botId))}` +
            `&origin=${encodeURIComponent(returnUrl.origin)}` +
            `&request_access=write` +
            `&return_to=${encodeURIComponent(returnTo)}`;

        return new Response(JSON.stringify({ url: authUrl }), {
            status: 200,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();

    if (!botToken || !supabaseUrl || !serviceRole) {
        return new Response(JSON.stringify({ error: 'Server misconfigured (TELEGRAM_BOT_TOKEN / Supabase URL / service role)' }), {
            status: 500,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }
    if (!anonKey) {
        return new Response(
            JSON.stringify({
                error: 'Missing SUPABASE_ANON_KEY in Edge environment (додайте secret або оновіть runtime)',
            }),
            { status: 500, headers: { ...c, 'Content-Type': 'application/json' } },
        );
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }

    const auth = strRecord(body);
    if (!(await verifyTelegramWidget(auth, botToken))) {
        return new Response(JSON.stringify({ error: 'Invalid Telegram signature' }), {
            status: 401,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }

    const authDate = parseInt(auth.auth_date || '0', 10);
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) {
        return new Response(JSON.stringify({ error: 'auth_date expired' }), {
            status: 401,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }

    const telegramId = (auth.id || '').replace(/\D/g, '');
    if (!telegramId) {
        return new Response(JSON.stringify({ error: 'Missing telegram id' }), {
            status: 400,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }

    const host = new URL(supabaseUrl).hostname;
    const projectRef = host.split('.')[0] || 'project';
    const email = `tg_${telegramId}@telegram.${projectRef}.invalid`;
    const password = await loginPasswordHex(botToken, telegramId);

    const firstName = (auth.first_name || '').trim() || 'Telegram';
    const lastName = (auth.last_name || '').trim();
    const username = (auth.username || '').trim();

    const admin = createClient(supabaseUrl, serviceRole, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const anon = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    const userMeta = {
        telegram_id: telegramId,
        telegram_username: username,
        first_name: firstName,
        last_name: lastName,
        full_name: [firstName, lastName].filter(Boolean).join(' ').trim(),
        name: [firstName, lastName].filter(Boolean).join(' ').trim(),
    };

    const { error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { provider: 'telegram' },
        user_metadata: userMeta,
    });

    if (createErr) {
        const msg = String(createErr.message || '').toLowerCase();
        const dup = msg.includes('already') || msg.includes('registered') || createErr.status === 422;
        if (!dup) {
            return new Response(JSON.stringify({ error: createErr.message || 'createUser failed' }), {
                status: 400,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        const filter = encodeURIComponent(`email.eq.${email}`);
        let lr = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1&filter=${filter}`, {
            headers: {
                Authorization: `Bearer ${serviceRole}`,
                apikey: serviceRole,
            },
        });
        let lj = await lr.json();
        let uid = lj?.users?.[0]?.id as string | undefined;
        if (!uid) {
            lr = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
                headers: {
                    Authorization: `Bearer ${serviceRole}`,
                    apikey: serviceRole,
                },
            });
            lj = await lr.json();
            uid = (lj?.users as { id: string; email?: string }[] | undefined)?.find((u) => u.email === email)?.id;
        }
        if (!uid) {
            return new Response(JSON.stringify({ error: 'User exists but lookup failed' }), {
                status: 500,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
        const { error: upErr } = await admin.auth.admin.updateUserById(uid, {
            password,
            email_confirm: true,
            app_metadata: { provider: 'telegram' },
            user_metadata: userMeta,
        });
        if (upErr) {
            return new Response(JSON.stringify({ error: upErr.message || 'updateUser failed' }), {
                status: 400,
                headers: { ...c, 'Content-Type': 'application/json' },
            });
        }
    }

    const { data: signData, error: signErr } = await anon.auth.signInWithPassword({ email, password });
    if (signErr || !signData?.session) {
        return new Response(JSON.stringify({ error: signErr?.message || 'signIn failed' }), {
            status: 401,
            headers: { ...c, 'Content-Type': 'application/json' },
        });
    }

    return new Response(
        JSON.stringify({
            access_token: signData.session.access_token,
            refresh_token: signData.session.refresh_token,
            expires_in: signData.session.expires_in,
        }),
        { status: 200, headers: { ...c, 'Content-Type': 'application/json' } },
    );
});
