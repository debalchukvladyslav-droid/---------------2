// === js/auth.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';

const PROFILE_SUFFIX = '_stats';

function getNickFromDocName(docName = '') {
    return String(docName).replace(/_stats$/, '');
}

function isMissingRelationError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('relation') && message.includes('does not exist');
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

async function saveProfilePatchByDocName(docName, patch) {
    const nick = getNickFromDocName(docName);
    if (!nick) return;

    const { error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('nick', nick);

    if (error) throw error;
}

async function saveJournalMonth(docName, monthKey, monthData) {
    const nick = getNickFromDocName(docName);
    const { error } = await supabase
        .from('journal_months')
        .upsert(
            [{
                user_doc_name: docName,
                nick,
                month_key: monthKey,
                data: monthData
            }],
            { onConflict: 'user_doc_name,month_key' }
        );

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
    const toggleBtn = document.querySelector('[onclick="window.toggleAuthMode?.()"]');

    document.getElementById('register-fields').style.display = state.isRegisterMode ? 'block' : 'none';

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
    const nick = document.getElementById('auth-nick').value.trim().toLowerCase();
    const pass = document.getElementById('auth-pass').value;

    if (!nick || nick.length < 3) { showError('Введіть коректний логін (мін 3 символи)'); return; }
    if (!pass || pass.length < 6) { showError('Пароль має бути мін. 6 символів'); return; }

    showError('');

    try {
        if (state.isRegisterMode) {
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

            if (profileInsertError) throw profileInsertError;

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

        const profile = await getProfileByNick(nick, 'email');
        const foundEmail = profile?.email;

        if (!foundEmail) {
            showError('Невірний логін або пароль!');
            return;
        }

        const { error: signInError } = await supabase.auth.signInWithPassword({
            email: foundEmail,
            password: pass
        });

        if (signInError) throw signInError;
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
            <div style="color:var(--text-muted,#94a3b8);font-size:0.8rem;cursor:pointer;" onclick="document.getElementById('migration-overlay').remove()">Скасувати</div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById('migration-btn').onclick = () => doMigration(nick, oldEmail, pass);
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
        const profile = await getProfileByNick(nick, 'email');
        const authEmail = profile?.email || null;

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
        return false;
    }

    try {
        const profile = await getProfileByNick(getNickFromDocName(state.USER_DOC_NAME), 'mentor_enabled');
        state.IS_MENTOR_MODE = profile?.mentor_enabled === true;
    } catch (e) {
        console.error('Помилка статусу ментора:', e);
        state.IS_MENTOR_MODE = false;
    }
    return state.IS_MENTOR_MODE;
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

export function applyAccessRights() {
    let hasAccess = (state.CURRENT_VIEWED_USER === state.USER_DOC_NAME) || state.IS_MENTOR_MODE;
    let isLookingAtSomeoneElse = (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME);

    let statusBanner = document.getElementById('status-banner');
    if (!statusBanner) {
        statusBanner = document.createElement('div');
        statusBanner.id = 'status-banner';
        statusBanner.style.cssText = 'position: fixed; top: 10px; right: 10px; padding: 4px 10px; border-radius: 6px; font-size: 0.7rem; font-weight: normal; z-index: 9999; opacity: 0.5; pointer-events: none;';
        document.body.appendChild(statusBanner);
    }

    if (isLookingAtSomeoneElse && !state.IS_MENTOR_MODE) {
        statusBanner.innerHTML = '👁️ Тільки перегляд';
        statusBanner.style.background = 'var(--bg-panel)';
        statusBanner.style.color = 'var(--text-muted)';
        statusBanner.style.border = '1px solid var(--border)';
        statusBanner.style.display = 'block';
    } else if (isLookingAtSomeoneElse && state.IS_MENTOR_MODE) {
        statusBanner.innerHTML = '👑 Наставник';
        statusBanner.style.background = 'var(--gold)';
        statusBanner.style.color = 'black';
        statusBanner.style.border = 'none';
        statusBanner.style.display = 'block';
    } else {
        statusBanner.style.display = 'none';
    }

    document.querySelectorAll('input, textarea, select').forEach(el => {
        const safeIds = ['month-select', 'year-select', 'trade-date', 'stats-filter-year', 'stats-filter-month', 'stats-filter-user'];
        if (!safeIds.includes(el.id) && !el.id.includes('theme-') && !el.id.includes('font-')) {
            el.disabled = !hasAccess;
        }
    });

    let saveBtn = document.querySelector('.sidebar .btn-primary');
    if (saveBtn) saveBtn.style.display = hasAccess ? 'block' : 'none';

    document.querySelectorAll('.delete, .btn-secondary, .btn-ai').forEach(btn => {
        if (!btn.innerText.includes('Вийти') && !btn.innerText.includes('Додати тип')) {
            btn.style.display = hasAccess ? 'inline-block' : 'none';
        }
    });

    let mentorPanel = document.getElementById('mentor-trade-types-panel');
    if (mentorPanel) mentorPanel.style.display = (state.IS_MENTOR_MODE && isLookingAtSomeoneElse) ? 'block' : 'none';
    let btnManage = document.getElementById('btn-manage-teams');
    if (btnManage) btnManage.style.display = state.IS_MENTOR_MODE ? 'block' : 'none';

    if (state.USER_DOC_NAME) {
        if (window.renderTeamSidebar) window.renderTeamSidebar();
        if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    }
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

    showPromptModal('🔑 Введіть секретний ключ доступу:', async (pass) => {
        if (pass === 'mentor2026' || pass === 'prop2026') {
            try {
                await saveMentorStatusForAccount(true);
                showToast('✅ Режим Ментора активовано!');
                applyAccessRights();
                if (window.refreshStatsView) window.refreshStatsView();
            } catch (e) {
                showToast('Помилка збереження статусу: ' + e.message);
            }
        } else if (pass !== '') {
            showToast('❌ Невірний ключ!');
        }
    });
}

export function deactivateMentorMode() {
    if (!state.IS_MENTOR_MODE) return;

    showConfirmModal('Вийти з режиму Ментора для цього акаунта?', async () => {
        await saveMentorStatusForAccount(false);
        state.statsSourceSelection = { type: 'current', key: state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '' };
        state.activeFilters = [];
        showToast('Режим Ментора вимкнено.');
        applyAccessRights();
        if (window.refreshStatsView) window.refreshStatsView();
    });
}

export async function saveMentorComment() {
    if (!state.IS_MENTOR_MODE || state.CURRENT_VIEWED_USER === state.USER_DOC_NAME) return;

    let comment = document.getElementById('mentor-notes').value.trim();
    if (!state.appData.journal[state.selectedDateStr]) {
        state.appData.journal[state.selectedDateStr] = window.getDefaultDayEntry ? window.getDefaultDayEntry() : {};
    }

    state.appData.journal[state.selectedDateStr].mentor_comment = comment;

    let btn = document.getElementById('btn-save-mentor');
    btn.innerText = '⏳ Збереження...';

    try {
        const mk = state.selectedDateStr.slice(0, 7);
        const monthData = {};
        for (const d in state.appData.journal) {
            if (d.slice(0, 7) === mk) monthData[d] = state.appData.journal[d];
        }

        await saveJournalMonth(state.CURRENT_VIEWED_USER, mk, monthData);
        btn.innerText = '✓ Збережено!';
        btn.style.background = 'var(--profit)';
        setTimeout(() => { btn.innerText = '✓ Зберегти коментар'; btn.style.background = '#eab308'; }, 2000);
        if (window.renderView) window.renderView();
    } catch (e) {
        if (isMissingRelationError(e)) {
            showToast('Таблиця journal_months ще не створена в Supabase');
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
    let container = document.getElementById('private-note-container');
    let textarea = document.getElementById('private-user-note');
    if (!container || !textarea) return;
    if (!state.USER_DOC_NAME) return;

    if (state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME && !state.IS_MENTOR_MODE) {
        container.style.display = 'block';
        let targetUser = state.CURRENT_VIEWED_USER.replace('_stats', '');
        let date = state.selectedDateStr;
        try {
            let profile = await getProfileByNick(getNickFromDocName(state.USER_DOC_NAME), 'private_notes');
            textarea.value = profile?.private_notes?.[targetUser]?.[date] || '';
        } catch (e) {
            console.error('loadPrivateNote error:', e);
        } finally {
            container.style.display = 'block';
        }
    } else {
        container.style.display = 'none';
    }
}
