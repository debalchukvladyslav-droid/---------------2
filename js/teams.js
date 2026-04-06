// === js/teams.js ===
import { db, auth } from './firebase.js';
import { state } from './state.js';
import { showToast, showConfirm } from './utils.js';

// ─── SWITCH LOCK ─────────────────────────────────────────────────────────────
// Prevents concurrent switchUser calls. Set to true the moment a switch
// begins; cleared in the finally block so it ALWAYS resets even on error.
let _isSwitching = false;

function extractNick(entry) {
    return (entry.includes('(') && entry.includes(')')) ? entry.split('(')[1].replace(')', '').trim() : entry.trim();
}

function deduplicateTeams(groups) {
    // Перший прохід: збираємо найкращий запис для кожного ніка
    const best = {}; // nick -> { group, entry }
    for (const group in groups) {
        for (const entry of groups[group]) {
            const nick = extractNick(entry);
            if (!nick) continue;
            if (!best[nick] || (entry.includes('(') && !best[nick].entry.includes('('))) {
                best[nick] = { group, entry };
            }
        }
    }
    // Другий прохід: залишаємо тільки найкращий запис у правильному кущі
    for (const group in groups) {
        groups[group] = groups[group].filter(entry => {
            const nick = extractNick(entry);
            return best[nick] && best[nick].group === group && best[nick].entry === entry;
        });
    }
    return groups;
}

export async function loadTeams() {
    try {
        let doc = await db.collection("system").doc("teams").get({ source: 'server' });
        if (doc.exists) {
            const raw = doc.data();
            state.TEAM_GROUPS = deduplicateTeams(raw);
            if (JSON.stringify(raw) !== JSON.stringify(state.TEAM_GROUPS)) {
                await db.collection("system").doc("teams").set(state.TEAM_GROUPS);
            }
        } else {
            state.TEAM_GROUPS = { "Без куща": [] };
        }

        let authTeamSelect = document.getElementById('auth-team');
        if (authTeamSelect) {
            authTeamSelect.innerHTML = '';
            const defaultOpt = document.createElement('option');
            defaultOpt.value = ''; defaultOpt.disabled = true; defaultOpt.selected = true;
            defaultOpt.textContent = 'Оберіть свій кущ...';
            authTeamSelect.appendChild(defaultOpt);
            for (let group in state.TEAM_GROUPS) {
                const opt = document.createElement('option');
                opt.value = group;
                opt.textContent = group;
                authTeamSelect.appendChild(opt);
            }
        }

        // Full journal scan to auto-assign unassigned traders.
        // Only run for mentors — this is an expensive collection-wide read.
        if (auth.currentUser && state.IS_MENTOR_MODE) {
            let journalSnap = await db.collection("journal").get();
            let hasChanges = false;
            if (!state.TEAM_GROUPS["Без куща"]) state.TEAM_GROUPS["Без куща"] = [];

            journalSnap.forEach(jDoc => {
                if (jDoc.id.includes('_stats')) {
                    let nick = jDoc.id.replace('_stats', '');
                    let isAssigned = false;
                    for (let group in state.TEAM_GROUPS) {
                        if (state.TEAM_GROUPS[group].some(t => {
                            const cleanNick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t;
                            return cleanNick === nick;
                        })) { isAssigned = true; break; }
                    }
                    if (!isAssigned) {
                        state.TEAM_GROUPS["Без куща"].push(nick);
                        hasChanges = true;
                    }
                }
            });

            if (hasChanges) {
                await db.collection("system").doc("teams").set(state.TEAM_GROUPS);
            }
        }

        if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    } catch (e) {
        console.error("Помилка завантаження кущів:", e);
    }
}

export async function openTeamManager() {
    document.getElementById('team-manager-modal').style.display = 'flex';
    let traderSelect = document.getElementById('move-trader-nick');
    let teamSelect = document.getElementById('move-trader-team');
    let deleteSelect = document.getElementById('delete-trader-nick');
    let deleteTeamSelect = document.getElementById('delete-team-select');

    const addOpt = (sel, val, text, disabled = false, selected = false) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = text;
        if (disabled) o.disabled = true;
        if (selected) o.selected = true;
        sel.appendChild(o);
    };

    traderSelect.innerHTML = '';
    teamSelect.innerHTML = '';
    deleteSelect.innerHTML = '';
    addOpt(traderSelect, '', 'Оберіть трейдера...', true, true);
    addOpt(teamSelect,   '', 'Куди перемістити?',   true, true);
    addOpt(deleteSelect, '', 'Кого видалити?',       true, true);
    if (deleteTeamSelect) {
        deleteTeamSelect.innerHTML = '';
        addOpt(deleteTeamSelect, '', 'Який кущ видалити?', true, true);
    }

    // Збираємо унікальні ніки з усіх кущів
    const seenNicks = new Set();
    const allNicks = [];
    for (let group in state.TEAM_GROUPS) {
        addOpt(teamSelect, group, group);
        if (deleteTeamSelect && group !== 'Без куща') addOpt(deleteTeamSelect, group, group);
        state.TEAM_GROUPS[group].forEach(t => {
            const nick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t.trim();
            if (!seenNicks.has(nick)) { seenNicks.add(nick); allNicks.push(nick); }
        });
    }

    // Завантажуємо імена з Firestore, примусово з сервера
    const profileDocs = await Promise.all(allNicks.map(n => db.collection('journal').doc(`${n}_stats`).get({ source: 'server' })));
    allNicks.forEach((nick, i) => {
        const d = profileDocs[i];
        const data = d.exists ? d.data() : {};
        const label = (data.first_name && data.last_name)
            ? `${data.last_name} ${data.first_name} (${nick})`
            : nick;
        addOpt(traderSelect, nick, label);
        addOpt(deleteSelect, nick, label);
    });
}

export async function createNewTeam() {
    let newTeam = document.getElementById('new-team-name').value.trim();
    if (!newTeam) { showToast("Введіть назву куща!"); return; }
    if (state.TEAM_GROUPS[newTeam]) { showToast("Такий кущ вже існує!"); return; }
    
    state.TEAM_GROUPS[newTeam] = [];
    await db.collection("system").doc("teams").set(state.TEAM_GROUPS);
    
    showToast(`Кущ "${newTeam}" успішно створено!`);
    document.getElementById('new-team-name').value = '';
    
    await loadTeams(); 
    await openTeamManager(); 
    if (window.renderTeamSidebar) window.renderTeamSidebar();
}

export async function moveTrader() {
    let nick = document.getElementById('move-trader-nick').value;
    let targetTeam = document.getElementById('move-trader-team').value;
    if (!nick || !targetTeam) { showToast('Оберіть трейдера і новий кущ!'); return; }

    for (let group in state.TEAM_GROUPS) {
        state.TEAM_GROUPS[group] = state.TEAM_GROUPS[group].filter(t => {
            const n = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t.trim();
            return n !== nick;
        });
    }
    // Зберігаємо існуючий рядок з іменем якщо є
    const statsDoc = await db.collection('journal').doc(`${nick}_stats`).get();
    const data = statsDoc.exists ? statsDoc.data() : {};
    const entry = (data.first_name && data.last_name) ? `${data.last_name} ${data.first_name} (${nick})` : nick;
    state.TEAM_GROUPS[targetTeam].push(entry);
    await db.collection('system').doc('teams').set(state.TEAM_GROUPS);

    showToast(`Трейдера ${nick} переміщено в ${targetTeam}!`);
    await loadTeams();
    await openTeamManager();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
}

export async function deleteTeam() {
    let teamToDelete = document.getElementById('delete-team-select').value;
    if (!teamToDelete) { showToast("Оберіть кущ для видалення!"); return; }
    if (teamToDelete === "Без куща") { showToast("Цю базову групу видаляти не можна!"); return; }

    showConfirm(`🚨 Ви впевнені, що хочете видалити кущ "${teamToDelete}"?\n\nВсі його учасники перейдуть у групу "Без куща".`).then(async ok => {
        if (!ok) return;
        try {
            if (!state.TEAM_GROUPS["Без куща"]) state.TEAM_GROUPS["Без куща"] = [];
            state.TEAM_GROUPS[teamToDelete].forEach(trader => {
                state.TEAM_GROUPS["Без куща"].push(trader);
            });
            delete state.TEAM_GROUPS[teamToDelete];
            
            await db.collection("system").doc("teams").set(state.TEAM_GROUPS);
            showToast(`✅ Кущ "${teamToDelete}" успішно видалено!`);
            
            await loadTeams(); 
            await openTeamManager(); 
            if (window.renderTeamSidebar) window.renderTeamSidebar();
        } catch(e) {
            showToast("❌ Помилка видалення куща: " + e.message);
        }
    });
}

export async function deleteTraderProfile() {
    let nick = document.getElementById('delete-trader-nick').value;
    if (!nick) { showToast('Оберіть трейдера для видалення!'); return; }
    if (nick === state.USER_DOC_NAME.replace('_stats', '')) {
        showToast('Ви не можете видалити власний профіль з меню Ментора!'); return;
    }

    showConfirm(`🚨 УВАГА! Ви дійсно хочете НАЗАВЖДИ видалити трейдера "${nick}" та всю його історію?`).then(async ok => {
        if (!ok) return;
        try {
            const statsDoc = await db.collection('journal').doc(`${nick}_stats`).get();
            const email = statsDoc.exists ? statsDoc.data()?.trader_email : null;

            for (let group in state.TEAM_GROUPS) {
                state.TEAM_GROUPS[group] = state.TEAM_GROUPS[group].filter(t => {
                    const n = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t.trim();
                    return n !== nick;
                });
            }
            await db.collection('system').doc('teams').set(state.TEAM_GROUPS);
            await db.collection('journal').doc(`${nick}_stats`).delete();
            await db.collection('journal').doc(nick).delete().catch(() => {});

            if (email) {
                await db.collection('system').doc('pending_auth_deletes').set({ [nick]: email }, { merge: true });
            }

            showToast(`✅ Профіль трейдера "${nick}" повністю знищено!`);
            await loadTeams();
            await openTeamManager();
            if (window.renderTeamSidebar) window.renderTeamSidebar();
        } catch(e) {
            showToast('❌ Помилка видалення: ' + e.message);
        }
    });
}

export async function renderTeamSidebar() {
    const container = document.getElementById('team-list-container');
    if (!container) return;
    if (!state.USER_DOC_NAME) return;

    // Якщо кеш є — рендеримо одразу, оновлюємо у фоні
    if (state._cachedMentorMap && state._cachedProfileCache) {
        _renderTeamSidebarDOM(container, state._cachedMentorMap, state._cachedProfileCache);
        _refreshSidebarCache(container).catch(e => console.warn('sidebar cache refresh:', e));
        return;
    }
    await _refreshSidebarCache(container);
}

async function _refreshSidebarCache(container) {
    try {
        const doc = await db.collection('system').doc('mentor_accounts').get({ source: 'server' });
        const mentorMap = doc.exists ? (doc.data() || {}) : {};

        const allNicks = [];
        for (let group in state.TEAM_GROUPS) {
            state.TEAM_GROUPS[group].forEach(t => {
                const nick = (t.includes('(') && t.includes(')')) ? t.split('(')[1].replace(')', '').trim() : t;
                if (!allNicks.includes(nick)) allNicks.push(nick);
            });
        }
        const myNickRaw = state.USER_DOC_NAME.replace('_stats', '');
        if (myNickRaw && !allNicks.includes(myNickRaw)) allNicks.push(myNickRaw);

        // Завантажуємо тільки профілі яких ще немає в кеші
        const profileCache = { ...(state._cachedProfileCache || {}) };
        const toFetch = allNicks.filter(n => !(n in profileCache));
        if (toFetch.length) {
            const profileDocs = await Promise.all(
                toFetch.map(n => db.collection('journal').doc(`${n}_stats`).get({ source: 'server' }))
            );
            profileDocs.forEach((d, i) => {
                const data = d.exists ? d.data() : {};
                profileCache[toFetch[i]] = (data.first_name && data.last_name)
                    ? `${data.last_name} ${data.first_name}` : '';
            });
        }

        state._cachedMentorMap = mentorMap;
        state._cachedProfileCache = profileCache;
        _renderTeamSidebarDOM(container, mentorMap, profileCache);
    } catch (e) {
        console.error('Помилка завантаження профілів:', e);
        _renderTeamSidebarDOM(container, state._cachedMentorMap || {}, state._cachedProfileCache || {});
    }
}

function _renderTeamSidebarDOM(container, mentorMap, profileCache) {
    if (!container) return;

    const myNick = state.USER_DOC_NAME ? state.USER_DOC_NAME.replace('_stats', '') : '';
    const isMeActive = state.CURRENT_VIEWED_USER === state.USER_DOC_NAME;
    const myIcon = (state.USER_DOC_NAME && mentorMap[state.USER_DOC_NAME]) ? '👑' : '👤';
    const myDisplayName = profileCache[myNick] ? `${profileCache[myNick]} (${myNick})` : myNick;
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
    for (let group in state.TEAM_GROUPS) {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'team-group-title';
        groupTitle.textContent = `📦 ${group}`;
        container.appendChild(groupTitle);

        state.TEAM_GROUPS[group].forEach(trader => {
            const cleanNick = (trader.includes('(') && trader.includes(')')) ? trader.split('(')[1].replace(')', '').trim() : trader;
            if (seenInRender.has(cleanNick)) return;
            seenInRender.add(cleanNick);
            const docKey = `${cleanNick}_stats`;
            const isMentor = mentorMap[docKey] === true;
            const isActive = state.CURRENT_VIEWED_USER === docKey;
            const isLoading = _isSwitching && loadingNick === cleanNick;
            const icon = isLoading ? '⏳' : (isMentor ? '👑' : '👤');
            const displayName = profileCache[cleanNick] ? `${profileCache[cleanNick]} (${cleanNick})` : trader;

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
    }
}

export async function switchUser(nick) {
    if (!state.USER_DOC_NAME) return;          // Guard: auth must be resolved first
    if (_isSwitching) return;                  // Lock: drop all clicks while a switch is in flight
    if (state.CURRENT_VIEWED_USER === `${nick}_stats`) return;

    _isSwitching = true;
    state.CURRENT_VIEWED_USER = `${nick}_stats`;
    console.log('Перемикання на користувача:', state.CURRENT_VIEWED_USER);

    // Immediately re-render the sidebar so the clicked item shows a spinner
    // and all other items are visually disabled — before any network call.
    _renderTeamSidebarDOM(
        document.getElementById('team-list-container'),
        state._cachedMentorMap || {},
        state._cachedProfileCache || {}
    );

    try {
        // One-time .get() via initializeApp — never onSnapshot for viewed users.
        const { initializeApp } = await import('./storage.js');
        await initializeApp();
    } catch (e) {
        console.error('switchUser: initializeApp failed:', e);
    } finally {
        _isSwitching = false;
        // Re-render once more now that data is loaded and lock is released.
        renderTeamSidebar();
    }
}
