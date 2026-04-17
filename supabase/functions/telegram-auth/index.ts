/**
 * Telegram через бота (t.me/...?start=TOKEN):
 *  - GET ?action=start_login&return_to=…&apikey=… → JSON { tme_url } (клієнт відкриває t.me; натискає Start у Telegram).
 *  - POST від Telegram (webhook) з /start TOKEN → створення сесії Supabase + посилання з ?tg_claim=… у чат.
 *  - POST JSON { claim: "uuid" } → видача токенів сесії браузеру (одноразово).
 *
 * Налаштування:
 *  1) SQL: database/02_telegram_login_sessions.sql
 *  2) Secrets: TELEGRAM_BOT_TOKEN, (опційно) TELEGRAM_WEBHOOK_SECRET
 *  3) Webhook — у URL додайте apikey (Kong), напр.:
 *     setWebhook?url=https://<ref>.supabase.co/functions/v1/telegram-auth%3Fapikey%3D<ANON_KEY>
 *     Опційно secret_token = TELEGRAM_WEBHOOK_SECRET у BotFather і той самий secret у Edge.
 *  4) deploy: supabase functions deploy telegram-auth
 *  5) Якщо кнопка в боті має вести на бойовий URL, а вхід з іншого origin (Live Server):
 *     secret TELEGRAM_ALLOWED_RETURN_ORIGINS — через кому origins, напр. https://traderjournal-six.vercel.app
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

function corsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
    };
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
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

/** return_to origin збігається з Origin запиту або з allowlist (для dev + бойовий return_to). */
function isReturnToOriginAllowed(returnOrigin: string, pageOrigin: string | null, allowListRaw: string | undefined): boolean {
    if (pageOrigin && returnOrigin === pageOrigin) return true;
    const raw = allowListRaw?.trim();
    if (!raw) return false;
    for (const part of raw.split(',')) {
        const p = part.trim();
        if (!p) continue;
        try {
            const o = new URL(p.includes('://') ? p : `https://${p}`).origin;
            if (o === returnOrigin) return true;
        } catch {
            /* skip invalid entry */
        }
    }
    return false;
}

function randomStartToken(): string {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
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

async function createTelegramAuthSession(
    supabaseUrl: string,
    serviceRole: string,
    anonKey: string,
    botToken: string,
    telegramId: string,
    firstName: string,
    lastName: string,
    username: string,
): Promise<{ access_token: string; refresh_token: string }> {
    const host = new URL(supabaseUrl).hostname;
    const projectRef = host.split('.')[0] || 'project';
    const email = `tg_${telegramId}@telegram.${projectRef}.invalid`;
    const password = await loginPasswordHex(botToken, telegramId);

    const userMeta = {
        telegram_id: telegramId,
        telegram_username: username,
        first_name: firstName,
        last_name: lastName,
        full_name: [firstName, lastName].filter(Boolean).join(' ').trim(),
        name: [firstName, lastName].filter(Boolean).join(' ').trim(),
    };

    const admin = createClient(supabaseUrl, serviceRole, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const anon = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

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
        if (!dup) throw new Error(createErr.message || 'createUser failed');
        const filter = encodeURIComponent(`email.eq.${email}`);
        let lr = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1&filter=${filter}`, {
            headers: { Authorization: `Bearer ${serviceRole}`, apikey: serviceRole },
        });
        let lj = await lr.json();
        let uid = lj?.users?.[0]?.id as string | undefined;
        if (!uid) {
            lr = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
                headers: { Authorization: `Bearer ${serviceRole}`, apikey: serviceRole },
            });
            lj = await lr.json();
            uid = (lj?.users as { id: string; email?: string }[] | undefined)?.find((u) => u.email === email)?.id;
        }
        if (!uid) throw new Error('User exists but lookup failed');
        const { error: upErr } = await admin.auth.admin.updateUserById(uid, {
            password,
            email_confirm: true,
            app_metadata: { provider: 'telegram' },
            user_metadata: userMeta,
        });
        if (upErr) throw new Error(upErr.message || 'updateUser failed');
    }

    const { data: signData, error: signErr } = await anon.auth.signInWithPassword({ email, password });
    if (signErr || !signData?.session) throw new Error(signErr?.message || 'signIn failed');
    return {
        access_token: signData.session.access_token,
        refresh_token: signData.session.refresh_token,
    };
}

async function sendTelegramMessage(
    botToken: string,
    chatId: number,
    text: string,
    replyMarkup?: Record<string, unknown>,
) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
    });
}

Deno.serve(async (req) => {
    const h = corsHeaders();
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: h });
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim();
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
    const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')?.trim();

    if (req.method === 'GET') {
        const u = new URL(req.url);
        const action = u.searchParams.get('action');
        if (action !== 'start_login') {
            return json({ error: 'Use GET ?action=start_login&return_to=…&apikey=…' }, 400);
        }
        if (!botToken || !supabaseUrl || !serviceRole) {
            return json({ error: 'Server misconfigured' }, 500);
        }
        const returnTo = u.searchParams.get('return_to');
        if (!returnTo) return json({ error: 'return_to required' }, 400);
        let returnUrl: URL;
        try {
            returnUrl = new URL(returnTo);
        } catch {
            return json({ error: 'Invalid return_to' }, 400);
        }
        if (returnUrl.protocol !== 'https:' && returnUrl.protocol !== 'http:') {
            return json({ error: 'Invalid return_to scheme' }, 400);
        }
        const pageOrigin = callerPageOrigin(req);
        const allowedExtra = Deno.env.get('TELEGRAM_ALLOWED_RETURN_ORIGINS')?.trim();
        if (!isReturnToOriginAllowed(returnUrl.origin, pageOrigin, allowedExtra)) {
            return json(
                {
                    error:
                        'return_to must match site Origin, або додайте secret TELEGRAM_ALLOWED_RETURN_ORIGINS (origin бойового сайту через кому).',
                },
                403,
            );
        }

        const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        const meJson = await meRes.json();
        if (!meJson?.ok || !meJson?.result?.username) {
            return json({ error: 'Telegram getMe failed' }, 502);
        }
        const botUsername = String(meJson.result.username).replace(/^@/, '');

        const adminDb = createClient(supabaseUrl, serviceRole, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        const startToken = randomStartToken();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const { error: insErr } = await adminDb.from('telegram_login_sessions').insert({
            start_token: startToken,
            return_base: returnTo,
            expires_at: expiresAt,
        });
        if (insErr) {
            console.error('[telegram-auth] insert session', insErr);
            return json({ error: 'DB insert failed (run 02_telegram_login_sessions.sql?)' }, 500);
        }

        const tme = `https://t.me/${encodeURIComponent(botUsername)}?start=${startToken}`;
        return json({ tme_url: tme });
    }

    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    if (!botToken || !supabaseUrl || !serviceRole || !anonKey) {
        return json({ error: 'Server misconfigured' }, 500);
    }

    const adminDb = createClient(supabaseUrl, serviceRole, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    let body: Record<string, unknown>;
    try {
        body = JSON.parse(await req.text());
    } catch {
        return json({ error: 'Invalid JSON' }, 400);
    }

    if (typeof body.update_id === 'number') {
        if (webhookSecret) {
            const hdr = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
            if (hdr !== webhookSecret) {
                return new Response('forbidden', { status: 403, headers: corsHeaders() });
            }
        }

        const msg = (body.message || body.edited_message) as Record<string, unknown> | undefined;
        const text = String(msg?.text || '');
        const chat = msg?.chat as Record<string, unknown> | undefined;
        const from = msg?.from as Record<string, unknown> | undefined;
        const chatId = chat?.id as number | undefined;

        const m = text.trim().match(/^\/start(?:\s+(\S+))?/);
        const startArg = m?.[1];
        if (!chatId || !from) {
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }

        if (!startArg) {
            await sendTelegramMessage(
                botToken,
                chatId,
                'Відкрийте сайт журналу і натисніть <b>Увійти через Telegram</b> — з’явиться кнопка Start з посиланням.',
            );
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }

        const { data: row, error: selErr } = await adminDb
            .from('telegram_login_sessions')
            .select('start_token, return_base, expires_at, claim_token')
            .eq('start_token', startArg)
            .maybeSingle();

        if (selErr || !row) {
            await sendTelegramMessage(botToken, chatId, 'Посилання застаріло. Зайдіть на сайт і натисніть «Увійти через Telegram» ще раз.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }
        if (row.claim_token) {
            const base = new URL(String(row.return_base));
            base.searchParams.set('tg_claim', String(row.claim_token));
            await sendTelegramMessage(botToken, chatId, '✅ Натисніть кнопку, щоб повернутися в журнал:', {
                inline_keyboard: [[{ text: '➡️ Відкрити журнал', url: base.toString() }]],
            });
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }
        if (new Date(String(row.expires_at)).getTime() < Date.now()) {
            await adminDb.from('telegram_login_sessions').delete().eq('start_token', startArg);
            await sendTelegramMessage(botToken, chatId, 'Час посилання вичерпано. Спробуйте знову з сайту.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }

        const tid = String(from.id ?? '').replace(/\D/g, '');
        if (!tid) {
            await sendTelegramMessage(botToken, chatId, 'Не вдалося прочитати акаунт Telegram.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }

        const fn = String(from.first_name || '').trim() || 'Telegram';
        const ln = String(from.last_name || '').trim();
        const un = String((from as { username?: string }).username || '').trim();

        let session: { access_token: string; refresh_token: string };
        try {
            session = await createTelegramAuthSession(
                supabaseUrl,
                serviceRole,
                anonKey,
                botToken,
                tid,
                fn,
                ln,
                un,
            );
        } catch (e) {
            console.error('[telegram-auth] session', e);
            await sendTelegramMessage(
                botToken,
                chatId,
                'Помилка входу: ' + String((e as Error)?.message || e).slice(0, 200),
            );
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }

        const claim = crypto.randomUUID();
        const { error: upErr } = await adminDb
            .from('telegram_login_sessions')
            .update({
                claim_token: claim,
                access_token: session.access_token,
                refresh_token: session.refresh_token,
            })
            .eq('start_token', startArg);

        if (upErr) {
            console.error('[telegram-auth] update claim', upErr);
            await sendTelegramMessage(botToken, chatId, 'Помилка збереження сесії. Спробуйте ще раз.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
            });
        }

        const base = new URL(String(row.return_base));
        base.searchParams.set('tg_claim', claim);
        const finishUrl = base.toString();

        await sendTelegramMessage(botToken, chatId, '✅ Натисніть кнопку, щоб повернутися в журнал:', {
            inline_keyboard: [[{ text: '➡️ Відкрити журнал', url: finishUrl }]],
        });

        return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        });
    }

    const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
    if (!claim || claim.length < 8) {
        return json({ error: 'Expected { "claim": "<uuid from tg_claim>" }' }, 400);
    }

    const { data: row, error: cErr } = await adminDb
        .from('telegram_login_sessions')
        .select('claim_token, access_token, refresh_token, expires_at')
        .eq('claim_token', claim)
        .maybeSingle();

    if (cErr || !row?.access_token || !row?.refresh_token) {
        return json({ error: 'Invalid or expired claim' }, 401);
    }
    if (new Date(String(row.expires_at)).getTime() < Date.now()) {
        await adminDb.from('telegram_login_sessions').delete().eq('claim_token', claim);
        return json({ error: 'Claim expired' }, 401);
    }

    await adminDb.from('telegram_login_sessions').delete().eq('claim_token', claim);

    return json({
        access_token: row.access_token,
        refresh_token: row.refresh_token,
    });
});
