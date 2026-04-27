import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast, showConfirm, showPrompt } from './utils.js';

const DEFAULT_TEAM = 'Без куща';
const EXTRA_TEAMS_KEY = 'pj:extra-teams';

let _isSwitching = false;

function extractNick(entry = '') {
    return (entry.includes('(') && entry.includes(')'))
        ? entry.split('(')[1].replace(')', '').trim()
        : entry.trim();
}

function readExtraTeams() {
    try {
        const raw = localStorage.getItem(EXTRA_TEAMS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function writeExtraTeams(teams) {
    localStorage.setItem(EXTRA_TEAMS_KEY, JSON.stringify([...new Set(teams.filter(Boolean))]));
}

function profileDisplayName(profile) {
    if (profile?.first_name && profile?.last_name) {
        return `${profile.last_name} ${profile.first_name} (${profile.nick})`;
    }
    return profile?.nick || '';
}

function profileInitials(profile, fallbackNick) {
    if (profile?.first_name && profile?.last_name) {
        return (profile.first_name[0] + profile.last_name[0]).toUpperCase();
    }
    const n = profile?.nick || fallbackNick || '?';
    return n.slice(0, 2).toUpperCase();
}

function profileSettings(profile) {
    return profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
}

/** Аватар у списку команди: URL, емодзі або ініціали. */
function appendTeamAvatar(parent, profile, fallbackNick, { loading = false, mentor = false } = {}) {
    const baseClass = 'team-member-avatar' + (mentor ? ' is-mentor' : '');
    if (loading) {
        const sp = document.createElement('span');
        sp.className = baseClass;
        sp.textContent = '…';
        parent.appendChild(sp);
        return;
    }
    const st = profileSettings(profile);
    const url = (st.avatar_url || '').trim();
    const emoji = (st.avatar_emoji || '').trim().slice(0, 8);
    if (/^https?:\/\//i.test(url)) {
        const img = document.createElement('img');
        img.className = baseClass + ' team-member-avatar-img';
        img.src = url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            img.replaceWith(makeTeamAvatarFallback(profile, fallbackNick, baseClass));
        });
        parent.appendChild(img);
        return;
    }
    if (emoji) {
        const sp = document.createElement('span');
        sp.className = baseClass + ' team-member-avatar-emoji';
        sp.textContent = emoji;
        parent.appendChild(sp);
        return;
    }
    const sp = document.createElement('span');
    sp.className = baseClass;
    sp.textContent = profileInitials(profile, fallbackNick);
    parent.appendChild(sp);
}

function makeTeamAvatarFallback(profile, fallbackNick, baseClass) {
    const sp = document.createElement('span');
    sp.className = baseClass;
    sp.textContent = profileInitials(profile, fallbackNick);
    return sp;
}

function isProfileMentor(profile) {
    return !!(profile?.mentor_enabled || profile?.role === 'mentor');
}

function isProfileAdmin(profile) {
    return profile?.role === 'admin';
}

function isServiceProfile(profile) {
    return isProfileAdmin(profile) || isProfileMentor(profile);
}

function orderedTeamNames() {
    const myNick = state.USER_DOC_NAME ? state.USER_DOC_NAME.replace('_stats', '') : '';
    const myTeam = state._teamProfiles?.[myNick]?.team || DEFAULT_TEAM;
    return Object.keys(state.TEAM_GROUPS || {}).sort((a, b) => {
        if (a === myTeam && b !== myTeam) return -1;
        if (b === myTeam && a !== myTeam) return 1;
        return a.localeCompare(b, 'uk');
    });
}

async function fetchProfiles() {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) return [];

    const { data, error } = await supabase
        .from('profiles')
        .select('id, nick, first_name, last_name, team, mentor_enabled, email, role, settings')
        .order('team', { ascending: true })
        .order('nick', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function fetchPublicTeamNames() {
    try {
        const { data, error } = await supabase.rpc('public_team_names');
        if (error) throw error;
        return (data || []).map(row => row.name).filter(Boolean);
    } catch (error) {
        console.warn('[teams] public_team_names unavailable:', error);
        return [];
    }
}

function buildTeamGroups(profiles) {
    const groups = { [DEFAULT_TEAM]: [] };

    readExtraTeams().forEach(team => {
        if (!groups[team]) groups[team] = [];
    });

    profiles.forEach(profile => {
        const team = profile.team || DEFAULT_TEAM;
        if (!groups[team]) groups[team] = [];
        groups[team].push(profileDisplayName(profile));
    });

    Object.keys(groups).forEach(team => {
        groups[team] = [...new Set(groups[team])].sort((a, b) => a.localeCompare(b, 'uk'));
    });

    return groups;
}

function buildPublicTeamGroups(teamNames) {
    const groups = { [DEFAULT_TEAM]: [] };
    readExtraTeams().forEach(team => {
        if (team) groups[team] = [];
    });
    (teamNames || []).forEach(team => {
        if (team) groups[team] = [];
    });
    return groups;
}

function fillAuthTeamSelect() {
    const authTeamSelect = document.getElementById('auth-team');
    if (!authTeamSelect) return;

    authTeamSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    defaultOpt.textContent = 'Оберіть свій кущ...';
    authTeamSelect.appendChild(defaultOpt);

    orderedTeamNames().forEach(group => {
        const opt = document.createElement('option');
        opt.value = group;
        opt.textContent = group;
        authTeamSelect.appendChild(opt);
    });
}

export async function loadTeams() {
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session) {
            state._teamProfiles = {};
            state.TEAM_GROUPS = buildPublicTeamGroups(await fetchPublicTeamNames());
            fillAuthTeamSelect();
            return;
        }

        const profiles = await fetchProfiles();
        state._teamProfiles = Object.fromEntries(profiles.map(profile => [profile.nick, profile]));
        state.TEAM_GROUPS = buildTeamGroups(profiles);
        fillAuthTeamSelect();
        if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    } catch (e) {
        console.error('Помилка завантаження кущів:', e);
        state.TEAM_GROUPS = { [DEFAULT_TEAM]: [] };
        fillAuthTeamSelect();
    }
}

export async function openTeamManager() {
    document.getElementById('team-manager-modal').style.display = 'flex';

    const list = document.getElementById('team-manager-team-list');
    if (!list) return;

    const counts = new Map();
    Object.values(state._teamProfiles || {}).forEach((profile) => {
        const team = profile.team || DEFAULT_TEAM;
        counts.set(team, (counts.get(team) || 0) + 1);
    });

    list.innerHTML = orderedTeamNames()
        .map((group) => {
            const count = counts.get(group) || 0;
            const editable = group !== DEFAULT_TEAM;
            const removable = editable;
            return `<div class="tm-team-row">
                <div class="tm-team-row-main">
                    <span class="tm-team-name">${escapeHtml(group)}</span>
                    <span class="tm-team-count">${count} уч.</span>
                </div>
                ${removable ? `<button type="button" class="tm-team-delete-btn" data-action="team-delete" data-team-name="${escapeHtml(group)}">Видалити</button>` : '<span class="tm-team-fixed">Базовий</span>'}
            </div>`;
        })
        .join('');

    list.querySelectorAll('.tm-team-delete-btn[data-team-name]').forEach((deleteBtn) => {
        const teamName = deleteBtn.dataset.teamName || '';
        if (!teamName || teamName === DEFAULT_TEAM) return;
        if (deleteBtn.parentElement?.classList.contains('tm-team-actions')) return;

        const actions = document.createElement('div');
        actions.className = 'tm-team-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'tm-team-edit-btn';
        editBtn.dataset.action = 'team-rename';
        editBtn.dataset.teamName = teamName;
        editBtn.textContent = 'Редагувати';

        deleteBtn.replaceWith(actions);
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export async function createNewTeam() {
    const newTeam = document.getElementById('new-team-name').value.trim();
    if (!newTeam) {
        showToast('Введіть назву куща!');
        return;
    }
    if (state.TEAM_GROUPS[newTeam]) {
        showToast('Такий кущ вже існує!');
        return;
    }

    const extraTeams = readExtraTeams();
    extraTeams.push(newTeam);
    writeExtraTeams(extraTeams);

    document.getElementById('new-team-name').value = '';
    await loadTeams();
    await openTeamManager();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    showToast(`Кущ "${newTeam}" успішно створено!`);
}

export async function moveTrader() {
    const nick = document.getElementById('move-trader-nick').value;
    const targetTeam = document.getElementById('move-trader-team').value;
    if (!nick || !targetTeam) {
        showToast('Оберіть трейдера і новий кущ!');
        return;
    }

    const { error } = await supabase
        .from('profiles')
        .update({ team: targetTeam === DEFAULT_TEAM ? null : targetTeam })
        .eq('nick', nick);

    if (error) {
        showToast('Помилка переміщення: ' + error.message);
        return;
    }

    const extraTeams = readExtraTeams();
    if (!extraTeams.includes(targetTeam) && targetTeam !== DEFAULT_TEAM) {
        extraTeams.push(targetTeam);
        writeExtraTeams(extraTeams);
    }

    await loadTeams();
    await openTeamManager();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    showToast(`Трейдера ${nick} переміщено в ${targetTeam}!`);
}

export async function deleteTeam(teamName = '') {
    const teamToDelete =
        teamName ||
        document.getElementById('delete-team-select')?.value ||
        '';
    if (!teamToDelete) {
        showToast('Оберіть кущ для видалення!');
        return;
    }
    if (teamToDelete === DEFAULT_TEAM) {
        showToast('Цю базову групу видаляти не можна!');
        return;
    }

    const ok = await showConfirm(`Видалити кущ "${teamToDelete}"? Усі учасники перейдуть у "${DEFAULT_TEAM}".`);
    if (!ok) return;

    const { error } = await supabase.rpc('delete_team', { target_team: teamToDelete });

    if (error) {
        showToast('Помилка видалення куща: ' + error.message);
        return;
    }

    writeExtraTeams(readExtraTeams().filter(team => team !== teamToDelete));
    await loadTeams();
    await openTeamManager();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    showToast(`Кущ "${teamToDelete}" успішно видалено!`);
}

export async function renameTeam(teamName = '') {
    const oldName = teamName || '';
    if (!oldName) {
        showToast('Оберіть кущ для редагування!');
        return;
    }
    if (oldName === DEFAULT_TEAM) {
        showToast('Базовий кущ не можна перейменувати');
        return;
    }

    const newName = (await showPrompt(`Нова назва для куща "${oldName}":`, oldName))?.trim();
    if (!newName || newName === oldName) return;
    if (newName === DEFAULT_TEAM) {
        showToast(`Назва "${DEFAULT_TEAM}" зарезервована`);
        return;
    }
    if (state.TEAM_GROUPS?.[newName]) {
        showToast('Такий кущ вже існує');
        return;
    }

    const { error } = await supabase.rpc('rename_team', {
        old_team: oldName,
        new_team: newName,
    });

    if (error) {
        showToast('Помилка перейменування: ' + error.message);
        return;
    }

    writeExtraTeams(readExtraTeams().filter(team => team !== oldName).concat(newName));
    await loadTeams();
    await openTeamManager();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    if (window.renderAdminPanel) window.renderAdminPanel();
    showToast(`Кущ "${oldName}" перейменовано в "${newName}"`);
}

export async function deleteTraderProfile() {
    const nick = document.getElementById('delete-trader-nick').value;
    if (!nick) {
        showToast('Оберіть трейдера для видалення!');
        return;
    }
    if (nick === state.USER_DOC_NAME.replace('_stats', '')) {
        showToast('Ви не можете видалити власний профіль з меню Ментора!');
        return;
    }

    const ok = await showConfirm(`Назавжди видалити трейдера "${nick}" і його журнал?`);
    if (!ok) return;

    try {
        const profile = state._teamProfiles?.[nick];
        if (profile?.id) {
            const { error: journalError } = await supabase
                .from('journal_days')
                .delete()
                .eq('user_id', profile.id);
            if (journalError) throw journalError;
        }

        const { error: profileError } = await supabase
            .from('profiles')
            .delete()
            .eq('nick', nick);
        if (profileError) throw profileError;

        await loadTeams();
        await openTeamManager();
        if (window.renderTeamSidebar) window.renderTeamSidebar();
        showToast(`Профіль трейдера "${nick}" повністю знищено!`);
    } catch (e) {
        showToast('Помилка видалення: ' + e.message);
    }
}

export async function renderTeamSidebar() {
    const container = document.getElementById('team-list-container');
    if (!container || !state.USER_DOC_NAME) return;
    if (!state._teamProfiles) await loadTeams();
    _renderTeamSidebarDOM(container);
}

function _renderTeamSidebarDOM(container) {
    const myNick = state.USER_DOC_NAME ? state.USER_DOC_NAME.replace('_stats', '') : '';
    const isMeActive = state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
    const myProfile = state._teamProfiles?.[myNick];
    const myTeam = myProfile?.team || DEFAULT_TEAM;
    const myDisplayName = myProfile ? profileDisplayName(myProfile) : myNick;
    const loadingNick = _isSwitching ? state.CURRENT_VIEWED_USER.replace('_stats', '') : null;

    const teamLabel = document.getElementById('team-sidebar-current-team');
    if (teamLabel) teamLabel.textContent = myNick ? `Ваш кущ: ${myTeam}` : '';

    container.innerHTML = '';

    if (myNick) {
        const mySection = document.createElement('div');
        mySection.className = 'team-my-profile team-me-card';
        const myBtn = document.createElement('button');
        const isLoading = _isSwitching && loadingNick === myNick;
        myBtn.className = `team-member-btn${isMeActive ? ' active' : ''}`;
        if (_isSwitching) {
            myBtn.style.pointerEvents = 'none';
            myBtn.style.opacity = isLoading ? '1' : '0.45';
            myBtn.style.cursor = 'not-allowed';
        } else {
            myBtn.onclick = () => switchUser(myNick);
        }
        if (isLoading) {
            appendTeamAvatar(myBtn, myProfile, myNick, { loading: true, mentor: isProfileMentor(myProfile) });
        } else {
            appendTeamAvatar(myBtn, myProfile, myNick, { mentor: isProfileMentor(myProfile) });
        }
        const myText = document.createElement('div');
        myText.className = 'team-member-text';
        const myTitle = document.createElement('span');
        myTitle.className = 'team-member-title';
        myTitle.textContent = myDisplayName;
        const myBadges = document.createElement('div');
        myBadges.className = 'team-member-badges';
        const bHome = document.createElement('span');
        bHome.className = 'team-badge team-badge-home';
        bHome.textContent = 'Я';
        myBadges.appendChild(bHome);
        if (isProfileMentor(myProfile)) {
            const bM = document.createElement('span');
            bM.className = 'team-badge team-badge-mentor';
            bM.textContent = 'Ментор';
            myBadges.appendChild(bM);
        }
        if (isProfileAdmin(myProfile)) {
            const bA = document.createElement('span');
            bA.className = 'team-badge team-badge-admin';
            bA.textContent = 'Адмін';
            myBadges.appendChild(bA);
        }
        myText.appendChild(myTitle);
        myText.appendChild(myBadges);
        if (isProfileAdmin(myProfile)) {
            const contact = document.createElement('div');
            contact.className = 'team-member-contact';
            contact.textContent = 'Telegram: @kofer563';
            myText.appendChild(contact);
        }
        myBtn.appendChild(myText);
        mySection.appendChild(myBtn);
        container.appendChild(mySection);
    }

    const seenInRender = new Set([myNick]);
    orderedTeamNames().forEach((group) => {
        const groupCard = document.createElement('div');
        groupCard.className = 'team-group-card';

        const groupTitle = document.createElement('div');
        groupTitle.className = 'team-group-title';
        groupTitle.textContent = group;
        groupCard.appendChild(groupTitle);

        const members = [...(state.TEAM_GROUPS[group] || [])];
        members.sort((a, b) => {
            const na = extractNick(a);
            const nb = extractNick(b);
            const pa = state._teamProfiles?.[na];
            const pb = state._teamProfiles?.[nb];
            const sa = isServiceProfile(pa);
            const sb = isServiceProfile(pb);
            if (sa !== sb) return sa ? -1 : 1;
            return String(a).localeCompare(String(b), 'uk');
        });

        let memberItemsAdded = 0;
        members.forEach((trader) => {
            const cleanNick = extractNick(trader);
            if (seenInRender.has(cleanNick)) return;
            seenInRender.add(cleanNick);

            const profile = state._teamProfiles?.[cleanNick];
            const isMentor = isProfileMentor(profile);
            const isAdmin = isProfileAdmin(profile);
            const isService = isServiceProfile(profile);
            const isActive = state.CURRENT_VIEWED_USER === `${cleanNick}_stats`;
            const isLoading = _isSwitching && loadingNick === cleanNick;
            const displayName = profile ? profileDisplayName(profile) : trader;

            const memberDiv = document.createElement('div');
            memberDiv.className = `team-member-item${isActive ? ' active' : ''}`;
            if (isService) {
                memberDiv.style.cursor = 'default';
            } else if (_isSwitching) {
                memberDiv.style.pointerEvents = 'none';
                memberDiv.style.opacity = isLoading ? '1' : '0.45';
                memberDiv.style.cursor = 'not-allowed';
            } else {
                memberDiv.onclick = () => switchUser(cleanNick);
            }

            if (isLoading) {
                appendTeamAvatar(memberDiv, profile, cleanNick, { loading: true, mentor: isMentor });
            } else {
                appendTeamAvatar(memberDiv, profile, cleanNick, { mentor: isMentor });
            }

            const textWrap = document.createElement('div');
            textWrap.className = 'team-member-text';
            const title = document.createElement('span');
            title.className = 'team-member-title';
            title.textContent = displayName;
            textWrap.appendChild(title);
            if (isMentor || isAdmin) {
                const badges = document.createElement('div');
                badges.className = 'team-member-badges';
                const bm = document.createElement('span');
                bm.className = 'team-badge team-badge-mentor';
                bm.textContent = 'Ментор';
                if (isMentor) badges.appendChild(bm);
                if (isAdmin) {
                    const ba = document.createElement('span');
                    ba.className = 'team-badge team-badge-admin';
                    ba.textContent = 'Адмін';
                    badges.appendChild(ba);
                }
                textWrap.appendChild(badges);
            }
            if (isAdmin) {
                const contact = document.createElement('div');
                contact.className = 'team-member-contact';
                contact.textContent = 'Telegram: @kofer563';
                textWrap.appendChild(contact);
            }

            memberDiv.appendChild(textWrap);
            groupCard.appendChild(memberDiv);
            memberItemsAdded++;
        });

        if (
            memberItemsAdded === 0 &&
            myNick &&
            members.some((t) => extractNick(t) === myNick)
        ) {
            const hint = document.createElement('div');
            hint.className = 'team-solo-hint';
            hint.textContent =
                'Лише ви в цьому кущі (профіль зверху з міткою «Я»). Інших трейдерів буде видно після того, як ментор або адмін додасть вас до спільного куща — меню «Команда».';
            groupCard.appendChild(hint);
        }

        container.appendChild(groupCard);
    });
}

export async function switchUser(nick) {
    if (!state.USER_DOC_NAME) return;
    if (_isSwitching) return;
    if (state.CURRENT_VIEWED_USER === `${nick}_stats`) return;

    _isSwitching = true;
    if (typeof window.stopSheetAutoSync === 'function') window.stopSheetAutoSync();
    const selectedDocName = `${nick}_stats`;
    state.CURRENT_VIEWED_USER = selectedDocName;
    _renderTeamSidebarDOM(document.getElementById('team-list-container'));

    try {
        const { initializeApp, resolveViewedUserId, setCurrentViewedUserId } = await import('./storage.js');
        const selectedUserId = await resolveViewedUserId(selectedDocName, { force: true });
        setCurrentViewedUserId(selectedUserId);
        state.statsLoadRequestId++;
        state.appData = { ...state.appData, journal: {} };
        state.loadedMonths[selectedDocName] = new Set();
        state._availableMonthKeys = new Set();
        if (window.renderView) window.renderView();
        await initializeApp();
        if (window.refreshStatsView) await window.refreshStatsView();
    } catch (e) {
        console.error('switchUser: initializeApp failed:', e);
    } finally {
        _isSwitching = false;
        renderTeamSidebar();
    }
}
