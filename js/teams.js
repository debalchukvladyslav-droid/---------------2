import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast, showConfirm } from './utils.js';

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

async function fetchProfiles() {
    const { data, error } = await supabase
        .from('profiles')
        .select('id, nick, first_name, last_name, team, mentor_enabled, email')
        .order('team', { ascending: true })
        .order('nick', { ascending: true });

    if (error) throw error;
    return data || [];
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

    Object.keys(state.TEAM_GROUPS).sort((a, b) => a.localeCompare(b, 'uk')).forEach(group => {
        const opt = document.createElement('option');
        opt.value = group;
        opt.textContent = group;
        authTeamSelect.appendChild(opt);
    });
}

export async function loadTeams() {
    try {
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

    const traderSelect = document.getElementById('move-trader-nick');
    const teamSelect = document.getElementById('move-trader-team');
    const deleteSelect = document.getElementById('delete-trader-nick');
    const deleteTeamSelect = document.getElementById('delete-team-select');

    const addOpt = (sel, val, text, disabled = false, selected = false) => {
        const option = document.createElement('option');
        option.value = val;
        option.textContent = text;
        option.disabled = disabled;
        option.selected = selected;
        sel.appendChild(option);
    };

    traderSelect.innerHTML = '';
    teamSelect.innerHTML = '';
    deleteSelect.innerHTML = '';
    deleteTeamSelect.innerHTML = '';

    addOpt(traderSelect, '', 'Оберіть трейдера...', true, true);
    addOpt(teamSelect, '', 'Куди перемістити?', true, true);
    addOpt(deleteSelect, '', 'Кого видалити?', true, true);
    addOpt(deleteTeamSelect, '', 'Який кущ видалити?', true, true);

    Object.keys(state.TEAM_GROUPS).sort((a, b) => a.localeCompare(b, 'uk')).forEach(group => {
        addOpt(teamSelect, group, group);
        if (group !== DEFAULT_TEAM) addOpt(deleteTeamSelect, group, group);
    });

    Object.values(state._teamProfiles || {})
        .sort((a, b) => profileDisplayName(a).localeCompare(profileDisplayName(b), 'uk'))
        .forEach(profile => {
            const label = profileDisplayName(profile);
            addOpt(traderSelect, profile.nick, label);
            addOpt(deleteSelect, profile.nick, label);
        });
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

export async function deleteTeam() {
    const teamToDelete = document.getElementById('delete-team-select').value;
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

    const { error } = await supabase
        .from('profiles')
        .update({ team: null })
        .eq('team', teamToDelete);

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
    const myIcon = myProfile?.mentor_enabled ? '👑' : '👤';
    const myDisplayName = myProfile ? profileDisplayName(myProfile) : myNick;
    const loadingNick = _isSwitching ? state.CURRENT_VIEWED_USER.replace('_stats', '') : null;

    container.innerHTML = '';

    if (myNick) {
        const mySection = document.createElement('div');
        mySection.className = 'team-my-profile';
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
        const myIconSpan = document.createElement('span');
        myIconSpan.className = 'team-member-icon';
        myIconSpan.textContent = isLoading ? '⏳' : myIcon;
        const myNameSpan = document.createElement('span');
        myNameSpan.textContent = `🏠 ${myDisplayName}`;
        myBtn.appendChild(myIconSpan);
        myBtn.appendChild(myNameSpan);
        mySection.appendChild(myBtn);
        container.appendChild(mySection);
    }

    const seenInRender = new Set([myNick]);
    Object.keys(state.TEAM_GROUPS).forEach(group => {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'team-group-title';
        groupTitle.textContent = `📦 ${group}`;
        container.appendChild(groupTitle);

        (state.TEAM_GROUPS[group] || []).forEach(trader => {
            const cleanNick = extractNick(trader);
            if (seenInRender.has(cleanNick)) return;
            seenInRender.add(cleanNick);

            const profile = state._teamProfiles?.[cleanNick];
            const isMentor = profile?.mentor_enabled === true;
            const isActive = state.CURRENT_VIEWED_USER === `${cleanNick}_stats`;
            const isLoading = _isSwitching && loadingNick === cleanNick;
            const icon = isLoading ? '⏳' : (isMentor ? '👑' : '👤');
            const displayName = profile ? profileDisplayName(profile) : trader;

            const memberDiv = document.createElement('div');
            memberDiv.className = `team-member-item${isActive ? ' active' : ''}`;
            if (_isSwitching) {
                memberDiv.style.pointerEvents = 'none';
                memberDiv.style.opacity = isLoading ? '1' : '0.45';
                memberDiv.style.cursor = 'not-allowed';
            } else {
                memberDiv.onclick = () => switchUser(cleanNick);
            }

            const iconSpan = document.createElement('span');
            iconSpan.className = 'team-member-icon';
            iconSpan.textContent = icon;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'team-member-name';
            nameSpan.textContent = displayName;

            memberDiv.appendChild(iconSpan);
            memberDiv.appendChild(nameSpan);
            container.appendChild(memberDiv);
        });
    });
}

export async function switchUser(nick) {
    if (!state.USER_DOC_NAME) return;
    if (_isSwitching) return;
    if (state.CURRENT_VIEWED_USER === `${nick}_stats`) return;

    _isSwitching = true;
    state.CURRENT_VIEWED_USER = `${nick}_stats`;
    _renderTeamSidebarDOM(document.getElementById('team-list-container'));

    try {
        const { initializeApp } = await import('./storage.js');
        await initializeApp();
    } catch (e) {
        console.error('switchUser: initializeApp failed:', e);
    } finally {
        _isSwitching = false;
        renderTeamSidebar();
    }
}
