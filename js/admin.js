// === js/admin.js ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { copyTextToClipboard, showToast } from './utils.js';
import { loadTeams } from './teams.js';
import { exportProfileData, resetProfileData } from './storage.js';

const ROLES = ['trader', 'mentor', 'admin'];
const DEFAULT_TEAM = 'Без куща';
const SERVICE_BOT_SECRET_STORAGE_KEY = 'tj_admin_service_bot_secret_key';
const SERVICE_BOT_DATA_ENDPOINTS = ['snapshot', 'summary', 'tickers', 'orders', 'locates'];

export async function renderAdminPanel() {
    const container = document.getElementById('admin-users-list');
    if (!container) return;

    const refreshUsersBtn = document.getElementById('admin-refresh-users-btn');
    const botsPanel = document.getElementById('admin-service-bots-panel');
    const fullAdmin = state.myRole === 'admin';
    const dataManager = fullAdmin || state.IS_MENTOR_MODE;
    if (botsPanel) botsPanel.hidden = !fullAdmin;
    if (!dataManager) {
        if (refreshUsersBtn) refreshUsersBtn.style.display = 'none';
        if (botsPanel) botsPanel.innerHTML = '';
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
        : (profiles || []).filter((p) => p.id !== state.myUserId && p.role !== 'mentor' && !p.mentor_enabled);

    if (!visibleProfiles.length) {
        container.innerHTML = '<p class="admin-empty">Трейдерів для переміщення не знайдено.</p>';
        return;
    }

    const teamChoices = teamListForSelect();

    container.innerHTML = '';
    if (fullAdmin) renderServiceBotsPanel(profiles || []);
    visibleProfiles.forEach((p) => container.appendChild(buildUserCard(p, teamChoices, { fullAdmin, dataManager })));
}

async function adminApiFetch(path, options = {}) {
    const { data, error } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (error || !token) throw new Error(error?.message || 'Auth session not found');
    const response = await fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || response.statusText || `HTTP ${response.status}`);
    }
    return payload;
}

function renderServiceBotsPanel(profiles = []) {
    const panel = document.getElementById('admin-service-bots-panel');
    if (!panel) return;
    panel.hidden = false;
    const traders = profiles.filter((profile) => profile?.id);
    panel.innerHTML = `
        <div class="admin-service-bots-head">
            <div>
                <h4 class="admin-section-title">Service bots</h4>
                <p class="admin-section-subtitle">Read-only API keys for external services.</p>
            </div>
            <button type="button" class="btn-admin-action" data-service-bots-refresh>Refresh</button>
        </div>
        <form class="admin-service-bot-form" data-service-bot-form>
            <label class="admin-field">
                <span class="admin-label">Bot name</span>
                <input class="admin-input" name="name" type="text" maxlength="120" placeholder="Trading service bot">
            </label>
            <label class="admin-field">
                <span class="admin-label">Trader</span>
                <select class="admin-select" name="user_id">
                    ${traders.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.nick || profile.email || profile.id)}</option>`).join('')}
                </select>
            </label>
            <button type="submit" class="btn-admin-action">Create key</button>
        </form>
        <div class="admin-service-bot-key" data-service-bot-key hidden></div>
        <div class="admin-service-bot-explorer" data-service-bot-explorer>
            <div class="admin-service-bots-head">
                <div>
                    <h4 class="admin-section-title">Service bot data explorer</h4>
                    <p class="admin-section-subtitle">Встав secret/API key і подивись всі дані, які read API може віддати.</p>
                </div>
                <button type="button" class="btn-admin-action" data-service-bot-secret-clear>Clear key</button>
            </div>
            <form class="admin-service-bot-query" data-service-bot-query-form>
                <label class="admin-field admin-field-wide">
                    <span class="admin-label">Secret / API key</span>
                    <input class="admin-input" name="secret_key" type="password" autocomplete="off" spellcheck="false" placeholder="shs_service_...">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Endpoint</span>
                    <select class="admin-select" name="endpoint">
                        ${SERVICE_BOT_DATA_ENDPOINTS.map((endpoint) => `<option value="${endpoint}">${endpoint}</option>`).join('')}
                    </select>
                </label>
                <label class="admin-field">
                    <span class="admin-label">Days</span>
                    <input class="admin-input" name="days" type="number" min="1" max="31" value="31">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Start</span>
                    <input class="admin-input" name="start" type="date">
                </label>
                <label class="admin-field">
                    <span class="admin-label">End</span>
                    <input class="admin-input" name="end" type="date">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Items limit</span>
                    <input class="admin-input" name="limit" type="number" min="1" max="500" value="100">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Top limit</span>
                    <input class="admin-input" name="top_limit" type="number" min="1" max="100" value="25">
                </label>
                <label class="admin-check-field">
                    <input name="refresh" type="checkbox" value="1">
                    <span>Refresh cache</span>
                </label>
                <div class="admin-service-bot-query-actions">
                    <button type="submit" class="btn-admin-action">Load data</button>
                    <button type="button" class="btn-admin-action" data-service-bot-secret-save>Save key</button>
                </div>
            </form>
            <div class="admin-service-bot-result" data-service-bot-result hidden></div>
        </div>
        <div class="admin-service-bots-list" data-service-bots-list>
            <p class="admin-loading">Loading service bots...</p>
        </div>
    `;

    panel.querySelector('[data-service-bots-refresh]')?.addEventListener('click', () => loadServiceBotsList(panel));
    panel.querySelector('[data-service-bot-form]')?.addEventListener('submit', (event) => createServiceBot(event, panel));
    bindServiceBotExplorer(panel);
    loadServiceBotsList(panel);
}

async function createServiceBot(event, panel) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const body = {
        name: String(formData.get('name') || '').trim(),
        user_id: String(formData.get('user_id') || '').trim(),
    };
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
        const payload = await adminApiFetch('/api/admin/service-bots', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        form.reset();
        renderCreatedServiceBotKey(panel, payload.api_key);
        await loadServiceBotsList(panel);
        showToast('Service bot key created');
    } catch (error) {
        showToast('Service bot error: ' + (error?.message || error));
    } finally {
        if (submit) submit.disabled = false;
    }
}

function renderCreatedServiceBotKey(panel, apiKey) {
    const box = panel.querySelector('[data-service-bot-key]');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `
        <div class="admin-service-bot-key-title">New key. Save it now.</div>
        <code>${escapeHtml(apiKey || '')}</code>
        <button type="button" class="btn-admin-action">Copy</button>
    `;
    box.querySelector('button')?.addEventListener('click', async () => {
        const ok = await copyTextToClipboard(apiKey || '');
        showToast(ok ? 'Service bot key copied' : 'Copy failed');
    });
}

function bindServiceBotExplorer(panel) {
    const form = panel.querySelector('[data-service-bot-query-form]');
    const keyInput = form?.elements?.secret_key;
    if (!form || !keyInput) return;

    keyInput.value = localStorage.getItem(SERVICE_BOT_SECRET_STORAGE_KEY) || '';
    panel.querySelector('[data-service-bot-secret-save]')?.addEventListener('click', () => {
        const key = String(keyInput.value || '').trim();
        if (!key) {
            showToast('Встав secret/API key');
            return;
        }
        localStorage.setItem(SERVICE_BOT_SECRET_STORAGE_KEY, key);
        showToast('Secret key saved locally');
    });
    panel.querySelector('[data-service-bot-secret-clear]')?.addEventListener('click', () => {
        localStorage.removeItem(SERVICE_BOT_SECRET_STORAGE_KEY);
        keyInput.value = '';
        renderServiceBotExplorerResult(panel, null);
        showToast('Secret key cleared');
    });
    form.addEventListener('submit', (event) => loadServiceBotExplorerData(event, panel));
}

function serviceBotQueryParams(formData) {
    const params = new URLSearchParams();
    ['days', 'start', 'end', 'limit', 'top_limit'].forEach((name) => {
        const value = String(formData.get(name) || '').trim();
        if (value) params.set(name, value);
    });
    if (formData.get('refresh')) params.set('refresh', '1');
    return params;
}

async function loadServiceBotExplorerData(event, panel) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const key = String(formData.get('secret_key') || '').trim();
    const endpoint = SERVICE_BOT_DATA_ENDPOINTS.includes(String(formData.get('endpoint')))
        ? String(formData.get('endpoint'))
        : 'snapshot';
    if (!key) {
        showToast('Встав secret/API key');
        return;
    }

    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    renderServiceBotExplorerResult(panel, { loading: true });
    try {
        const params = serviceBotQueryParams(formData);
        const url = `/api/service-bots/${encodeURIComponent(endpoint)}${params.toString() ? `?${params}` : ''}`;
        const response = await fetch(url, {
            headers: {
                'X-Bot-Key': key,
                'X-Api-Key': key,
            },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload?.error || response.statusText || `HTTP ${response.status}`);
        }
        renderServiceBotExplorerResult(panel, { endpoint, payload });
        showToast('Service bot data loaded');
    } catch (error) {
        renderServiceBotExplorerResult(panel, { error: error?.message || String(error) });
        showToast('Service bot API error: ' + (error?.message || error));
    } finally {
        if (submit) submit.disabled = false;
    }
}

function renderServiceBotExplorerResult(panel, statePayload) {
    const box = panel.querySelector('[data-service-bot-result]');
    if (!box) return;
    if (!statePayload) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    box.hidden = false;
    if (statePayload.loading) {
        box.innerHTML = '<p class="admin-loading">Loading read API data...</p>';
        return;
    }
    if (statePayload.error) {
        box.innerHTML = `<p class="admin-error">Read API error: ${escapeHtml(statePayload.error)}</p>`;
        return;
    }

    const payload = statePayload.payload || {};
    const meta = payload.meta || {};
    const subject = meta.subject || {};
    const range = payload.range || {};
    box.innerHTML = `
        <div class="admin-service-bot-result-head">
            <div>
                <div class="admin-service-bot-key-title">${escapeHtml(statePayload.endpoint || 'snapshot')}</div>
                <div class="admin-user-meta">
                    Trader: ${escapeHtml(subject.nick || subject.user_id || '—')}
                    ${subject.team ? ` · Team: ${escapeHtml(subject.team)}` : ''}
                    ${range.start || range.end ? ` · Range: ${escapeHtml(range.start || '')} - ${escapeHtml(range.end || '')}` : ''}
                </div>
            </div>
            <button type="button" class="btn-admin-action" data-service-bot-result-copy>Copy JSON</button>
        </div>
        <pre class="admin-service-bot-json">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    `;
    box.querySelector('[data-service-bot-result-copy]')?.addEventListener('click', async () => {
        const ok = await copyTextToClipboard(JSON.stringify(payload, null, 2));
        showToast(ok ? 'JSON copied' : 'Copy failed');
    });
}

async function loadServiceBotsList(panel) {
    const list = panel.querySelector('[data-service-bots-list]');
    if (!list) return;
    list.innerHTML = '<p class="admin-loading">Loading service bots...</p>';
    try {
        const payload = await adminApiFetch('/api/admin/service-bots');
        const bots = Array.isArray(payload.bots) ? payload.bots : [];
        if (!bots.length) {
            list.innerHTML = '<p class="admin-empty">No service bots yet.</p>';
            return;
        }
        list.innerHTML = '';
        bots.forEach((bot) => list.appendChild(buildServiceBotCard(bot, panel)));
    } catch (error) {
        list.innerHTML = `<p class="admin-error">Service bots error: ${escapeHtml(error?.message || error)}</p>`;
    }
}

function allowedEndpointsText(bot) {
    const endpoints = bot?.extra_data?.allowed_endpoints;
    return Array.isArray(endpoints) && endpoints.length ? endpoints.join(', ') : 'none';
}

function buildServiceBotCard(bot, panel) {
    const card = document.createElement('div');
    card.className = 'admin-user-card admin-service-bot-card';
    const profile = bot.profile || {};
    const enabled = bot.enabled !== false;
    const lastUsed = bot.last_used_at ? new Date(bot.last_used_at).toLocaleString() : 'never';
    card.innerHTML = `
        <div class="admin-user-head">
            <div class="admin-user-title">
                <span>${escapeHtml(bot.name || 'Service bot')}</span>
                <span class="admin-user-status ${enabled ? 'admin-user-status--active' : 'admin-user-status--blocked'}">${enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
            <div class="admin-user-meta">
                Trader: ${escapeHtml(profile.nick || bot.user_id || '-')} · Last used: ${escapeHtml(lastUsed)}
            </div>
            <div class="admin-user-meta">Allowed: ${escapeHtml(allowedEndpointsText(bot))}</div>
        </div>
        <div class="admin-user-actions">
            <button type="button" class="btn-admin-action" data-service-bot-toggle>${enabled ? 'Disable' : 'Enable'}</button>
            <button type="button" class="btn-admin-danger" data-service-bot-delete>Delete</button>
        </div>
    `;
    card.querySelector('[data-service-bot-toggle]')?.addEventListener('click', () => toggleServiceBot(bot, panel, !enabled, card));
    card.querySelector('[data-service-bot-delete]')?.addEventListener('click', () => deleteServiceBot(bot, panel, card));
    return card;
}

async function toggleServiceBot(bot, panel, enabled, card) {
    card.classList.add('admin-user-busy');
    try {
        await adminApiFetch(`/api/admin/service-bots?id=${encodeURIComponent(bot.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled }),
        });
        await loadServiceBotsList(panel);
        showToast(enabled ? 'Service bot enabled' : 'Service bot disabled');
    } catch (error) {
        showToast('Service bot error: ' + (error?.message || error));
    } finally {
        card.classList.remove('admin-user-busy');
    }
}

async function deleteServiceBot(bot, panel, card) {
    if (!confirm(`Delete service bot "${bot.name || bot.id}"?`)) return;
    card.classList.add('admin-user-busy');
    try {
        await adminApiFetch(`/api/admin/service-bots?id=${encodeURIComponent(bot.id)}`, { method: 'DELETE' });
        await loadServiceBotsList(panel);
        showToast('Service bot deleted');
    } catch (error) {
        showToast('Service bot error: ' + (error?.message || error));
    } finally {
        card.classList.remove('admin-user-busy');
    }
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
    else if (newRole === 'trader' || newRole === 'admin') patch.mentor_enabled = false;

    const { error } = await supabase.from('profiles').update(patch).eq('id', userId);

    selectEl.disabled = false;

    if (error) {
        showToast('Помилка ролі: ' + error.message);
        selectEl.value = prev;
        return;
    }

    selectEl.dataset.prevRole = newRole;
    await loadTeams();
    renderAdminPanel();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    if (window.refreshSidebarAccount) await window.refreshSidebarAccount();
    showToast('Роль оновлено');
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
