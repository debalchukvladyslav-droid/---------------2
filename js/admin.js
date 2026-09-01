// === js/admin.js ===
import { supabase, SUPABASE_URL } from './supabase.js';
import { state } from './state.js';
import { copyTextToClipboard, showToast } from './utils.js';
import { loadTeams } from './teams.js';
import { exportProfileData, resetProfileData, restoreProfileData, loadTradeDays, loadAllMonths } from './storage.js';
import { listServerBackupsForUser, readCompressedBackupEntry } from './backups.js';
import { calculatePreMarketVolume, getOrLoadPolygonDay } from './polygon_intraday_cache.js';

const ROLES = ['trader', 'mentor', 'admin'];
const DEFAULT_TEAM = 'Без куща';
let serviceBotSecretInMemory = '';
const SERVICE_BOT_DATA_ENDPOINTS = ['snapshot', 'summary', 'tickers', 'orders', 'locates'];

export async function renderAdminPanel() {
    const container = document.getElementById('admin-users-list');
    if (!container) return;

    const refreshUsersBtn = document.getElementById('admin-refresh-users-btn');
    const sessionReviewTestBtn = document.getElementById('admin-session-review-test-btn');
    const botsPanel = document.getElementById('admin-service-bots-panel');
    const fullAdmin = state.myRole === 'admin';
    if (sessionReviewTestBtn) sessionReviewTestBtn.hidden = !fullAdmin;
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
    if (fullAdmin) await renderRegistrationRequests(container);
    if (fullAdmin) renderServiceBotsPanel(profiles || []);
    visibleProfiles.forEach((p) => container.appendChild(buildUserCard(p, teamChoices, { fullAdmin, dataManager })));
}

export function renderTestingPanel() {
    const panel = document.getElementById('testing-tools-panel');
    if (!panel || state.myRole !== 'admin') return;
    panel.hidden = false;
    if (panel.dataset.initialized === 'true') {
        const polygonHost = panel.querySelector('[data-testing-polygon-host]');
        if (polygonHost) void renderPolygonAdminPanel(polygonHost);
        return;
    }
    panel.dataset.initialized = 'true';
    panel.innerHTML = `
        <div class="admin-service-bots-head">
            <div><h4 class="admin-section-title">Тестування</h4><p class="admin-section-subtitle">Ручний запуск функцій першого налаштування без скидання профілю.</p></div>
            <span class="admin-polygon-state is-active">Лише адмін</span>
        </div>
        <div class="admin-polygon-actions"><button type="button" class="btn-admin-action" data-test-auto-table>Автотаблиця</button></div>
        <p class="admin-polygon-result" data-test-auto-table-result>Шукає точне прізвище у трьох таблицях і запускає автомапінг.</p>
        <section class="admin-polygon-panel" data-testing-sheet-import-host></section>
        <section class="testing-loader-grid">
            <div class="admin-polygon-panel" data-testing-criteria-host></div>
            <div class="admin-polygon-panel" data-testing-polygon-host></div>
        </section>
        <section class="testing-analysis" aria-labelledby="testing-analysis-title">
            <div class="testing-analysis__head">
                <div><span class="admin-section-subtitle">Експериментальна аналітика</span><h4 id="testing-analysis-title" class="admin-section-title">Період аналізу</h4></div>
                <div id="testing-analysis-period" class="testing-period-picker">
                    <label><span>Від</span><input type="date" data-testing-period-from></label>
                    <label><span>До</span><input type="date" data-testing-period-to></label>
                    <button type="button" class="btn-admin-action" data-testing-analysis-run>Показати</button>
                </div>
            </div>
            <p class="testing-analysis__status" data-testing-analysis-status>Оберіть період і натисніть «Показати». Дані завантажаться тільки після натискання.</p>
            <article id="stats-best-exit-panel" class="panel stats-chart-panel-wide">
                <h3 class="stats-chart-title">Кращий вихід закритих short-угод</h3>
                <p class="stats-chart-note">Порівнює фактичний вихід із Low після входу до 12:00 NY. Polygon запускається лише кнопкою всередині блоку.</p>
                <div id="stats-best-exit-content"><div class="stats-empty-note">Аналіз ще не запущено.</div></div>
            </article>
            <article id="stats-market-criteria-panel" class="panel stats-market-criteria-panel">
                <h3 class="stats-chart-title">Результат залежно від критеріїв паперу</h3>
                <p class="stats-chart-note">Gross PnL, кількість угод, win rate і profit factor за вибраний період.</p>
                <div id="stats-market-criteria-content" class="stats-market-criteria-content"><div class="stats-empty-note">Аналіз ще не запущено.</div></div>
            </article>
        </section>`;
    renderMarketCriteriaAdminPanel(panel.querySelector('[data-testing-criteria-host]'));
    void renderPolygonAdminPanel(panel.querySelector('[data-testing-polygon-host]'));
    import('./testing_sheet_import.js').then(({ initIsolatedSheetTest }) => {
        initIsolatedSheetTest(panel.querySelector('[data-testing-sheet-import-host]'));
    }).catch((error) => console.warn('[Testing sheet import]', error));
    const button = panel.querySelector('[data-test-auto-table]');
    const result = panel.querySelector('[data-test-auto-table-result]');
    button?.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        result.textContent = 'Перевіряємо три таблиці…';
        try {
            const module = await import('./google_sheet_connector.js');
            const test = await module.autoConnectTraderSheet({ force: true });
            result.textContent = test?.ok
                ? `Готово: таблиця «${test.spreadsheetTitle || test.spreadsheetId}», лист «${test.sheetTitle}», полів ${test.mapped || 0}.`
                : `Не знайдено: ${test?.message || test?.reason || 'невідома причина'}`;
            showToast(test?.ok ? 'Автотаблиця налаштована' : result.textContent);
        } catch (error) {
            result.textContent = `Помилка: ${error?.message || error}`;
            showToast(result.textContent);
        } finally {
            button.disabled = false;
        }
    });
    const journalDates = Object.keys(state.appData?.journal || {}).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    const fromInput = panel.querySelector('[data-testing-period-from]');
    const toInput = panel.querySelector('[data-testing-period-to]');
    if (fromInput) fromInput.value = journalDates[0] || '';
    if (toInput) toInput.value = journalDates.at(-1) || '';
    panel.querySelector('[data-testing-analysis-run]')?.addEventListener('click', async (event) => {
        const runButton = event.currentTarget;
        const status = panel.querySelector('[data-testing-analysis-status]');
        runButton.disabled = true;
        if (status) status.textContent = 'Завантажуємо дані вибраного періоду…';
        try {
            await loadAllMonths(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME, state.currentViewedUserId || state.myUserId);
            const from = fromInput?.value || '';
            const to = toInput?.value || '';
            const dates = new Set(Object.keys(state.appData?.journal || {}).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && (!from || date >= from) && (!to || date <= to)));
            const label = from || to ? `${from || 'початок'} — ${to || 'сьогодні'}` : 'За весь час';
            const [{ renderBestExitAnalysis }, { renderMarketCriteriaAnalysis }] = await Promise.all([
                import('./best_exit_analysis.js'),
                import('./stats.js'),
            ]);
            await renderBestExitAnalysis({ journal: state.appData.journal || {}, periodDates: dates, sourceType: 'current', periodLabel: label });
            renderMarketCriteriaAnalysis(state.appData.journal || {}, dates, '');
            if (status) status.textContent = `Період: ${label} · днів із даними: ${dates.size}`;
        } catch (error) {
            if (status) status.textContent = `Помилка: ${error?.message || error}`;
        } finally {
            runButton.disabled = false;
        }
    });
}

function criteriaPairsFromJournal(journal = {}) {
    const pairs = new Map();
    for (const [date, day] of Object.entries(journal || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        for (const trade of Array.isArray(day?.trades) ? day.trades : []) {
            const ticker = String(trade?.symbol || trade?.ticker || '').trim().toUpperCase();
            if (!ticker) continue;
            const existing = trade?.marketCriteria || day?.tradePolygons?.[ticker];
            const key = `${date}|${ticker}`;
            const minuteMatch = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(String(trade?.opened || trade?.entryTime || trade?.time || ''));
            const entryMinute = minuteMatch ? Number(minuteMatch[1]) * 60 + Number(minuteMatch[2]) : null;
            if (!pairs.has(key)) pairs.set(key, { date, ticker, existing, entryMinutes: new Set() });
            const pair = pairs.get(key);
            if (existing) pair.existing = existing;
            if (Number.isInteger(entryMinute) && entryMinute >= 240 && entryMinute <= 720) pair.entryMinutes.add(entryMinute);
        }
    }
    return [...pairs.values()].map((pair) => ({
        ...pair,
        entryMinutes: [...pair.entryMinutes],
        loaded: !!pair.existing && [...pair.entryMinutes].every((minute) => Number.isFinite(Number(pair.existing?.vol_pre_by_minute?.[String(minute)]))),
    }));
}

async function loadCriteriaDayBars(pair, token) {
    if (!pair.entryMinutes.length) return [];
    const offsetLabel = new Date(`${pair.date}T12:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short', hour: '2-digit' });
    const offset = offsetLabel.includes('EDT') ? '-04:00' : '-05:00';
    const fromMs = new Date(`${pair.date}T04:00:00${offset}`).getTime();
    const toMs = new Date(`${pair.date}T12:01:00${offset}`).getTime();
    const edgeUrl = `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/polygon-aggs`;
    const loaded = await getOrLoadPolygonDay(pair.ticker, pair.date, async () => {
        const response = await fetch(edgeUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: pair.ticker, fromMs, toMs }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || `Market data HTTP ${response.status}`);
        return Array.isArray(payload?.results) ? payload.results : [];
    });
    return loaded.bars;
}

function renderMarketCriteriaAdminPanel(panel) {
    if (!panel) return;
    panel.innerHTML = `
        <div class="admin-service-bots-head">
            <div>
                <h4 class="admin-section-title">Критерії паперів</h4>
                <p class="admin-section-subtitle">Окремо від Polygon: за ticker + date завантажуються ATR, об’єми, VolPlay і Float. Уже заповнені пари пропускаються.</p>
            </div>
            <span class="admin-polygon-state is-active">Окремий модуль</span>
        </div>
        <div class="admin-polygon-actions"><button type="button" class="btn-admin-action" data-load-all-criteria>Завантажити всі критерії</button></div>
        <progress class="testing-job-progress" data-criteria-progress value="0" max="1"></progress>
        <p class="admin-polygon-result" data-criteria-result>Процес почнеться лише після натискання.</p>`;
    const button = panel.querySelector('[data-load-all-criteria]');
    const result = panel.querySelector('[data-criteria-result]');
    const progress = panel.querySelector('[data-criteria-progress]');
    button?.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
            result.textContent = 'Завантажую список угод…';
            await loadTradeDays(state.CURRENT_VIEWED_USER, state.myUserId);
            const all = criteriaPairsFromJournal(state.appData.journal);
            const pending = all.filter((pair) => !pair.loaded);
            progress.max = Math.max(1, pending.length);
            progress.value = 0;
            if (!pending.length) {
                progress.max = 1;
                progress.value = 1;
                result.textContent = `Готово: усі ${all.length} ticker + date вже мають критерії.`;
                return;
            }
            const { data: { session } = {} } = await supabase.auth.getSession();
            if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
            let done = 0;
            let failed = 0;
            for (const pair of pending) {
                result.textContent = `Критерії ${pair.ticker} · ${pair.date}: ${done + failed + 1} із ${pending.length}`;
                try {
                    const bars = await loadCriteriaDayBars(pair, session.access_token);
                    const volPreByMinute = Object.fromEntries(pair.entryMinutes.map((minute) => [String(minute), calculatePreMarketVolume(bars, minute)]).filter(([, value]) => value !== null));
                    const response = await fetch('/api/trade-polygons', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ticker: pair.ticker, date: pair.date, volPreByMinute }),
                    });
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
                    const day = state.appData.journal[pair.date];
                    if (day) {
                        day.tradePolygons = { ...(day.tradePolygons || {}), [pair.ticker]: payload.metrics };
                        (day.trades || []).forEach((trade) => {
                            if (String(trade?.symbol || trade?.ticker || '').trim().toUpperCase() === pair.ticker) trade.marketCriteria = payload.metrics;
                        });
                    }
                    done += 1;
                } catch (error) {
                    failed += 1;
                    console.warn('[Market criteria bulk]', pair.ticker, pair.date, error);
                }
                progress.value = done + failed;
                if (done + failed < pending.length) await new Promise((resolve) => setTimeout(resolve, 1200));
            }
            result.textContent = `Готово: завантажено ${done}, помилок ${failed}, раніше були ${all.length - pending.length}.`;
            showToast(`Критерії: завантажено ${done}`);
        } catch (error) {
            result.textContent = `Помилка: ${error?.message || error}`;
            showToast(result.textContent);
        } finally {
            button.disabled = false;
        }
    });
}

async function invokePolygonAdmin(action, extra = {}) {
    const { data, error } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (error || !token) throw new Error(error?.message || 'Auth session not found');
    const endpoint = `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/market-best-exits`;
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...extra }),
        });
    } catch (cause) {
        const requestError = new Error('Edge Function недоступна або заблокована CORS');
        requestError.status = 0;
        requestError.cause = cause;
        throw requestError;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
        const requestError = new Error(payload?.error || payload?.message || `market-best-exits HTTP ${response.status}`);
        requestError.status = response.status;
        requestError.code = payload?.code || '';
        throw requestError;
    }
    return payload || {};
}

let polygonStatusTimer = null;
let polygonTickBusy = false;
let polygonWorkerBlockedMessage = '';

function stopPolygonStatusTimer() {
    if (polygonStatusTimer) clearInterval(polygonStatusTimer);
    polygonStatusTimer = null;
}

function polygonWorkerErrorMessage(error) {
    const status = Number(error?.status) || 0;
    if (status === 400) return 'Функція market-best-exits на сервері не підтримує фонову чергу. Задеплойте актуальну версію, потім натисніть «Оновити статус».';
    if (!status) return 'market-best-exits недоступна або має помилку CORS. Фонову чергу зупинено, щоб не перевантажувати сервер.';
    if ([401, 403].includes(status)) return `Немає доступу до market-best-exits (HTTP ${status}). Фонову чергу зупинено.`;
    return String(error?.message || error || `market-best-exits HTTP ${status}`);
}

function ensurePolygonStatusTimer() {
    if (polygonStatusTimer || polygonWorkerBlockedMessage) return;
    polygonStatusTimer = setInterval(async () => {
        const host = document.querySelector('[data-testing-polygon-host]');
        if (!host || !state.USER_DOC_NAME || polygonTickBusy) return;
        polygonTickBusy = true;
        try {
            await invokePolygonAdmin('admin-process-next');
            await renderPolygonAdminPanel(host);
        } catch (error) {
            polygonWorkerBlockedMessage = polygonWorkerErrorMessage(error);
            stopPolygonStatusTimer();
            console.warn('[Polygon background queue stopped]', polygonWorkerBlockedMessage, error);
            const result = host.querySelector('[data-polygon-result]');
            if (result) {
                result.textContent = polygonWorkerBlockedMessage;
                result.classList.add('admin-error');
            }
        } finally {
            polygonTickBusy = false;
        }
    }, 13000);
}

async function renderPolygonAdminPanel(targetPanel = null) {
    const panel = targetPanel || document.querySelector('[data-testing-polygon-host]');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<p class="admin-loading">Перевірка Polygon…</p>';
    try {
        const status = await invokePolygonAdmin('admin-status');
        const paused = status.paused === true;
        const pending = Number(status.counts?.pending) || 0;
        const processing = Number(status.counts?.processing) || 0;
        const ready = Number(status.counts?.ready) || 0;
        const failed = Number(status.counts?.failed) || 0;
        if (!pending && !processing && !failed) stopPolygonStatusTimer();
        // Перегляд панелі та імпорт Trades не запускають Polygon. Обробник
        // стартує лише після ручної кнопки «Завантажити всі полігони».
        panel.innerHTML = `
            <div class="admin-service-bots-head">
                <div>
                    <h4 class="admin-section-title">Polygon · архів графіків</h4>
                    <p class="admin-section-subtitle">Уже збережені ticker + date повторно не завантажуються. Пауза блокує тільки нові запити до Polygon, кеш Supabase залишається доступним.</p>
                </div>
                <span class="admin-polygon-state ${paused ? 'is-paused' : 'is-active'}">${paused ? 'Зупинено' : 'Працює'}</span>
            </div>
            <div class="admin-polygon-counts">
                <span>У черзі <strong>${pending}</strong></span><span>Обробляється <strong>${processing}</strong></span><span>Готово <strong>${ready}</strong></span><span>Помилки <strong>${failed}</strong></span>
            </div>
            <progress class="testing-job-progress" value="${ready}" max="${Math.max(1, pending + processing + ready + failed)}"></progress>
            <p class="admin-polygon-result${polygonWorkerBlockedMessage ? ' admin-error' : ''}" data-polygon-result>${escapeHtml(polygonWorkerBlockedMessage || `Виконано ${ready} · залишилось ${pending + processing} · помилок ${failed}`)}</p>
            <div class="admin-polygon-actions">
                <button type="button" class="${paused ? 'btn-admin-action' : 'btn-admin-danger'}" data-polygon-pause>${paused ? 'Продовжити Polygon' : 'Зупинити Polygon'}</button>
                <button type="button" class="btn-admin-action" data-polygon-enqueue>Завантажити всі полігони</button>
                <button type="button" class="btn-admin-action" data-polygon-refresh>Оновити статус</button>
            </div>`;
        const result = panel.querySelector('[data-polygon-result]');
        const run = async (button, task) => {
            panel.querySelectorAll('button').forEach((item) => { item.disabled = true; });
            if (result) result.textContent = 'Виконується…';
            try { await task(); }
            catch (error) { showToast(`Polygon: ${error?.message || error}`); if (result) result.textContent = `Помилка: ${error?.message || error}`; }
            finally { if (button?.isConnected) button.disabled = false; }
        };
        panel.querySelector('[data-polygon-pause]')?.addEventListener('click', (event) => run(event.currentTarget, async () => {
            await invokePolygonAdmin('admin-pause', { paused: !paused });
            showToast(paused ? 'Polygon продовжено' : 'Нові запити Polygon зупинено');
            await renderPolygonAdminPanel(panel);
        }));
        panel.querySelector('[data-polygon-enqueue]')?.addEventListener('click', (event) => run(event.currentTarget, async () => {
            const queued = await invokePolygonAdmin('admin-enqueue-all');
            polygonWorkerBlockedMessage = '';
            showToast(`Polygon запущено: у чергу додано ${Number(queued.queued) || 0}`);
            if (result) result.textContent = `Polygon запущено · Trades: ${Number(queued.total) || 0} · вже були: ${Number(queued.archived) || 0} · додано: ${Number(queued.queued) || 0}`;
            ensurePolygonStatusTimer();
            setTimeout(() => renderPolygonAdminPanel(panel), 1200);
        }));
        panel.querySelector('[data-polygon-refresh]')?.addEventListener('click', () => {
            polygonWorkerBlockedMessage = '';
            renderPolygonAdminPanel(panel);
        });
    } catch (error) {
        panel.innerHTML = `<p class="admin-error">Polygon: ${escapeHtml(error?.message || error)}</p>`;
    }
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

async function renderRegistrationRequests(container) {
    let requests = [];
    try {
        const payload = await adminApiFetch('/api/admin/registration-requests');
        requests = Array.isArray(payload.requests) ? payload.requests : [];
    } catch (error) {
        const message = document.createElement('p');
        message.className = 'admin-error';
        message.textContent = `Заявки на реєстрацію: ${error?.message || error}`;
        container.appendChild(message);
        return;
    }
    if (!requests.length) return;

    const title = document.createElement('h3');
    title.className = 'admin-section-title';
    title.textContent = `Очікують схвалення (${requests.length})`;
    container.appendChild(title);

    requests.forEach((profile) => {
        const registration = profile.settings?.registration_request || {};
        const card = document.createElement('div');
        card.className = 'admin-user-card';
        const location = [registration.city, registration.region, registration.country].filter(Boolean).join(', ') || 'Невідомо';
        card.innerHTML = `
            <div class="admin-user-head">
                <div class="admin-user-title"><span>${escapeHtml(profile.nick || profile.email || profile.id)}</span></div>
                <div class="admin-user-meta">${escapeHtml([profile.first_name, profile.last_name].filter(Boolean).join(' ') || '—')} · ${escapeHtml(profile.email || '—')}</div>
                <div class="admin-user-meta">Команда: ${escapeHtml(profile.team || '—')}</div>
                <div class="admin-user-meta">IP: ${escapeHtml(registration.ip || 'Невідомо')} · ${escapeHtml(location)}</div>
                <div class="admin-user-meta">Заявка: ${escapeHtml(registration.requested_at ? new Date(registration.requested_at).toLocaleString() : 'після підтвердження email')}</div>
            </div>
            <div class="admin-user-actions">
                <button type="button" class="btn-admin-action" data-registration-approve>Схвалити</button>
                <button type="button" class="btn-admin-danger" data-registration-reject>Відхилити</button>
            </div>
        `;
        const decide = async (action) => {
            card.classList.add('admin-user-busy');
            try {
                await adminApiFetch('/api/admin/registration-requests', {
                    method: 'PATCH',
                    body: JSON.stringify({ user_id: profile.id, action }),
                });
                showToast(action === 'approve' ? 'Акаунт схвалено' : 'Заявку відхилено');
                await renderAdminPanel();
            } catch (error) {
                card.classList.remove('admin-user-busy');
                showToast(`Помилка: ${error?.message || error}`);
            }
        };
        card.querySelector('[data-registration-approve]')?.addEventListener('click', () => decide('approve'));
        card.querySelector('[data-registration-reject]')?.addEventListener('click', () => decide('reject'));
        container.appendChild(card);
    });
}

function renderServiceBotsPanel(profiles = []) {
    const panel = document.getElementById('admin-service-bots-panel');
    if (!panel) return;
    panel.hidden = false;
    const traders = profiles.filter((profile) => profile?.id);
    const defaultRange = getDefaultAdminPproRange();
    panel.innerHTML = `
        <div class="admin-service-bots-head">
            <div>
                <h4 class="admin-section-title">Service bots</h4>
                <p class="admin-section-subtitle">Read-only API keys for external bots. Ключ з інструкції спочатку зареєструй тут у полі Existing secret key.</p>
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
                    <option value="__all_traders__">All traders</option>
                    ${traders.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.nick || profile.email || profile.id)}</option>`).join('')}
                </select>
            </label>
            <label class="admin-field">
                <span class="admin-label">Existing secret key</span>
                <input class="admin-input" name="secret_key" type="password" autocomplete="off" spellcheck="false" placeholder="optional">
            </label>
            <label class="admin-field">
                <span class="admin-label">Data source</span>
                <select class="admin-select" name="data_source">
                    <option value="ppro">PPRO</option>
                    <option value="all">All journal data</option>
                    <option value="fondexx">Fondexx</option>
                </select>
            </label>
            <button type="submit" class="btn-admin-action">Create key</button>
        </form>
        <div class="admin-service-bot-key" data-service-bot-key hidden></div>
        <div class="admin-ppro-viewer" data-admin-ppro-viewer>
            <div class="admin-service-bots-head">
                <div>
                    <h4 class="admin-section-title">External PPRO bot API check</h4>
                    <p class="admin-section-subtitle">Ізольована перевірка зовнішнього API бота: не читає ручні імпорти сайту і не прив'язує трейдерів до profiles.</p>
                </div>
            </div>
            <form class="admin-ppro-form" data-admin-ppro-form>
                <label class="admin-field admin-field-wide">
                    <span class="admin-label">External API URL</span>
                    <input class="admin-input" name="url" type="url" placeholder="https://.../api/...">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Auth header</span>
                    <input class="admin-input" name="auth_header" type="text" value="X-Api-Key">
                </label>
                <label class="admin-field">
                    <span class="admin-label">API key</span>
                    <input class="admin-input" name="api_key" type="password" autocomplete="off" spellcheck="false">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Start</span>
                    <input class="admin-input" name="start" type="date" value="${escapeHtml(defaultRange.start)}">
                </label>
                <label class="admin-field">
                    <span class="admin-label">End</span>
                    <input class="admin-input" name="end" type="date" value="${escapeHtml(defaultRange.end)}">
                </label>
                <label class="admin-field">
                    <span class="admin-label">Limit</span>
                    <input class="admin-input" name="limit" type="number" min="1" max="1000" value="300">
                </label>
                <button type="submit" class="btn-admin-action">Load PPRO</button>
            </form>
            <div class="admin-ppro-result" data-admin-ppro-result hidden></div>
        </div>
        <div class="admin-service-bot-explorer" data-service-bot-explorer>
            <div class="admin-service-bots-head">
                <div>
                    <h4 class="admin-section-title">Service bot data explorer</h4>
                    <p class="admin-section-subtitle">Тестує вже зареєстрований ключ з таблиці bots. Якщо ключ ще не створений вище, тут буде 401.</p>
                </div>
                <button type="button" class="btn-admin-action" data-service-bot-secret-clear>Clear key</button>
            </div>
            <form class="admin-service-bot-query" data-service-bot-query-form>
                <label class="admin-field">
                    <span class="admin-label">Saved bot key</span>
                    <select class="admin-select" name="bot_id" data-service-bot-explorer-select>
                        <option value="">Manual key</option>
                    </select>
                </label>
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
                    <button type="button" class="btn-admin-action" data-service-bot-secret-save>Keep for this tab</button>
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
    bindAdminPproViewer(panel);
    bindServiceBotExplorer(panel);
    loadServiceBotsList(panel);
}

function getDefaultAdminPproRange() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);
    const fmt = (date) => date.toISOString().slice(0, 10);
    return { start: fmt(start), end: fmt(end) };
}

function pproSourceHasData(ppro = {}) {
    return !!(
        Number(ppro?.gross)
        || Number(ppro?.net)
        || Number(ppro?.comm)
        || Number(ppro?.locates)
        || (Array.isArray(ppro?.tickers) && ppro.tickers.length)
    );
}

function splitAdminPproValue(value, count) {
    const n = Number(value) || 0;
    const c = Math.max(1, count || 1);
    return Number((n / c).toFixed(2));
}

function profileName(profile) {
    return profile?.nick || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || profile?.email || profile?.id || '';
}

function buildAdminPproRows(rows = [], profiles = []) {
    const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
    const out = [];
    (rows || []).forEach((row) => {
        const metrics = row?.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
        const ppro = metrics.ppro && typeof metrics.ppro === 'object' ? metrics.ppro : {};
        if (!pproSourceHasData(ppro)) return;
        const tickers = Array.isArray(ppro.tickers)
            ? [...new Set(ppro.tickers.map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
            : [];
        const symbols = tickers.length ? tickers : ['PPRO_TOTAL'];
        const profile = profileMap.get(row.user_id) || {};
        symbols.forEach((symbol) => {
            out.push({
                date: row.trade_date || '',
                user_id: row.user_id || '',
                trader: profileName(profile) || row.user_id || '—',
                team: profile.team || '',
                symbol,
                gross: splitAdminPproValue(ppro.gross, symbols.length),
                pnl: splitAdminPproValue(ppro.net, symbols.length),
                commissions: splitAdminPproValue(ppro.comm, symbols.length),
                locates: splitAdminPproValue(ppro.locates, symbols.length),
                source: metrics.pproSource || 'daily_metrics.ppro',
            });
        });
    });
    return out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.trader).localeCompare(String(b.trader)));
}

function bindAdminPproViewer(panel) {
    const form = panel.querySelector('[data-admin-ppro-form]');
    if (!form) return;
    form.addEventListener('submit', (event) => loadAdminPproData(event, panel));
}

async function loadAdminPproData(event, panel) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const url = String(formData.get('url') || '').trim();
    const apiKey = String(formData.get('api_key') || '').trim();
    const authHeader = String(formData.get('auth_header') || 'X-Api-Key').trim();
    const start = String(formData.get('start') || '').trim();
    const end = String(formData.get('end') || '').trim();
    const limit = Math.max(1, Math.min(1000, Number(formData.get('limit')) || 300));
    const result = panel.querySelector('[data-admin-ppro-result]');
    const submit = form.querySelector('button[type="submit"]');
    if (!result) return;
    if (!url) {
        showToast('Встав External API URL');
        return;
    }
    result.hidden = false;
    result.innerHTML = '<p class="admin-loading">Loading external PPRO API...</p>';
    if (submit) submit.disabled = true;
    try {
        const payload = await adminApiFetch('/api/admin/service-bots', {
            method: 'POST',
            body: JSON.stringify({
                action: 'external_ppro_probe',
                url,
                api_key: apiKey,
                auth_header: authHeader,
                start,
                end,
                limit,
            }),
        });
        renderAdminPproResult(result, payload.items || [], { start, end, raw: payload.payload, sourceUrl: payload.source_url, status: payload.status });
    } catch (error) {
        result.innerHTML = `<p class="admin-error">External PPRO API error: ${escapeHtml(error?.message || error)}</p>`;
    } finally {
        if (submit) submit.disabled = false;
    }
}

function renderAdminPproResult(container, rows = [], range = {}) {
    if (!rows.length) {
        container.innerHTML = `
            <p class="admin-empty">Зовнішній PPRO API не повернув масив угод/входів у відомих полях data/items/orders/trades/positions/fills/rows/results.</p>
            ${range.raw ? `<pre class="admin-service-bot-json">${escapeHtml(JSON.stringify(range.raw, null, 2))}</pre>` : ''}
        `;
        return;
    }
    const totalPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
    const totalGross = rows.reduce((sum, row) => sum + row.gross, 0);
    const totalCommissions = rows.reduce((sum, row) => sum + row.commissions, 0);
    const totalLocates = rows.reduce((sum, row) => sum + row.locates, 0);
    const exportPayload = { items: rows, raw: range.raw || null };
    const json = JSON.stringify(exportPayload, null, 2);
    container.innerHTML = `
        <div class="admin-service-bot-result-head">
            <div>
                <div class="admin-service-bot-key-title">External PPRO rows</div>
                <div class="admin-user-meta">
                    ${rows.length} entries · PnL ${escapeHtml(formatAdminMoney(totalPnl))} · Gross ${escapeHtml(formatAdminMoney(totalGross))} · Comm ${escapeHtml(formatAdminMoney(totalCommissions))} · Locates ${escapeHtml(formatAdminMoney(totalLocates))}
                    ${range.sourceUrl ? ` · Source: ${escapeHtml(range.sourceUrl)}` : ''}
                    ${range.start || range.end ? ` · Range: ${escapeHtml(range.start || '')} - ${escapeHtml(range.end || '')}` : ''}
                </div>
            </div>
            <button type="button" class="btn-admin-action" data-admin-ppro-copy>Copy JSON</button>
        </div>
        <div class="admin-service-bot-table-wrap">
            <table class="admin-service-bot-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Trader</th>
                        <th>Team</th>
                        <th>Entry/Ticker</th>
                        <th>Side</th>
                        <th>Qty</th>
                        <th>Entry Price</th>
                        <th>PnL</th>
                        <th>Gross</th>
                        <th>Commissions</th>
                        <th>Locates</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((row) => `
                        <tr>
                            <td>${escapeHtml(row.date)}</td>
                            <td>${escapeHtml(row.trader)}</td>
                            <td>${escapeHtml(row.team || '—')}</td>
                            <td><strong>${escapeHtml(row.symbol)}</strong></td>
                            <td>${escapeHtml(row.side || '—')}</td>
                            <td>${escapeHtml(String(row.qty || 0))}</td>
                            <td>${escapeHtml(formatAdminMoney(row.entry_price))}</td>
                            <td class="${row.pnl >= 0 ? 'text-profit' : 'text-loss'}">${escapeHtml(formatAdminMoney(row.pnl))}</td>
                            <td>${escapeHtml(formatAdminMoney(row.gross))}</td>
                            <td>${escapeHtml(formatAdminMoney(row.commissions))}</td>
                            <td>${escapeHtml(formatAdminMoney(row.locates))}</td>
                            <td>${escapeHtml(row.status || '—')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        <pre class="admin-service-bot-json">${escapeHtml(JSON.stringify(range.raw || {}, null, 2))}</pre>
    `;
    container.querySelector('[data-admin-ppro-copy]')?.addEventListener('click', async () => {
        const ok = await copyTextToClipboard(json);
        showToast(ok ? 'PPRO JSON copied' : 'Copy failed');
    });
}

async function createServiceBot(event, panel) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const body = {
        name: String(formData.get('name') || '').trim(),
        user_id: String(formData.get('user_id') || '').trim(),
        all_traders: String(formData.get('user_id') || '').trim() === '__all_traders__',
        secret_key: String(formData.get('secret_key') || '').trim(),
        data_source: String(formData.get('data_source') || 'ppro').trim(),
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
        setServiceBotExplorerKey(panel, payload.api_key, { persist: true });
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

function setServiceBotExplorerKey(panel, apiKey, options = {}) {
    const key = String(apiKey || '').trim();
    if (!key) return;
    const keyInput = panel.querySelector('[data-service-bot-query-form] [name="secret_key"]');
    if (keyInput) keyInput.value = key;
    if (options.persist) serviceBotSecretInMemory = key;
}

function bindServiceBotExplorer(panel) {
    const form = panel.querySelector('[data-service-bot-query-form]');
    const keyInput = form?.elements?.secret_key;
    if (!form || !keyInput) return;

    keyInput.value = serviceBotSecretInMemory;
    panel.querySelector('[data-service-bot-secret-save]')?.addEventListener('click', () => {
        const key = String(keyInput.value || '').trim();
        if (!key) {
            showToast('Встав secret/API key');
            return;
        }
        serviceBotSecretInMemory = key;
        showToast('Secret key kept only until this page is closed');
    });
    panel.querySelector('[data-service-bot-secret-clear]')?.addEventListener('click', () => {
        serviceBotSecretInMemory = '';
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
    const botId = String(formData.get('bot_id') || '').trim();
    const endpoint = SERVICE_BOT_DATA_ENDPOINTS.includes(String(formData.get('endpoint')))
        ? String(formData.get('endpoint'))
        : 'snapshot';
    if (!key && !botId) {
        showToast('Вибери saved bot key або встав secret/API key');
        return;
    }

    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    renderServiceBotExplorerResult(panel, { loading: true });
    try {
        const params = serviceBotQueryParams(formData);
        let payload = null;
        if (botId) {
            params.set('endpoint', endpoint);
            payload = await adminApiFetch(`/api/admin/service-bots?id=${encodeURIComponent(botId)}&data=1&${params}`);
        } else {
            const url = `/api/service-bots/${encodeURIComponent(endpoint)}${params.toString() ? `?${params}` : ''}`;
            const response = await fetch(url, {
                headers: {
                    'X-Bot-Key': key,
                    'X-Api-Key': key,
                },
            });
            payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('401: secret/API key is missing or invalid. Create a service bot key and paste the full shs_service_... value.');
                }
                if (response.status === 403) {
                    throw new Error('403: this bot is disabled, not service type, or has no api_service_snapshot_read permission.');
                }
                throw new Error(payload?.error || response.statusText || `HTTP ${response.status}`);
            }
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
    const trades = serviceBotPayloadToTrades(payload);
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
        ${renderServiceBotTrades(trades)}
        <pre class="admin-service-bot-json">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    `;
    box.querySelector('[data-service-bot-result-copy]')?.addEventListener('click', async () => {
        const ok = await copyTextToClipboard(JSON.stringify(payload, null, 2));
        showToast(ok ? 'JSON copied' : 'Copy failed');
    });
}

function serviceBotPayloadToTrades(payload = {}) {
    const items = Array.isArray(payload?.orders?.items)
        ? payload.orders.items
        : Array.isArray(payload?.items)
            ? payload.items
            : [];
    return items.map((item) => ({
        date: item.date || '',
        trader: item.trader?.nick || item.trader?.id || item.user_id || '',
        team: item.trader?.team || '',
        opened: item.opened || '',
        closed: item.closed || '',
        symbol: item.symbol || '',
        side: item.type || '',
        qty: Number(item.qty) || 0,
        gross: Number(item.gross) || 0,
        comm: Number(item.comm) || 0,
        net: Number(item.net) || 0,
        exchange: item.exchange || '',
        status: item.status || 'filled',
        demo: item.demo === true,
        derived: item.derived === true,
        derivedSource: item.derived_source || '',
    }));
}

function formatAdminMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toFixed(2);
}

function renderServiceBotTrades(trades = []) {
    if (!trades.length) {
        return `
            <div class="admin-service-bot-trades">
                <div class="admin-service-bot-key-title">Угоди</div>
                <p class="admin-empty">За цей діапазон API не повернув угод. Перевір, чи в journal_days.daily_metrics.trades є реальні Trades, а не тільки Google Sheet rows.</p>
            </div>
        `;
    }

    const totalQty = trades.reduce((sum, trade) => sum + trade.qty, 0);
    const totalNet = trades.reduce((sum, trade) => sum + trade.net, 0);
    const demoCount = trades.filter((trade) => trade.demo).length;
    const rows = trades.map((trade) => `
        <tr>
            <td>${escapeHtml(trade.date)}</td>
            <td>${escapeHtml(trade.trader || '—')}</td>
            <td>${escapeHtml(trade.opened || trade.closed || '')}</td>
            <td><strong>${escapeHtml(trade.symbol || '—')}</strong></td>
            <td>${escapeHtml(trade.side || '—')}</td>
            <td>${escapeHtml(String(trade.qty || 0))}</td>
            <td class="${trade.net >= 0 ? 'text-profit' : 'text-loss'}">${escapeHtml(formatAdminMoney(trade.net))}</td>
            <td>${escapeHtml(formatAdminMoney(trade.gross))}</td>
            <td>${escapeHtml(formatAdminMoney(trade.comm))}</td>
            <td>${escapeHtml(trade.exchange || '—')}</td>
            <td>${escapeHtml(trade.derived ? `derived ${trade.derivedSource || ''}` : (trade.demo ? 'demo' : trade.status || 'filled'))}</td>
        </tr>
    `).join('');

    return `
        <div class="admin-service-bot-trades">
            <div class="admin-service-bot-result-head">
                <div>
                    <div class="admin-service-bot-key-title">Угоди</div>
                    <div class="admin-user-meta">${trades.length} rows · Qty ${escapeHtml(String(totalQty))} · Net ${escapeHtml(formatAdminMoney(totalNet))} · Demo ${escapeHtml(String(demoCount))}</div>
                </div>
            </div>
            <div class="admin-service-bot-table-wrap">
                <table class="admin-service-bot-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Trader</th>
                            <th>Opened</th>
                            <th>Ticker</th>
                            <th>Side</th>
                            <th>Qty</th>
                            <th>Net</th>
                            <th>Gross</th>
                            <th>Comm</th>
                            <th>Exchange</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
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
        renderServiceBotExplorerOptions(panel, bots);
    } catch (error) {
        list.innerHTML = `<p class="admin-error">Service bots error: ${escapeHtml(error?.message || error)}</p>`;
    }
}

function renderServiceBotExplorerOptions(panel, bots = []) {
    const select = panel.querySelector('[data-service-bot-explorer-select]');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = [
        '<option value="">Manual key</option>',
        ...bots.map((bot) => {
            const profile = bot.profile || {};
            const scope = bot.user_id ? (profile.nick || bot.user_id || 'Trader') : 'All traders';
            const source = bot.extra_data?.data_source || 'all';
            return `<option value="${escapeHtml(String(bot.id))}">${escapeHtml(bot.name || 'Service bot')} · ${escapeHtml(scope)} · ${escapeHtml(String(source).toUpperCase())}</option>`;
        }),
    ].join('');
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
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
    const traderLabel = bot.user_id ? (profile.nick || bot.user_id || '-') : 'All traders';
    const sourceLabel = bot.extra_data?.data_source || 'all';
    card.innerHTML = `
        <div class="admin-user-head">
            <div class="admin-user-title">
                <span>${escapeHtml(bot.name || 'Service bot')}</span>
                <span class="admin-user-status ${enabled ? 'admin-user-status--active' : 'admin-user-status--blocked'}">${enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
            <div class="admin-user-meta">
                Trader: ${escapeHtml(traderLabel)} · Last used: ${escapeHtml(lastUsed)}
            </div>
            <div class="admin-user-meta">Allowed: ${escapeHtml(allowedEndpointsText(bot))}</div>
            <div class="admin-user-meta">Source: ${escapeHtml(String(sourceLabel).toUpperCase())}</div>
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
    if (fullAdmin) card.appendChild(buildAdminBackupPanel(profile, card));
    return card;
}

function formatAdminBackupDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'невідома дата' : date.toLocaleString('uk-UA');
}

function buildAdminBackupPanel(profile, card) {
    const panel = document.createElement('div');
    panel.className = 'admin-backup-panel';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn-admin-action';
    toggle.textContent = 'Показати бекапи';
    const list = document.createElement('div');
    list.className = 'settings-backup-list';
    list.hidden = true;
    let visibleCount = 4;

    const load = async () => {
        list.innerHTML = '<p class="settings-copy-sm">Завантаження…</p>';
        try {
            const backups = await listServerBackupsForUser(profile.id, 12);
            const visible = backups.slice(0, visibleCount);
            if (!visible.length) {
                list.innerHTML = '<p class="settings-copy-sm">Серверних бекапів ще немає.</p>';
                return;
            }
            list.innerHTML = visible.map((backup, index) => `
                <article class="settings-backup-item">
                    <div class="settings-backup-meta">
                        <div class="settings-backup-name">${escapeHtml(formatAdminBackupDate(backup.createdAt))} · ${escapeHtml(backup.reason || 'backup')}</div>
                        <div class="settings-backup-sub">${Number(backup.days) || 0} днів · сервер</div>
                    </div>
                    <div class="settings-backup-actions">
                        <button type="button" class="btn-admin-action" data-admin-backup-index="${index}">Відновити</button>
                    </div>
                </article>
            `).join('');
            list.querySelectorAll('[data-admin-backup-index]').forEach((button) => {
                button.addEventListener('click', () => adminRestoreBackup(profile, visible[Number(button.dataset.adminBackupIndex)], card));
            });
            if (visibleCount < backups.length) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'btn-admin-action settings-backup-more';
                more.textContent = 'Показати ще';
                more.addEventListener('click', () => {
                    visibleCount += 4;
                    void load();
                });
                list.appendChild(more);
            }
        } catch (error) {
            list.innerHTML = `<p class="admin-error">Не вдалося завантажити бекапи: ${escapeHtml(error?.message || error)}</p>`;
        }
    };

    toggle.addEventListener('click', () => {
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden ? 'Показати бекапи' : 'Сховати бекапи';
        if (!list.hidden) {
            visibleCount = 4;
            void load();
        }
    });
    panel.append(toggle, list);
    return panel;
}

async function adminRestoreBackup(profile, backup, card) {
    if (!backup) return;
    const confirmed = confirm(`Відновити профіль «${profile.nick || profile.email || profile.id}» з бекапу від ${formatAdminBackupDate(backup.createdAt)}? Поточний журнал буде замінено.`);
    if (!confirmed) return;
    card?.classList.add('admin-user-busy');
    try {
        const { payload } = await readCompressedBackupEntry(backup);
        await restoreProfileData(profile.id, payload.appData, profile.nick);
        showToast(`Профіль «${profile.nick || profile.email}» відновлено`);
    } catch (error) {
        showToast('Помилка відновлення: ' + (error?.message || error));
    } finally {
        card?.classList.remove('admin-user-busy');
    }
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
