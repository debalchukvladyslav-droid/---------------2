// === js/auth.js ===
import { supabase, TELEGRAM_AUTH_FN, SUPABASE_ANON_KEY, TELEGRAM_LOGIN_RETURN_BASE } from './supabase.js';
import { state } from './state.js';
import { normalizeDayEntry } from './data_utils.js';
import { canAccessMentorReviewQueueState, isMentorViewingOtherJournalState } from './access_control.js';

const PROFILE_SUFFIX = '_stats';
export const ACCOUNT_BLOCKED_MESSAGE = 'Акаунт заблоковано. Зверніться до адміна.';

function getNickFromDocName(docName = '') {
    return String(docName).replace(/_stats$/, '');
}

function isMissingRelationError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('relation') && message.includes('does not exist');
}

function isIgnorableProfileInsertError(error) {
    const message = String(error?.message || '').toLowerCase();
    const details = String(error?.details || '').toLowerCase();
    const code = String(error?.code || '').toLowerCase();

    if (code === '42501' || message.includes('row-level security')) return true;
    return code === '23505' && (details.includes('profiles_pkey') || message.includes('profiles_pkey'));
}

export function isProfileBlocked(profile) {
    const settings = profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
    return settings.account_blocked === true;
}

export async function rejectBlockedProfile(profile) {
    if (!isProfileBlocked(profile)) return false;
    await supabase.auth.signOut().catch(() => {});
    showError(ACCOUNT_BLOCKED_MESSAGE);
    return true;
}

function mapAuthError(error, fallback = 'Помилка') {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();

    if (
        code === 'user_already_exists' ||
        message.includes('already registered') ||
        message.includes('already been registered') ||
        message.includes('email address is already')
    ) {
        return 'Акаунт вже створено!';
    }

    if (message.includes('email not confirmed')) {
        return 'Пошта не підтверджена. Перевірте вашу скриньку та перейдіть за посиланням у листі.';
    }

    if (
        code === 'invalid_credentials' ||
        message.includes('invalid login credentials') ||
        message.includes('invalid email or password') ||
        message.includes('invalid credentials')
    ) {
        return 'Невірний логін або пароль!';
    }

    if (message.includes('password should be at least')) {
        return 'Пароль має бути мін. 6 символів';
    }

    return `${fallback}: ${error?.message || 'Невідома помилка'}`;
}

async function getProfileByNick(nick, columns = 'id, nick, email, first_name, last_name, team, mentor_enabled, private_notes') {
    const { data, error } = await supabase
        .from('profiles')
        .select(columns)
        .eq('nick', nick)
        .maybeSingle();

    if (error) throw error;
    return data;
}

function looksLikeEmail(value) {
    const v = String(value || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isTelegramAuthUser(user) {
    if (!user || typeof user !== 'object') return false;
    if (user.app_metadata?.provider === 'telegram') return true;
    if (user.user_metadata?.telegram_id) return true;
    const ids = user.identities;
    return Array.isArray(ids) && ids.some((i) => i?.provider === 'telegram');
}

/** Нік з акаунта Telegram: @username, інакше латиниця з імені, інакше tg<id>. */
function isTechnicalTelegramNick(nick) {
    return /^tg_?\d+$/i.test(String(nick || '').trim());
}

export function makeTelegramNick(user) {
    const rawUn = String(user.user_metadata?.telegram_username || '').trim().replace(/^@/, '');
    if (rawUn) {
        const slug = rawUn.toLowerCase().replace(/[^a-z0-9_.]/g, '').replace(/\.{2,}/g, '.').slice(0, 32);
        if (slug.length >= 1) return slug;
    }
    const fn = String(user.user_metadata?.first_name || '').trim();
    if (fn) {
        const slug = fn
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9_.]+/g, '_')
            .replace(/\.{2,}/g, '.')
            .replace(/^_+|_+$/g, '')
            .slice(0, 32);
        if (slug.length >= 2) return slug;
    }
    const ident = user.identities?.find((i) => i.provider === 'telegram');
    const metaId = user.user_metadata?.telegram_id ?? user.user_metadata?.telegram_user_id;
    const sub =
        metaId ??
        ident?.identity_data?.sub ??
        ident?.identity_data?.provider_id ??
        user.id;
    const digits = String(sub).replace(/\D/g, '').slice(0, 18);
    const nick = `tg${digits || String(Date.now()).slice(-12)}`;
    return nick.slice(0, 32);
}

/** Якщо профілю ще немає (наприклад перший вхід через Telegram) — створюємо рядок profiles. */
export async function ensureAuthUserProfile(user) {
    if (!user?.id) return null;
    const { data: row, error: selErr } = await supabase.from('profiles').select('id,nick').eq('id', user.id).maybeSingle();
    if (selErr) throw selErr;
    const tg = isTelegramAuthUser(user);
    if (row?.nick && !(tg && isTechnicalTelegramNick(row.nick))) return row;

    if (tg && row?.nick && isTechnicalTelegramNick(row.nick)) {
        try {
            const { data: repaired, error: repairErr } = await supabase.rpc('repair_my_telegram_profile');
            if (repairErr) throw repairErr;
            const repairedRow = Array.isArray(repaired) ? repaired[0] : repaired;
            if (repairedRow?.nick && !isTechnicalTelegramNick(repairedRow.nick)) return repairedRow;

            const { data: again } = await supabase.from('profiles').select('id,nick').eq('id', user.id).maybeSingle();
            if (again?.nick && !isTechnicalTelegramNick(again.nick)) return again;
        } catch (e) {
            console.warn('[auth] repair_my_telegram_profile unavailable:', e);
        }
    }

    const nick = tg
        ? makeTelegramNick(user)
        : String(user.user_metadata?.nick || user.email?.split('@')[0] || `u_${String(user.id).replace(/-/g, '').slice(0, 12)}`)
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, '')
              .slice(0, 32) || `u_${String(user.id).replace(/-/g, '').slice(0, 12)}`;

    let first_name = '';
    let last_name = '';
    if (tg) {
        first_name = String(user.user_metadata?.first_name || '').trim() || 'Telegram';
        last_name = String(user.user_metadata?.last_name || '').trim();
    } else {
        const uname = user.user_metadata?.name || user.user_metadata?.full_name || '';
        const parts = String(uname).trim().split(/\s+/);
        first_name = parts[0] || '';
        last_name = parts.slice(1).join(' ') || '';
    }

    const baseSettings = typeof user.user_metadata === 'object' && user.user_metadata ? { ...user.user_metadata } : {};
    const settings = { ...baseSettings, auth_provider: tg ? 'telegram' : 'email' };

    const insertPayload = {
        id: user.id,
        nick,
        email: user.email || null,
        first_name,
        last_name,
        team: 'Без куща',
        settings,
    };

    const { error: insErr } = await supabase.from('profiles').insert(insertPayload);
    if (insErr && isIgnorableProfileInsertError(insErr)) {
        const { data: again } = await supabase.from('profiles').select('id,nick').eq('id', user.id).maybeSingle();
        if (again?.nick) return again;
    }
    if (insErr && !isIgnorableProfileInsertError(insErr)) {
        if (String(insErr.code) === '23505' && String(insErr.message || '').toLowerCase().includes('nick')) {
            const alt = `${nick.slice(0, 24)}_${String(user.id).replace(/-/g, '').slice(0, 6)}`.slice(0, 32);
            const { error: e2 } = await supabase.from('profiles').insert({ ...insertPayload, nick: alt });
            if (e2 && !isIgnorableProfileInsertError(e2)) throw e2;
            return { id: user.id, nick: alt };
        }
        throw insErr;
    }
    return { id: user.id, nick };
}

/**
 * Після кнопки в Telegram «Відкрити журнал» у URL є ?tg_claim=<uuid>.
 * Викликати один раз перед getSession().
 */
export async function maybeFinishTelegramClaim() {
    const sp = new URLSearchParams(window.location.search);
    const claim = (sp.get('tg_claim') || '').trim();
    if (!claim || claim.length < 8) return false;

    const cleanPath = `${window.location.pathname}${window.location.hash || ''}`;
    try {
        const r = await fetch(TELEGRAM_AUTH_FN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ claim }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
        const { access_token: accessToken, refresh_token: refreshToken } = j;
        if (!accessToken || !refreshToken) throw new Error('Немає токенів сесії');
        const { error: sessErr } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
        });
        if (sessErr) throw sessErr;
        window.history.replaceState({}, '', cleanPath || '/');
        return true;
    } catch (e) {
        console.error('[Telegram claim]', e);
        window.history.replaceState({}, '', cleanPath || '/');
        showError(mapAuthError(e, 'Telegram'));
        return true;
    }
}

/**
 * Edge повертає JSON { tme_url } → перехід у Telegram (Start), далі кнопка в боті → ?tg_claim=… на сайті.
 * Якщо Edge не задеплоєна — 404 від шлюзу; залишаємось на сторінці й показуємо підказку.
 */
function telegramLoginReturnHref() {
    const raw = typeof TELEGRAM_LOGIN_RETURN_BASE === 'string' ? TELEGRAM_LOGIN_RETURN_BASE.trim() : '';
    if (!raw) {
        const returnUrl = new URL(window.location.href);
        returnUrl.search = '';
        returnUrl.hash = '';
        return returnUrl.href;
    }
    try {
        const base = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        const path = window.location.pathname || '/';
        const out = new URL(path, `${base.origin}/`);
        out.hash = '';
        out.search = '';
        return out.href;
    } catch {
        const returnUrl = new URL(window.location.href);
        returnUrl.search = '';
        returnUrl.hash = '';
        return returnUrl.href;
    }
}

export async function signInWithTelegram() {
    try {
        showError('');
        const returnHref = telegramLoginReturnHref();

        const u = new URL(TELEGRAM_AUTH_FN);
        u.searchParams.set('action', 'start_login');
        u.searchParams.set('return_to', returnHref);
        u.searchParams.set('apikey', SUPABASE_ANON_KEY);

        const r = await fetch(u.toString(), { method: 'GET' });
        const raw = await r.text();
        let j = {};
        try {
            j = raw ? JSON.parse(raw) : {};
        } catch {
            j = {};
        }

        if (r.status === 404) {
            const looksLikeGateway =
                !j || typeof j !== 'object' || (Object.keys(j).length === 0 && !raw.trim().startsWith('{'));
            showError(
                looksLikeGateway
                    ? 'Edge Function «telegram-auth» не знайдена (404). Задеплойте: у папці проєкту виконайте `supabase link` і `supabase functions deploy telegram-auth`. У Dashboard → Edge Functions має з’явитися функція з такою назвою.'
                    : String(j.error || 'Не знайдено'),
            );
            return;
        }
        if (!r.ok) {
            showError(String(j.error || j.message || `Помилка ${r.status}`));
            return;
        }
        if (!j.tme_url || typeof j.tme_url !== 'string') {
            showError('Сервер не повернув посилання на Telegram. Перевірте деплой і secret TELEGRAM_BOT_TOKEN.');
            return;
        }
        window.location.assign(j.tme_url);
    } catch (e) {
        showError(mapAuthError(e, 'Telegram'));
    }
}

async function getLoginEmailByNick(nick) {
    try {
        const { data, error } = await supabase.rpc('login_email_for_nick', { target_nick: nick });
        if (error) throw error;
        return data || null;
    } catch (error) {
        console.warn('[auth] login_email_for_nick unavailable, falling back to profiles:', error);
        const profile = await getProfileByNick(nick, 'email');
        return profile?.email || null;
    }
}

async function saveProfilePatchByDocName(docName, patch) {
    const nick = getNickFromDocName(docName);
    if (!nick) return;

    const { error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('nick', nick);

    if (error) throw error;
}

function dayEntryToJournalRow(userId, tradeDate, entry) {
    const day = normalizeDayEntry(entry);
    return {
        user_id: userId,
        trade_date: tradeDate,
        pnl: day.pnl,
        gross_pnl: day.gross_pnl,
        commissions: day.commissions,
        locates: day.locates,
        kf: day.kf,
        notes: day.notes || '',
        mentor_comment: typeof day.mentor_comment === 'string' ? day.mentor_comment : '',
        ai_advice: typeof day.ai_advice === 'string' ? day.ai_advice : '',
        daily_metrics: {
            errors: Array.isArray(day.errors) ? day.errors : [],
            checkedParams: Array.isArray(day.checkedParams) ? day.checkedParams : [],
            sliders: day.sliders && typeof day.sliders === 'object' ? day.sliders : {},
            tradeTypesData: day.tradeTypesData && typeof day.tradeTypesData === 'object' ? day.tradeTypesData : {},
            screenshots: day.screenshots && typeof day.screenshots === 'object'
                ? day.screenshots
                : { good: [], normal: [], bad: [], error: [] },
            tickers: day.tickers && typeof day.tickers === 'object' ? day.tickers : {},
            traded_tickers: Array.isArray(day.traded_tickers) ? day.traded_tickers : [],
            fondexx: day.fondexx && typeof day.fondexx === 'object'
                ? day.fondexx
                : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            ppro: day.ppro && typeof day.ppro === 'object'
                ? day.ppro
                : { gross: 0, net: 0, comm: 0, locates: 0, tickers: [] },
            sessionGoal: day.sessionGoal ?? '',
            sessionPlan: day.sessionPlan ?? '',
            sessionReadiness: day.sessionReadiness ?? null,
            sessionSetups: Array.isArray(day.sessionSetups) ? day.sessionSetups : [],
            sessionAiResult: day.sessionAiResult ?? '',
            sessionDone: day.sessionDone ?? false,
            trades: Array.isArray(day.trades) ? day.trades : [],
            review_requests: day.review_requests && typeof day.review_requests === 'object' ? day.review_requests : {},
        }
    };
}

async function saveJournalDay(docName, tradeDate, entry) {
    const profile = await getProfileByNick(getNickFromDocName(docName), 'id');
    if (!profile?.id) throw new Error('Target Supabase profile not found');

    const { error } = await supabase
        .from('journal_days')
        .upsert(dayEntryToJournalRow(profile.id, tradeDate, entry), { onConflict: 'user_id,trade_date' });

    if (error) throw error;
}

function syncTeamGroupState(selectedTeam, displayFullName) {
    if (!state.TEAM_GROUPS[selectedTeam]) state.TEAM_GROUPS[selectedTeam] = [];
    if (!state.TEAM_GROUPS[selectedTeam].includes(displayFullName)) {
        state.TEAM_GROUPS[selectedTeam].push(displayFullName);
    }
}

export function toggleAuthMode() {
    state.isRegisterMode = !state.isRegisterMode;
    const submitBtn = document.getElementById('btn-submit');
    const switchText = document.getElementById('auth-switch-text');
    const subtitle = document.getElementById('auth-subtitle');
    const toggleBtn = document.getElementById('auth-mode-toggle') || document.querySelector('[data-action="auth-toggle-mode"]');

    document.getElementById('register-fields').style.display = state.isRegisterMode ? 'block' : 'none';
    const tgBtn = document.getElementById('btn-auth-telegram');
    if (tgBtn) tgBtn.style.display = state.isRegisterMode ? 'none' : '';

    if (state.isRegisterMode) {
        submitBtn.innerText = 'Зареєструватись';
        subtitle.innerText = 'Створення нового акаунта';
        switchText.innerText = 'Вже є акаунт?';
        toggleBtn.innerText = 'Увійти';
    } else {
        submitBtn.innerText = 'Увійти';
        subtitle.innerText = 'Вхід у систему';
        switchText.innerText = 'Ще немає акаунта?';
        toggleBtn.innerText = 'Створити';
    }
    showError('');
}

export async function handleAuth() {
    const rawLogin = document.getElementById('auth-nick').value.trim();
    const loginValue = rawLogin.toLowerCase();
    const pass = document.getElementById('auth-pass').value;
    const isEmailLogin = looksLikeEmail(rawLogin);

    if (!rawLogin) {
        showError('Введіть нікнейм або пошту');
        return;
    }
    if (!isEmailLogin && loginValue.length < 3) {
        showError('Введіть коректний логін або пошту');
        return;
    }
    if (!pass || pass.length < 6) { showError('Пароль має бути мін. 6 символів'); return; }

    showError('');

    try {
        if (state.isRegisterMode) {
            const nick = loginValue;
            const realEmail = document.getElementById('auth-email').value.trim().toLowerCase();
            const fname = document.getElementById('auth-fname').value.trim();
            const lname = document.getElementById('auth-lname').value.trim();
            const selectedTeam = document.getElementById('auth-team').value;

            if (!realEmail.includes('@')) { showError('Введіть коректну реальну пошту'); return; }
            if (!fname || !lname) { showError("Введіть Ім'я та Прізвище"); return; }
            if (!selectedTeam) { showError('Оберіть свій кущ!'); return; }

            const { data: authData, error: signUpError } = await supabase.auth.signUp({
                email: realEmail,
                password: pass,
                options: {
                    data: {
                        nick,
                        display_name: nick,
                        first_name: fname,
                        last_name: lname,
                        team: selectedTeam
                    }
                }
            });

            if (signUpError) throw signUpError;

            const userId = authData?.user?.id;
            if (!userId) {
                throw new Error('Не вдалося отримати ID користувача після реєстрації');
            }

            const { error: profileInsertError } = await supabase.from('profiles').insert([{
                id: userId,
                nick,
                email: realEmail,
                first_name: fname,
                last_name: lname,
                team: selectedTeam
            }]);

            if (profileInsertError && isIgnorableProfileInsertError(profileInsertError)) {
                console.warn('[auth] profile insert skipped; database trigger may have created it:', profileInsertError);
            } else if (profileInsertError) {
                throw profileInsertError;
            }

            syncTeamGroupState(selectedTeam, `${lname} ${fname} (${nick})`);

            if (authData.user && authData.session === null) {
                const card = document.querySelector('.auth-card');
                if (card) {
                    card.innerHTML = `<p style="color:var(--text-main,#f8fafc);font-size:1rem;line-height:1.6;">✅ Реєстрація успішна! Ми відправили посилання для підтвердження на вашу пошту. Будь ласка, перейдіть за ним, щоб активувати акаунт.</p>`;
                }
            } else {
                showError('✅ Акаунт створено!');
            }
            return;
        }

        const foundEmail = isEmailLogin ? rawLogin.trim().toLowerCase() : await getLoginEmailByNick(loginValue);

        if (!foundEmail) {
            showError('Невірний логін або пароль!');
            return;
        }

        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
            email: foundEmail,
            password: pass
        });

        if (signInError) throw signInError;
        if (signInData?.user?.id) {
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('settings')
                .eq('id', signInData.user.id)
                .maybeSingle();
            if (profileError) throw profileError;
            await rejectBlockedProfile(profile);
        }
    } catch (e) {
        showError(mapAuthError(e, 'Помилка'));
    }
}

// ===== МІГРАЦІЯ СТАРОГО АКАУНТУ =====
export function showMigrationForm(nick, oldEmail, pass) {
    const overlay = document.createElement('div');
    overlay.id = 'migration-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:999999;';

    overlay.innerHTML = `
        <div style="background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:28px;max-width:360px;width:90%;text-align:center;">
            <h3 style="color:var(--accent,#3b82f6);margin:0 0 10px;">📧 Прив'язка Gmail</h3>
            <p style="color:var(--text-muted,#94a3b8);font-size:0.88rem;margin:0 0 18px;">Введіть вашу реальну Gmail-адресу. Акаунт буде перенесено на неї.</p>
            <input type="email" id="migration-email" placeholder="your@gmail.com" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--border,#334155);background:var(--bg-main,#0f172a);color:var(--text-main,#f8fafc);font-size:0.95rem;margin-bottom:10px;">
            <div id="migration-error" style="color:#ef4444;font-size:0.82rem;margin-bottom:10px;display:none;"></div>
            <button id="migration-btn" style="width:100%;padding:10px;border-radius:8px;border:none;background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:0.95rem;margin-bottom:8px;">✅ Прив'язати та увійти</button>
            <button type="button" id="migration-cancel" style="color:var(--text-muted,#94a3b8);font-size:0.8rem;cursor:pointer;background:transparent;border:none;padding:0;">Скасувати</button>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById('migration-btn').onclick = () => doMigration(nick, oldEmail, pass);
    document.getElementById('migration-cancel')?.addEventListener('click', () => overlay.remove());
    document.getElementById('migration-email').addEventListener('keydown', e => { if (e.key === 'Enter') doMigration(nick, oldEmail, pass); });
    document.getElementById('migration-email').focus();
}

async function doMigration(nick, oldEmail, pass) {
    const newEmail = document.getElementById('migration-email').value.trim().toLowerCase();
    const errEl = document.getElementById('migration-error');
    const btn = document.getElementById('migration-btn');

    if (!newEmail.endsWith('@gmail.com')) {
        errEl.textContent = 'Введіть адресу @gmail.com';
        errEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Мігруємо...';
    errEl.style.display = 'none';

    try {
        const { error: signInError } = await supabase.auth.signInWithPassword({
            email: oldEmail,
            password: pass
        });
        if (signInError) throw signInError;

        const { error: updateUserError } = await supabase.auth.updateUser({
            email: newEmail,
            data: { nick, display_name: nick }
        });
        if (updateUserError) throw updateUserError;

        const { error: updateProfileError } = await supabase
            .from('profiles')
            .update({ email: newEmail })
            .eq('nick', nick);

        if (updateProfileError) throw updateProfileError;

        document.getElementById('migration-overlay').remove();
        console.log(`✅ Міграція ${nick}: ${oldEmail} → ${newEmail}`);
    } catch (e) {
        btn.disabled = false;
        btn.textContent = "✅ Прив'язати та увійти";
        if (mapAuthError(e, 'Помилка') === 'Невірний логін або пароль!') errEl.textContent = 'Невірний пароль';
        else if (mapAuthError(e, 'Помилка') === 'Акаунт вже створено!') errEl.textContent = 'Ця Gmail вже зайнята іншим акаунтом';
        else errEl.textContent = 'Помилка: ' + (e?.message || 'Невідома помилка');
        errEl.style.display = 'block';
    }
}

// ===== ВІДНОВЛЕННЯ ПАРОЛЮ =====
const EMAILJS_SERVICE_ID = 'service_v8qsgvk';
const EMAILJS_TEMPLATE_ID = 'template_lwz2iyr';
const EMAILJS_PUBLIC_KEY = 'hyAD4pbm0LYmD1xAG';

let resetNick = '';
let resetCodeStore = { code: '', expiresAt: 0 };

export function showResetStep(step) {
    document.getElementById('reset-step-1').style.display = step === 1 ? 'block' : 'none';
    document.getElementById('reset-step-2').style.display = step === 2 ? 'block' : 'none';
    document.getElementById('reset-step-3').style.display = step === 3 ? 'block' : 'none';
    document.getElementById('forgot-link').style.display = step === 0 ? 'block' : 'none';
    document.getElementById('btn-submit').style.display = step === 0 ? 'block' : 'none';
    document.getElementById('auth-switch-text').parentElement.style.display = step === 0 ? 'block' : 'none';
    document.getElementById('auth-nick').style.display = step === 0 ? 'block' : 'none';
    document.getElementById('auth-pass').style.display = step === 0 ? 'block' : 'none';
    const tgBtn = document.getElementById('btn-auth-telegram');
    if (tgBtn) tgBtn.style.display = step === 0 && !state.isRegisterMode ? '' : 'none';
    if (step === 1) {
        const nickInput = document.getElementById('reset-nick');
        if (nickInput) nickInput.focus();
    }
}

export async function sendResetCode() {
    const nick = (document.getElementById('reset-nick')?.value || '').trim().toLowerCase();
    const emailInput = (document.getElementById('reset-email')?.value || '').trim().toLowerCase();
    if (!nick) { showResetError(1, 'Введіть нікнейм'); return; }
    if (!emailInput) { showResetError(1, 'Введіть пошту'); return; }

    const btn = document.querySelector('#reset-step-1 .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Надсилаємо...'; }

    try {
        const authEmail = await getLoginEmailByNick(nick);

        if (!authEmail) { showResetError(1, 'Нікнейм не знайдено'); return; }
        if (authEmail.toLowerCase() !== emailInput) { showResetError(1, 'Пошта не збігається з акаунтом'); return; }

        const { error } = await supabase.auth.resetPasswordForEmail(authEmail);
        if (error) throw error;

        showResetStep(0);
        showError('✅ Лист для скидання паролю надіслано на вашу пошту!');
    } catch (e) {
        showResetError(1, 'Помилка: ' + (e?.message || 'Невідома помилка'));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📨 Надіслати лист'; }
    }
}

export async function verifyResetCode() {}
export async function applyNewPassword() {}

function showResetError(step, text) {
    const el = document.getElementById(`reset-error${step > 1 ? '-' + step : ''}`);
    if (el) { el.innerText = text; el.style.display = text ? 'block' : 'none'; }
}

export async function resetPassword() {
    // legacy — не використовується
}

export function showError(text) {
    const el = document.getElementById('auth-error');
    if (el) { el.innerText = text; el.style.display = text ? 'block' : 'none'; }
}

export async function logout() {
    try {
        await supabase.auth.signOut();
    } catch (e) {
        console.error('Помилка signOut:', e);
    } finally {
        // Очищаємо state незалежно від результату signOut
        location.href = location.pathname;
    }
}

export async function loadMentorStatusForAccount() {
    if (!state.USER_DOC_NAME) {
        state.IS_MENTOR_MODE = false;
        state.myRole = 'trader';
        return false;
    }

    try {
        const profile = await getProfileByNick(getNickFromDocName(state.USER_DOC_NAME), 'mentor_enabled, role');
        state.myRole = profile?.role || 'trader';
        state.IS_MENTOR_MODE = !!(profile?.mentor_enabled || profile?.role === 'mentor');
    } catch (e) {
        console.error('Помилка статусу ментора:', e);
        state.IS_MENTOR_MODE = false;
        state.myRole = 'trader';
    }
    return state.IS_MENTOR_MODE;
}

/** Ментор, адмін або mentor_enabled — доступ до черги рев’ю та перегляду команди. */
export function canAccessMentorReviewQueue() {
    return canAccessMentorReviewQueueState({
        myRole: state.myRole,
        isMentorMode: state.IS_MENTOR_MODE,
    });
}

export async function saveMentorStatusForAccount(enabled) {
    if (!state.USER_DOC_NAME) return;
    try {
        await saveProfilePatchByDocName(state.USER_DOC_NAME, { mentor_enabled: enabled });
        state.IS_MENTOR_MODE = enabled;
    } catch (e) {
        console.error('Помилка збереження статусу ментора:', e);
        throw e;
    }
}

export function updateMentorButtons() {
    let mentorOnBtn = document.getElementById('btn-mentor-on');
    let mentorOffBtn = document.getElementById('btn-mentor-off');
    if (!mentorOnBtn || !mentorOffBtn) return;

    mentorOnBtn.style.display = state.IS_MENTOR_MODE ? 'none' : 'block';
    mentorOffBtn.style.display = state.IS_MENTOR_MODE ? 'block' : 'none';
}

/** Ментор переглядає журнал іншого трейдера — лише коментар ментора / приватні нотатки, без редагування дня. */
export function isMentorViewingOtherJournal() {
    return isMentorViewingOtherJournalState({
        myRole: state.myRole,
        isMentorMode: state.IS_MENTOR_MODE,
        userDocName: state.USER_DOC_NAME,
        currentViewedUser: state.CURRENT_VIEWED_USER,
    });
}

export function applyAccessRights() {
    const isSelf = state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
    const isLookingAtSomeoneElse = !isSelf;
    const mentorViewOnly = isMentorViewingOtherJournal();
    const privilegedAccess = state.IS_MENTOR_MODE || state.myRole === 'admin';
    const hasAccess = isSelf || privilegedAccess;

    let statusBanner = document.getElementById('status-banner');
    if (!statusBanner) {
        statusBanner = document.createElement('div');
        statusBanner.id = 'status-banner';
        statusBanner.style.cssText = 'position: fixed; top: 10px; right: 10px; padding: 4px 10px; border-radius: 6px; font-size: 0.7rem; font-weight: normal; z-index: 9999; opacity: 0.5; pointer-events: none;';
        document.body.appendChild(statusBanner);
    }

    if (isLookingAtSomeoneElse && !privilegedAccess) {
        statusBanner.innerHTML = '👁️ Тільки перегляд';
        statusBanner.style.background = 'var(--bg-panel)';
        statusBanner.style.color = 'var(--text-muted)';
        statusBanner.style.border = '1px solid var(--border)';
        statusBanner.style.display = 'block';
    } else if (isLookingAtSomeoneElse && privilegedAccess) {
        statusBanner.innerHTML = '👑 Наставник';
        statusBanner.style.background = 'var(--gold)';
        statusBanner.style.color = 'black';
        statusBanner.style.border = 'none';
        statusBanner.style.display = 'block';
    } else {
        statusBanner.style.display = 'none';
    }

    document.querySelectorAll('input, textarea, select').forEach((el) => {
        const safeIds = [
            'trade-date', 'stats-filter-year', 'stats-filter-month', 'stats-filter-user',
            'sidebar-pf-fname', 'sidebar-pf-lname', 'sidebar-pf-avatar-url',
            'mr-days', 'mr-loss-threshold', 'cal-view-month', 'cal-view-year',
            'mr-f-need-mentor', 'mr-f-big-loss', 'mr-f-errors', 'mr-f-no-screens', 'mr-f-no-session', 'mr-f-notes-request', 'mr-f-ai-hint', 'mr-f-incomplete', 'mr-f-no-note', 'mr-f-loss-streak',
            'rr-btn-screens-general', 'rr-btn-calendar-profit',
        ];
        if (safeIds.includes(el.id) || el.id.includes('theme-') || el.id.includes('font-')) return;
        if (mentorViewOnly && el.closest('#form-sidebar')) {
            const mentorEditable = ['trade-date', 'mentor-notes', 'private-user-note'];
            el.disabled = !mentorEditable.includes(el.id);
            return;
        }
        el.disabled = !hasAccess;
    });

    const saveDayBtn = document.getElementById('btn-save-day');
    if (saveDayBtn) saveDayBtn.style.display = !hasAccess || mentorViewOnly ? 'none' : 'flex';

    const mentorSaveBtn = document.getElementById('btn-save-mentor');
    if (mentorSaveBtn) mentorSaveBtn.style.display = mentorViewOnly ? 'inline-flex' : 'none';

    document.querySelectorAll('.delete, .btn-secondary, .btn-ai').forEach((btn) => {
        if (btn.classList.contains('rr-exempt-access')) return;
        const t = btn.innerText || '';
        if (t.includes('Вийти') || t.includes('Додати тип')) return;
        if (mentorViewOnly && btn.closest('#form-sidebar')) {
            btn.style.display = 'none';
            return;
        }
        btn.style.display = hasAccess ? 'inline-block' : 'none';
    });

    let mentorPanel = document.getElementById('mentor-trade-types-panel');
    if (mentorPanel) mentorPanel.style.display = (privilegedAccess && isLookingAtSomeoneElse) ? 'block' : 'none';
    const btnAdminTeam = document.getElementById('btn-admin-team-manager');
    const showTeamAdmin = state.myRole === 'admin' || state.IS_MENTOR_MODE;
    if (btnAdminTeam) btnAdminTeam.style.display = showTeamAdmin ? 'inline-flex' : 'none';

    const hideSettingsForOtherProfile = isLookingAtSomeoneElse;
    document.querySelectorAll('[data-tab="settings"]').forEach((tab) => {
        tab.style.display = hideSettingsForOtherProfile ? 'none' : '';
    });
    const settingsView = document.getElementById('view-settings');
    if (settingsView) {
        settingsView.toggleAttribute('aria-disabled', hideSettingsForOtherProfile);
        if (hideSettingsForOtherProfile && settingsView.classList.contains('active') && window.switchMainTab) {
            window.switchMainTab('calendar');
        }
    }
    const importExportGrid = document.querySelector('.import-export-grid');
    if (importExportGrid) importExportGrid.style.display = isSelf ? '' : 'none';

    if (state.USER_DOC_NAME) {
        if (window.renderTeamSidebar) window.renderTeamSidebar();
        if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    }

    const adminNav = document.querySelector('.admin-nav-item');
    const adminMobile = document.querySelector('.admin-tab-mobile');
    const showAdminTab = state.myRole === 'admin' || state.IS_MENTOR_MODE;
    if (adminNav) adminNav.classList.toggle('initially-hidden', !showAdminTab);
    if (adminMobile) adminMobile.classList.toggle('initially-hidden', !showAdminTab);

    updateMentorButtons();
}

function showToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);color:var(--text-main,#f8fafc);padding:10px 22px;border-radius:10px;font-size:0.95rem;z-index:99999;pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function showPromptModal(labelText, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:24px 28px;max-width:320px;width:90%;';

    const label = document.createElement('p');
    label.style.cssText = 'margin:0 0 12px;color:var(--text-main,#f8fafc);font-size:1rem;';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'password';
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#334155);background:var(--bg,#0f172a);color:var(--text-main,#f8fafc);font-size:0.95rem;margin-bottom:16px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;';

    const btnOk = document.createElement('button');
    btnOk.textContent = 'OK';
    btnOk.style.cssText = 'padding:8px 22px;border-radius:8px;border:none;background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:0.95rem;';
    btnOk.onclick = () => { overlay.remove(); onConfirm(input.value); };

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Скасувати';
    btnCancel.style.cssText = 'padding:8px 22px;border-radius:8px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-main,#f8fafc);cursor:pointer;font-size:0.95rem;';
    btnCancel.onclick = () => overlay.remove();

    input.addEventListener('keydown', e => { if (e.key === 'Enter') btnOk.click(); if (e.key === 'Escape') overlay.remove(); });

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    input.focus();
}

function showConfirmModal(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:24px 28px;max-width:320px;width:90%;text-align:center;';

    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 20px;color:var(--text-main,#f8fafc);font-size:1rem;';
    msg.textContent = message;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';

    const btnYes = document.createElement('button');
    btnYes.textContent = 'Так';
    btnYes.style.cssText = 'padding:8px 22px;border-radius:8px;border:none;background:var(--loss,#ef4444);color:#fff;cursor:pointer;font-size:0.95rem;';
    btnYes.onclick = () => { overlay.remove(); onConfirm(); };

    const btnNo = document.createElement('button');
    btnNo.textContent = 'Скасувати';
    btnNo.style.cssText = 'padding:8px 22px;border-radius:8px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-main,#f8fafc);cursor:pointer;font-size:0.95rem;';
    btnNo.onclick = () => overlay.remove();

    btnRow.appendChild(btnYes);
    btnRow.appendChild(btnNo);
    box.appendChild(msg);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

export function activateMentorMode() {
    if (state.IS_MENTOR_MODE) { showToast('Режим Ментора вже активовано!'); return; }
    showToast('Доступ ментора видає адмін у профілі. Паролі на фронті вимкнено для безпеки.');
}

export function deactivateMentorMode() {
    if (!state.IS_MENTOR_MODE) return;

    showConfirmModal('Вийти з режиму Ментора для цього акаунта?', async () => {
        showToast('Статус ментора змінює тільки адмін.');
        state.statsSourceSelection = { type: 'current', key: state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '' };
        state.activeFilters = [];
        applyAccessRights();
        if (window.refreshStatsView) window.refreshStatsView();
    });
}

export async function mentorAcceptReviewRequest(dateStr, kind, screenPath) {
    if (!isMentorViewingOtherJournal()) {
        showToast('Прийняття запиту доступне лише ментору в журналі трейдера');
        return;
    }
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
    const raw = state.appData.journal[dateStr] || {};
    const day = normalizeDayEntry(raw);
    if (!day.review_requests || typeof day.review_requests !== 'object') day.review_requests = {};
    const rr = day.review_requests;
    const myId = state.myUserId;

    const acceptSlot = (slot) => {
        if (!slot || slot.status !== 'pending' || slot.mentor_user_id !== myId) return false;
        slot.status = 'accepted';
        slot.accepted_at = new Date().toISOString();
        slot.accepted_by = getNickFromDocName(state.USER_DOC_NAME);
        return true;
    };

    let ok = false;
    if (kind === 'screen_item' && screenPath) {
        rr.by_screen = rr.by_screen || {};
        ok = acceptSlot(rr.by_screen[screenPath]);
    } else {
        ok = acceptSlot(rr[kind]);
    }
    if (!ok) {
        showToast('Немає активного запиту на вас за цей пункт');
        return;
    }
    state.appData.journal[dateStr] = day;
    try {
        await saveJournalDay(state.CURRENT_VIEWED_USER, dateStr, day);
        showToast('Запит прийнято');
        if (window.refreshReviewRequestButtons) window.refreshReviewRequestButtons();
        if (window.renderAssignedScreens) void window.renderAssignedScreens();
        if (window.renderView) window.renderView();
    } catch (e) {
        console.error(e);
        showToast('Помилка збереження: ' + (e?.message || e));
    }
}

export async function saveMentorComment() {
    if (!(state.IS_MENTOR_MODE || state.myRole === 'admin') || state.CURRENT_VIEWED_USER === state.USER_DOC_NAME) return;

    let comment = document.getElementById('mentor-notes').value.trim();
    if (!state.appData.journal[state.selectedDateStr]) {
        state.appData.journal[state.selectedDateStr] = window.getDefaultDayEntry ? window.getDefaultDayEntry() : {};
    }

    state.appData.journal[state.selectedDateStr].mentor_comment = comment;

    let btn = document.getElementById('btn-save-mentor');
    btn.innerText = '⏳ Збереження...';

    try {
        await saveJournalDay(
            state.CURRENT_VIEWED_USER,
            state.selectedDateStr,
            state.appData.journal[state.selectedDateStr]
        );
        btn.innerText = '✓ Збережено!';
        btn.style.background = 'var(--profit)';
        setTimeout(() => { btn.innerText = '✓ Зберегти коментар'; btn.style.background = '#eab308'; }, 2000);
        if (window.renderView) window.renderView();
    } catch (e) {
        if (isMissingRelationError(e)) {
            showToast('Таблиця journal_days ще не створена в Supabase');
        } else {
            showToast('Помилка збереження: ' + e.message);
        }
        btn.innerText = '❌ Помилка';
    }
}

export async function savePrivateNote() {
    try {
        let noteText = document.getElementById('private-user-note').value;
        let targetUser = state.CURRENT_VIEWED_USER.replace('_stats', '');
        let date = state.selectedDateStr;

        let profile = await getProfileByNick(getNickFromDocName(state.USER_DOC_NAME), 'private_notes');
        let privateNotes = profile?.private_notes || {};

        if (!privateNotes[targetUser]) privateNotes[targetUser] = {};
        privateNotes[targetUser][date] = noteText;

        await saveProfilePatchByDocName(state.USER_DOC_NAME, { private_notes: privateNotes });
        showToast('🔒 Приватну нотатку успішно збережено у ваш профіль!');
    } catch (e) {
        console.error('savePrivateNote error:', e);
        showToast('Помилка збереження приватної нотатки: ' + (e?.message || 'Невідома помилка'));
    }
}

export async function loadPrivateNote() {
    const container = document.getElementById('private-note-container');
    const textarea = document.getElementById('private-user-note');
    if (!container || !textarea) return;
    if (!state.USER_DOC_NAME) return;

    const viewingOther = state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME;
    const plainViewOnly = viewingOther && !state.IS_MENTOR_MODE;

    async function fillFromMyPrivateNotes() {
        const targetUser = state.CURRENT_VIEWED_USER.replace('_stats', '');
        const date = state.selectedDateStr;
        try {
            const profile = await getProfileByNick(getNickFromDocName(state.USER_DOC_NAME), 'private_notes');
            textarea.value = profile?.private_notes?.[targetUser]?.[date] || '';
        } catch (e) {
            console.error('loadPrivateNote error:', e);
        }
    }

    if (plainViewOnly) {
        container.style.display = 'block';
        await fillFromMyPrivateNotes();
        return;
    }
    if (isMentorViewingOtherJournal()) {
        container.style.display = 'block';
        await fillFromMyPrivateNotes();
        return;
    }
    container.style.display = 'none';
}
