// === js/admin.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { loadTeams } from './teams.js';
import { exportProfileData, resetProfileData } from './storage.js';

const ROLES = ['trader', 'mentor', 'admin'];
const DEFAULT_TEAM = 'Без куща';

export async function renderAdminPanel() {
    const container = document.getElementById('admin-users-list');
    if (!container) return;

    const refreshUsersBtn = document.getElementById('admin-refresh-users-btn');
    const fullAdmin = state.myRole === 'admin';
    const dataManager = fullAdmin || state.IS_MENTOR_MODE;
    if (!dataManager) {
        if (refreshUsersBtn) refreshUsersBtn.style.display = 'none';
        container.innerHTML =
            '<p class="admin-empty">Повний список профілів і зміна ролей доступні лише адміністратору. Для кущів використайте блок вище або «Команда» в шапці.</p>';
        return;
    }
    if (refreshUsersBtn) refreshUsersBtn.style.display = '';

    container.innerHTML = '<p class="admin-loading">Завантаження…</p>';

    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, nick, email, first_name, last_name, team, role, mentor_enabled, settings')
        .order('nick', { ascending: true });

    if (error) {
        container.innerHTML = `<p class="admin-error">Помилка: ${escapeHtml(error.message)}</p>`;
        return;
    }

    if (!profiles?.length) {
        container.innerHTML = '<p class="admin-empty">Користувачів не знайдено.</p>';
        return;
    }

    const visibleProfiles = fullAdmin
        ? profiles
        : (profiles || []).filter((p) => p.id !== state.myUserId && p.role !== 'admin' && p.role !== 'mentor' && !p.mentor_enabled);

    if (!visibleProfiles.length) {
        container.innerHTML = '<p class="admin-empty">Трейдерів для переміщення не знайдено.</p>';
        return;
    }

    const teamChoices = teamListForSelect();

    container.innerHTML = '';
    visibleProfiles.forEach((p) => container.appendChild(buildUserCard(p, teamChoices, { fullAdmin, dataManager })));
}

function teamListForSelect() {
    const keys = Object.keys(state.TEAM_GROUPS || {}).sort((a, b) => a.localeCompare(b, 'uk'));
    if (!keys.includes(DEFAULT_TEAM)) keys.unshift(DEFAULT_TEAM);
    return [...new Set(keys)];
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function profileSettings(profile) {
    return profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
}

function isProfileBlocked(profile) {
    return profileSettings(profile).account_blocked === true;
}

function buildUserCard(profile, teamChoices, options = {}) {
    const { fullAdmin = false, dataManager = false } = options;
    const card = document.createElement('div');
    card.className = 'admin-user-card';
    card.dataset.userId = profile.id;

    const head = document.createElement('div');
    head.className = 'admin-user-head';
    const blocked = isProfileBlocked(profile);
    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || '—';
    head.innerHTML = `
        <div class="admin-user-title">
            <span>${escapeHtml(profile.nick || '—')}</span>
            ${blocked ? '<span class="admin-user-status admin-user-status--blocked">Заблоковано</span>' : ''}
        </div>
        <div class="admin-user-meta">${escapeHtml(fullName)} · ${escapeHtml(profile.email || '—')}</div>
    `;

    const grid = document.createElement('div');
    grid.className = 'admin-user-grid';

    // Роль
    const roleWrap = document.createElement('div');
    roleWrap.className = 'admin-field';
    roleWrap.innerHTML = '<label class="admin-label">Роль</label>';
    const roleSelect = document.createElement('select');
    roleSelect.className = 'admin-select';
    ROLES.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r === 'trader' ? 'Трейдер' : r === 'mentor' ? 'Ментор' : 'Адмін';
        opt.selected = (profile.role || 'trader') === r;
        roleSelect.appendChild(opt);
    });
    roleSelect.dataset.prevRole = profile.role || 'trader';
    roleSelect.addEventListener('change', () =>
        updateUserRole(profile.id, roleSelect.value, roleSelect)
    );
    roleWrap.appendChild(roleSelect);

    // Ментор у кущі (прапорець)
    const mentorWrap = document.createElement('div');
    mentorWrap.className = 'admin-field';
    mentorWrap.innerHTML = '<label class="admin-label">У команді як ментор</label>';
    const mentorRow = document.createElement('div');
    mentorRow.className = 'admin-checkbox-row';
    const mentorCb = document.createElement('input');
    mentorCb.type = 'checkbox';
    mentorCb.id = `admin-mentor-${profile.id}`;
    mentorCb.checked = !!(profile.mentor_enabled || profile.role === 'mentor');
    mentorCb.addEventListener('change', () =>
        updateMentorFlag(profile.id, mentorCb.checked, profile.role, mentorCb)
    );
    const mentorLbl = document.createElement('label');
    mentorLbl.htmlFor = mentorCb.id;
    mentorLbl.textContent = 'Показувати першим у кущі, доступ до коментарів ментора';
    mentorRow.appendChild(mentorCb);
    mentorRow.appendChild(mentorLbl);
    mentorWrap.appendChild(mentorRow);

    // Кущ
    const teamWrap = document.createElement('div');
    teamWrap.className = 'admin-field';
    teamWrap.innerHTML = '<label class="admin-label">Кущ</label>';
    const teamSel = document.createElement('select');
    teamSel.className = 'admin-select';
    teamChoices.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        const cur = profile.team || DEFAULT_TEAM;
        opt.selected = t === cur;
        teamSel.appendChild(opt);
    });
    const teamBtn = document.createElement('button');
    teamBtn.type = 'button';
    teamBtn.className = 'btn-admin-action';
    teamBtn.textContent = 'Застосувати кущ';
    teamBtn.addEventListener('click', () =>
        adminUpdateTeam(profile.id, profile.nick, teamSel.value, card)
    );
    teamWrap.appendChild(teamSel);
    teamWrap.appendChild(teamBtn);

    // Перейменування ніка
    const nickWrap = document.createElement('div');
    nickWrap.className = 'admin-field admin-field-wide';
    nickWrap.innerHTML = '<label class="admin-label">Новий нік (логін)</label>';
    const nickInput = document.createElement('input');
    nickInput.type = 'text';
    nickInput.className = 'admin-input';
    nickInput.value = profile.nick || '';
    nickInput.placeholder = 'латиниця, мін. 3 символи';
    const nickBtn = document.createElement('button');
    nickBtn.type = 'button';
    nickBtn.className = 'btn-admin-action';
    nickBtn.textContent = 'Зберегти нік';
    nickBtn.addEventListener('click', () =>
        adminUpdateNick(profile.id, profile.nick, nickInput.value.trim().toLowerCase(), card)
    );
    nickWrap.appendChild(nickInput);
    nickWrap.appendChild(nickBtn);

    if (fullAdmin) {
        grid.appendChild(roleWrap);
        grid.appendChild(mentorWrap);
        grid.appendChild(nickWrap);
    }
    if (dataManager) {
        grid.appendChild(teamWrap);
    }

    const actions = document.createElement('div');
    actions.className = 'admin-user-actions';
    if (dataManager) {
        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'btn-admin-action';
        exportBtn.textContent = 'Експорт';
        exportBtn.addEventListener('click', () => adminExportProfile(profile.id, profile.nick, card));
        actions.appendChild(exportBtn);

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'btn-admin-danger';
        resetBtn.textContent = 'Скинути';
        resetBtn.addEventListener('click', () => adminResetProfile(profile.id, profile.nick, card));
        actions.appendChild(resetBtn);
    }

    if (fullAdmin) {
        const blockBtn = document.createElement('button');
        blockBtn.type = 'button';
        blockBtn.className = blocked ? 'btn-admin-action' : 'btn-admin-danger';
        blockBtn.textContent = blocked ? 'Розблокувати' : 'Заблокувати';
        blockBtn.disabled = profile.id === state.myUserId && !blocked;
        blockBtn.title = blockBtn.disabled ? 'Не можна заблокувати власний акаунт' : '';
        blockBtn.addEventListener('click', () => adminToggleUserBlock(profile, !blocked, card));
        actions.appendChild(blockBtn);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-admin-danger';
        delBtn.textContent = 'Видалити';
        delBtn.addEventListener('click', () => deleteUser(profile.id, profile.nick, card));
        actions.appendChild(delBtn);
    }

    card.appendChild(head);
    if (dataManager) card.appendChild(grid);
    card.appendChild(actions);
    return card;
}

async function adminToggleUserBlock(profile, blocked, cardEl) {
    if (!profile?.id) return;
    if (blocked && profile.id === state.myUserId) {
        showToast('Не можна заблокувати власний акаунт');
        return;
    }
    const ok = blocked
        ? confirm(`Заблокувати акаунт «${profile.nick}»? Користувач не зможе увійти.`)
        : confirm(`Розблокувати акаунт «${profile.nick}»?`);
    if (!ok) return;

    const settings = {
        ...profileSettings(profile),
        account_blocked: blocked,
        account_blocked_at: blocked ? new Date().toISOString() : null,
    };
    if (!blocked) delete settings.account_blocked_at;

    cardEl?.classList.add('admin-user-busy');
    const { error } = await supabase
        .from('profiles')
        .update({ settings })
        .eq('id', profile.id);
    cardEl?.classList.remove('admin-user-busy');

    if (error) {
        showToast('Помилка: ' + error.message);
        return;
    }

    await loadTeams();
    renderAdminPanel();
    showToast(blocked ? 'Користувача заблоковано' : 'Користувача розблоковано');
}

async function adminExportProfile(userId, nick, cardEl) {
    cardEl?.classList.add('admin-user-busy');
    try {
        await exportProfileData(userId, nick);
        showToast(`Експорт «${nick}» готовий`);
    } catch (error) {
        showToast('Помилка експорту: ' + (error?.message || error));
    } finally {
        cardEl?.classList.remove('admin-user-busy');
    }
}

async function adminResetProfile(userId, nick, cardEl) {
    if (!confirm(`Скинути журнал і налаштування профілю «${nick}» до чистого стану? Дія незворотна.`)) return;

    cardEl?.classList.add('admin-user-busy');
    try {
        await resetProfileData(userId, nick);
        showToast(`Профіль «${nick}» очищено`);
        if (window.renderView) window.renderView();
        if (window.refreshStatsView) window.refreshStatsView();
    } catch (error) {
        showToast('Помилка очищення: ' + (error?.message || error));
    } finally {
        cardEl?.classList.remove('admin-user-busy');
    }
}

async function updateUserRole(userId, newRole, selectEl) {
    const prev = selectEl.dataset.prevRole || 'trader';
    selectEl.disabled = true;

    const patch = { role: newRole };
    if (newRole === 'mentor') patch.mentor_enabled = true;
    else if (newRole === 'trader') patch.mentor_enabled = false;

    const { error } = await supabase.from('profiles').update(patch).eq('id', userId);

    selectEl.disabled = false;

    if (error) {
        showToast('Помилка ролі: ' + error.message);
        selectEl.value = prev;
        return;
    }

    selectEl.dataset.prevRole = newRole;
    await loadTeams();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
    showToast('Роль оновлено');
}

async function updateMentorFlag(userId, enabled, currentRole, cbEl) {
    if (currentRole === 'admin') {
        const { error } = await supabase
            .from('profiles')
            .update({ mentor_enabled: enabled })
            .eq('id', userId);
        if (error) {
            showToast(error.message);
            cbEl.checked = !enabled;
            return;
        }
        await loadTeams();
        renderAdminPanel();
        if (window.renderTeamSidebar) window.renderTeamSidebar();
        if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
        showToast('Статус ментора оновлено');
        return;
    } else {
        const patch = {
            mentor_enabled: enabled,
            role: enabled ? 'mentor' : 'trader',
        };
        const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
        if (error) {
            showToast(error.message);
            cbEl.checked = !enabled;
            return;
        }
        renderAdminPanel();
        await loadTeams();
        if (window.renderTeamSidebar) window.renderTeamSidebar();
        if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
        showToast('Статус ментора оновлено');
        return;
    }
}

async function adminUpdateTeam(userId, nick, targetTeam, cardEl) {
    if (!targetTeam) {
        showToast('Оберіть кущ');
        return;
    }
    const teamVal = targetTeam === DEFAULT_TEAM ? null : targetTeam;

    cardEl?.classList.add('admin-user-busy');
    const { error } = state.myRole === 'admin'
        ? await supabase.from('profiles').update({ team: teamVal }).eq('id', userId)
        : await supabase.rpc('mentor_move_trader_team', {
            target_user_id: userId,
            target_team: teamVal,
        });
    cardEl?.classList.remove('admin-user-busy');

    if (error) {
        showToast('Помилка: ' + error.message);
        return;
    }

    await loadTeams();
    renderAdminPanel();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
    showToast(`Кущ для «${nick}» оновлено`);
}

async function adminUpdateNick(userId, oldNick, newNick, cardEl) {
    if (!newNick || newNick.length < 3) {
        showToast('Нік мінімум 3 символи');
        return;
    }
    if (newNick === oldNick) {
        showToast('Нік не змінився');
        return;
    }

    const { data: taken, error: checkErr } = await supabase
        .from('profiles')
        .select('id')
        .eq('nick', newNick)
        .maybeSingle();
    if (checkErr) {
        showToast(checkErr.message);
        return;
    }
    if (taken && taken.id !== userId) {
        showToast('Такий нік уже зайнятий');
        return;
    }

    cardEl?.classList.add('admin-user-busy');
    const { error } = await supabase.from('profiles').update({ nick: newNick }).eq('id', userId);
    cardEl?.classList.remove('admin-user-busy');

    if (error) {
        showToast('Помилка: ' + error.message);
        return;
    }

    const myNick = state.USER_DOC_NAME.replace('_stats', '');
    if (oldNick === myNick) {
        state.USER_DOC_NAME = `${newNick}_stats`;
        state.CURRENT_VIEWED_USER = state.USER_DOC_NAME;
        showToast('Ваш нік змінено — перезавантаження…');
        setTimeout(() => location.reload(), 800);
        return;
    }

    await loadTeams();
    renderAdminPanel();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    showToast('Нік оновлено');
}

async function deleteUser(userId, nick, cardEl) {
    if (!confirm(`Видалити акаунт «${nick}»? Дія незворотна.`)) return;

    cardEl.classList.add('admin-user-busy');

    const { error } = await supabase.from('profiles').delete().eq('id', userId);

    cardEl.classList.remove('admin-user-busy');

    if (error) {
        showToast('Помилка видалення: ' + error.message);
        return;
    }

    cardEl.remove();
    await loadTeams();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    showToast(`Акаунт «${nick}» видалено`);
}
