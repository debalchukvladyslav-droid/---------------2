// === Профіль у лівому сайдбарі (над «Згорнути») ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { loadTeams } from './teams.js';

const DEFAULT_TEAM_LABEL = 'Без куща';

let _listenersBound = false;

function myNick() {
    return state.USER_DOC_NAME ? state.USER_DOC_NAME.replace('_stats', '') : '';
}

function initialsFromProfile(p) {
    return (
        (p?.first_name?.[0] || '') + (p?.last_name?.[0] || '') ||
        (p?.nick || '').slice(0, 2)
    ).toUpperCase() || '?';
}

function paintSidebarAvatar(el, p) {
    if (!el) return;
    el.innerHTML = '';
    el.classList.remove('sidebar-account-avatar-emoji', 'has-image');
    const st = p?.settings && typeof p.settings === 'object' ? p.settings : {};
    const url = (st.avatar_url || '').trim();
    const emoji = (st.avatar_emoji || '').trim().slice(0, 8);
    if (/^https?:\/\//i.test(url)) {
        const img = document.createElement('img');
        img.className = 'sidebar-account-avatar-img';
        img.src = url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            el.innerHTML = '';
            el.textContent = initialsFromProfile(p);
        });
        el.appendChild(img);
        el.classList.add('has-image');
        return;
    }
    if (emoji) {
        el.textContent = emoji;
        el.classList.add('sidebar-account-avatar-emoji');
        return;
    }
    el.textContent = initialsFromProfile(p);
}

function bindAvatarPicker() {
    const grid = document.getElementById('sidebar-pf-emoji-grid');
    const hidden = document.getElementById('sidebar-pf-emoji');
    const clearBtn = document.getElementById('sidebar-pf-avatar-clear');
    if (!grid || !hidden) return;
    grid.querySelectorAll('button[data-emoji]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-emoji') || '';
            hidden.value = v;
            grid.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.remove('picked'));
            btn.classList.add('picked');
            const urlInp = document.getElementById('sidebar-pf-avatar-url');
            if (urlInp) urlInp.value = '';
        });
    });
    clearBtn?.addEventListener('click', () => {
        hidden.value = '';
        grid.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.remove('picked'));
    });
    const urlInp = document.getElementById('sidebar-pf-avatar-url');
    urlInp?.addEventListener('input', () => {
        if (urlInp.value.trim()) {
            hidden.value = '';
            grid.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.remove('picked'));
        }
    });
}

function bindOnce() {
    if (_listenersBound) return;
    _listenersBound = true;
    const trigger = document.getElementById('sidebar-account-trigger');
    const dropdown = document.getElementById('sidebar-account-dropdown');
    const saveBtn = document.getElementById('sidebar-pf-save');
    bindAvatarPicker();
    if (trigger && dropdown) {
        const acc = document.getElementById('sidebar-account');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = dropdown.hidden;
            dropdown.hidden = !willOpen;
            trigger.setAttribute('aria-expanded', String(willOpen));
        });
        document.addEventListener('click', (e) => {
            if (!acc || acc.contains(e.target)) return;
            if (!dropdown.hidden) {
                dropdown.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !dropdown || dropdown.hidden) return;
            dropdown.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        });
    }
    saveBtn?.addEventListener('click', () => saveSidebarProfile());
}

export function initSidebarAccount() {
    bindOnce();
}

export async function refreshSidebarAccount() {
    bindOnce();
    const nick = myNick();
    const avatar = document.getElementById('sidebar-account-avatar');
    const nameEl = document.getElementById('sidebar-account-name');
    const teamEl = document.getElementById('sidebar-account-team');
    const subEl = document.getElementById('sidebar-account-sub');
    const nickRO = document.getElementById('sidebar-pf-nick');
    const teamRO = document.getElementById('sidebar-pf-team-display');

    if (!nick) {
        if (nameEl) nameEl.textContent = '—';
        if (teamEl) teamEl.textContent = '';
        if (subEl) subEl.textContent = '';
        if (avatar) {
            avatar.innerHTML = '';
            avatar.textContent = '?';
        }
        if (nickRO) nickRO.textContent = '—';
        if (teamRO) teamRO.textContent = '—';
        return;
    }

    const { data: p, error } = await supabase
        .from('profiles')
        .select('first_name, last_name, team, nick, email, mentor_enabled, role, settings')
        .eq('nick', nick)
        .maybeSingle();

    if (error || !p) return;

    paintSidebarAvatar(avatar, p);

    const disp = p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.nick;
    if (nameEl) nameEl.textContent = disp;
    const teamLabel = p.team || DEFAULT_TEAM_LABEL;
    if (teamEl) teamEl.textContent = teamLabel;
    if (nickRO) nickRO.textContent = p.nick || nick;
    if (teamRO) teamRO.textContent = teamLabel;

    const st = p.settings && typeof p.settings === 'object' ? p.settings : {};
    const subParts = [];
    if (p.email) subParts.push(p.email);
    const authProv = (st.auth_provider || state.authProvider || '').toLowerCase();
    if (authProv === 'telegram') subParts.push('Telegram');
    if (p.mentor_enabled || p.role === 'mentor') subParts.push('Ментор');
    if (p.role === 'admin') subParts.push('Адмін');
    if (subEl) subEl.textContent = subParts.join(' · ');

    const fn = document.getElementById('sidebar-pf-fname');
    const ln = document.getElementById('sidebar-pf-lname');
    const urlInp = document.getElementById('sidebar-pf-avatar-url');
    const hiddenEmoji = document.getElementById('sidebar-pf-emoji');
    if (fn) fn.value = p.first_name || '';
    if (ln) ln.value = p.last_name || '';
    if (document.getElementById('view-dash')?.classList.contains('active')) {
        window.refreshCurrentMainTitle?.();
    }
    if (urlInp) urlInp.value = st.avatar_url || '';
    const em = st.avatar_emoji || '';
    if (hiddenEmoji) hiddenEmoji.value = em;
    document.querySelectorAll('#sidebar-pf-emoji-grid button[data-emoji]').forEach((b) => {
        b.classList.toggle('picked', b.getAttribute('data-emoji') === em);
    });
}

async function saveSidebarProfile() {
    const nick = myNick();
    if (!nick) return;

    const fname = document.getElementById('sidebar-pf-fname')?.value.trim() || '';
    const lname = document.getElementById('sidebar-pf-lname')?.value.trim() || '';
    const urlRaw = document.getElementById('sidebar-pf-avatar-url')?.value.trim() || '';
    const emojiPick = document.getElementById('sidebar-pf-emoji')?.value.trim().slice(0, 8) || '';

    if (!fname || !lname) {
        showToast("Вкажіть ім'я та прізвище");
        return;
    }

    const { data: existing, error: fetchErr } = await supabase.from('profiles').select('settings').eq('nick', nick).maybeSingle();
    if (fetchErr) {
        showToast('Помилка: ' + fetchErr.message);
        return;
    }

    const prevSettings = existing?.settings && typeof existing.settings === 'object' ? existing.settings : {};
    const settings = { ...prevSettings };
    if (urlRaw && /^https?:\/\//i.test(urlRaw)) {
        settings.avatar_url = urlRaw;
        delete settings.avatar_emoji;
    } else {
        delete settings.avatar_url;
        if (emojiPick) settings.avatar_emoji = emojiPick;
        else delete settings.avatar_emoji;
    }

    const { error } = await supabase
        .from('profiles')
        .update({
            first_name: fname,
            last_name: lname,
            settings,
        })
        .eq('nick', nick);

    if (error) {
        showToast('Не вдалося зберегти: ' + error.message);
        return;
    }

    const displayName = `${lname} ${fname} (${nick})`;
    for (const group of Object.keys(state.TEAM_GROUPS)) {
        const arr = state.TEAM_GROUPS[group];
        const idx = arr.findIndex((t) => {
            const clean = t.includes('(') && t.includes(')') ? t.split('(')[1].replace(')', '').trim() : t.trim();
            return clean === nick;
        });
        if (idx > -1) arr[idx] = displayName;
    }

    await loadTeams();
    await refreshSidebarAccount();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    showToast('Профіль оновлено');
}
