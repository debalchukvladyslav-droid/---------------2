import { state } from './state.js';
import { callGemini, getGeminiKeys } from './ai.js';
import { buildTradeTypeAIContext } from './trade_type_analysis.js';
import { saveSettings } from './storage.js';
import { getDashboardTeamMomentum } from './stats.js';

const CACHE_MS = 6 * 60 * 60 * 1000;
let busy = false;
let teamMomentumCache = { at: 0, rows: [] };
let carouselItems = [];
let carouselIndex = 0;
let carouselTimer = null;
let mentorBusy = false;
let mentorAllItems = [];

function pnlOf(day) {
    for (const value of [day?.fondexx?.pnl, day?.ppro?.pnl, day?.pnl]) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function recentDays() {
    return Object.entries(state.appData?.journal || {})
        .filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && pnlOf(day) !== null)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 20)
        .map(([date, day]) => ({ date, day, pnl: pnlOf(day) }));
}

function signature(days) {
    return days.map(({ date, day, pnl }) => `${date}:${pnl}:${day?.trades?.length || 0}:${day?.errors?.length || 0}`).join('|');
}

function snapshot(days) {
    const latest = days[0] || null;
    const five = days.slice(0, 5);
    const total5 = five.reduce((sum, item) => sum + item.pnl, 0);
    const wins5 = five.filter((item) => item.pnl > 0).length;
    const worst = days.reduce((current, item) => !current || item.pnl < current.pnl ? item : current, null);
    let lossStreak = 0;
    for (const item of days) { if (item.pnl >= 0) break; lossStreak++; }
    const errors = new Map();
    days.slice(0, 10).forEach(({ day }) => (day?.errors || []).forEach((value) => {
        const key = String(value || '').trim();
        if (key) errors.set(key, (errors.get(key) || 0) + 1);
    }));
    const commonError = [...errors.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    const month = latest?.date?.slice(0, 7) || '';
    const settings = state.appData?.settings || {};
    const limit = Number(settings.monthlyDayloss?.[month] ?? settings.defaultDayloss ?? -100);
    const allDays = Object.entries(state.appData?.journal || {})
        .filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && pnlOf(day) !== null)
        .map(([date, day]) => ({ date, day, pnl: pnlOf(day) }))
        .sort((a, b) => b.pnl - a.pnl);
    const strongDays = allDays.slice(0, 5);
    const strongNotes = strongDays.map((item) => ({ date: item.date, pnl: item.pnl, note: String(item.day?.notes || '').trim().slice(0, 240) })).filter((item) => item.note);
    return { latest, five, total5, wins5, worst, lossStreak, commonError, limit, bigLoss: !!worst && worst.pnl <= limit, strongDays, strongNotes };
}

function historicalItem(data) {
    const example = data.strongNotes?.[0];
    if (example) return { tone: 'good', title: `Згадайте сильний день ${example.date}`, text: `Тоді було ${example.pnl >= 0 ? '+' : ''}${example.pnl.toFixed(2)}$. Із вашого запису: «${example.note}»`, action: 'calendar', actionLabel: 'Переглянути календар' };
    const best = data.strongDays?.[0];
    if (best) return { tone: 'good', title: 'Порівняйте зі своїм сильним днем', text: `${best.date} ви закрили з результатом ${best.pnl >= 0 ? '+' : ''}${best.pnl.toFixed(2)}$. Перегляньте ті входи й умови, які тоді працювали.`, action: 'calendar', actionLabel: 'Знайти цей день' };
    return null;
}

async function teamMomentum() {
    if (Date.now() - teamMomentumCache.at < 30 * 60 * 1000) return teamMomentumCache.rows;
    const rows = await getDashboardTeamMomentum(3).catch(() => []);
    teamMomentumCache = { at: Date.now(), rows };
    return rows;
}

function withTeamMomentum(brief, rows) {
    if (!rows?.length || brief.level === 'risk' || !isRelevantMoment('stats')) return brief;
    const trader = rows[0];
    const item = { tone: 'info', title: `Зверніть увагу на ${trader.name}`, text: `За останні дні трейдер рухається стабільно: ${trader.recentPnl >= 0 ? '+' : ''}${trader.recentPnl.toFixed(2)}$, зелених днів близько ${trader.winrate.toFixed(0)}%. Можна подивитися його входи в режимі порівняння.`, action: 'stats', actionLabel: 'Відкрити порівняння', compareTrader: trader.nick };
    return { ...brief, items: [...brief.items, item].slice(-4) };
}

function getActivityProfile() {
    try { return JSON.parse(localStorage.getItem('trader_workspace_activity_v1') || '{}'); }
    catch { return {}; }
}

function isRelevantMoment(tab) {
    const activity = getActivityProfile();
    const now = new Date();
    const bucket = `${now.getDay()}-${now.getHours()}`;
    const exact = Number(activity.patterns?.[`${bucket}|${tab}`] || 0);
    const sortedTabs = Object.entries(activity.tabs || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
    const favourite = sortedTabs[0]?.[0] || '';
    if (exact >= 2 || activity.lastTab === tab || favourite === tab) return true;
    const totalSamples = sortedTabs.reduce((sum, [, count]) => sum + Number(count || 0), 0);
    return totalSamples < 5 && tab === 'stats' && now.getHours() >= 16;
}

function fallbackBrief(data) {
    if (!data.latest) return { level: 'neutral', status: 'Мало даних', summary: 'Синхронізуйте кілька торгових днів — тоді помічник оцінить входи, ризик і стабільність.', items: [{ tone: 'info', title: 'Потрібні дані', text: 'Імпортуйте Trades і Google Sheets та відмічайте помилки після сесії.' }] };
    const risk = data.bigLoss || data.lossStreak >= 3;
    const attention = !risk && (data.total5 < 0 || data.commonError?.[1] >= 2);
    const level = risk ? 'risk' : attention ? 'attention' : 'good';
    const items = [];
    if (data.bigLoss) items.push({ tone: 'risk', title: 'Великий мінус', text: `${data.worst.date}: ${data.worst.pnl.toFixed(2)}$. Це нижче дейлосу ${data.limit.toFixed(0)}$ — перегляньте розмір позиції та виконання стопа.` });
    else items.push({ tone: data.total5 >= 0 ? 'good' : 'warn', title: 'Останні 5 днів', text: `${data.total5 >= 0 ? '+' : ''}${data.total5.toFixed(2)}$, зелених днів ${data.wins5} із ${data.five.length}.` });
    if (data.commonError) items.push({ tone: 'warn', title: 'Повторювана помилка', text: `«${data.commonError[0]}» відмічено ${data.commonError[1]} раз(и). Перевірте її перед наступним входом.` });
    items.push(level === 'good'
        ? { tone: 'good', title: 'Що робити', text: 'Продовжуйте той самий процес без збільшення ризику. Не змінюйте робочу систему після короткої зеленої серії.' }
        : level === 'risk'
            ? { tone: 'risk', title: 'Що робити', text: 'Зменште робочий ризик і не намагайтеся відіграти мінус. Спершу проведіть чисту сесію без порушень.' }
            : { tone: 'info', title: 'Що робити', text: 'Оберіть один обов’язковий фільтр входу й не форсуйте посередні сетапи наступної сесії.' });
    return {
        level,
        status: risk ? 'Зменшити ризик' : attention ? 'Потрібна увага' : 'Все стабільно',
        summary: risk ? 'Є ризиковий сигнал. Зараз важливіше захистити капітал і переглянути виконання, ніж відігруватися.' : attention ? 'Ситуація не критична, але один патерн краще виправити до наступної серії входів.' : 'Критичних сигналів немає. Процес стабільний — не підвищуйте ризик без причини.',
        items: items.slice(0, 3),
    };
}

function screenshotCount(day) {
    return Object.values(day?.screenshots || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function rotatingNudge(data) {
    const now = new Date();
    const hour = now.getHours();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayEntry = state.appData?.journal?.[today];
    const learnCache = state.appData?.learnCache;
    const learnAge = Date.now() - Date.parse(learnCache?.date || '');
    const rotation = Math.floor(Date.now() / 10800000);
    if (todayEntry && pnlOf(todayEntry) !== null && hour >= 16 && !String(todayEntry.notes || '').trim()) {
        return { status: 'Запиши день', item: { tone: 'info', title: 'Закрий день коротким розбором', text: 'Результат уже є, але думки за день не записані. Додайте 2–3 речення: що спрацювало, де поспішили та що повторити завтра.', action: 'calendar', actionLabel: 'Записати день' } };
    }
    if (!todayEntry && hour >= 16) {
        return { status: 'Легке нагадування', item: { tone: 'info', title: 'Сьогоднішній день ще не записаний', text: 'Якщо торгували — синхронізуйте угоди й додайте короткий підсумок. Якщо не торгували, нічого робити не потрібно.', action: 'calendar', actionLabel: 'Відкрити календар' } };
    }
    if (todayEntry && hour < 16 && !String(todayEntry.sessionGoal || '').trim() && !String(todayEntry.sessionPlan || '').trim()) {
        return { status: 'План перед входами', item: { tone: 'info', title: 'Сформулюйте план сесії', text: 'Запишіть допустимі сетапи, максимальну кількість входів і умову, після якої зупиняєтесь.', action: 'calendar', actionLabel: 'Додати план' } };
    }
    const history = historicalItem(data);
    if (history && isRelevantMoment('calendar') && rotation % 4 === 0) return { status: 'Згадайте сильний день', item: history };
    if ((!learnCache || !Number.isFinite(learnAge) || learnAge > 7 * 86400000) && isRelevantMoment('learn')) {
        return { status: 'Час на навчання', item: { tone: 'info', title: 'Можливо, час подивитися розбір', text: data.commonError ? `Підберіть відео навколо проблеми «${data.commonError[0]}». У навчанні можна вказати власний напрямок пошуку.` : 'AI може підібрати практичні відео за вашими входами. Напишіть тему, яку хочете підтягнути.', action: 'learn', actionLabel: 'Підібрати відео' } };
    }
    if (data.latest?.day && screenshotCount(data.latest.day) === 0 && isRelevantMoment('screens')) {
        return { status: 'Збережи контекст', item: { tone: 'info', title: 'До останнього дня немає скріншотів', text: 'Один скрін входу й один скрін виходу часто дають більше користі, ніж довгий текстовий розбір.', action: 'screens', actionLabel: 'Додати скріншоти' } };
    }
    const chill = [
        { title: 'Спокійний check-in', text: 'Термінових проблем не видно. Не шукайте, що зламати: тримайте звичайний ризик і беріть лише знайомі входи.' },
        { title: 'Не форсуйте кількість', text: 'Хороший день не зобов’язаний мати багато угод. Якщо чистого сетапу немає — пропущений вхід теж правильна дія.' },
        { title: 'Збережіть робочий ритм', text: 'Продовжуйте так само: той самий ризик, ті самі фільтри й короткий розбір після завершення.' },
    ];
    return { status: 'Все спокійно', item: { tone: 'good', ...chill[rotation % chill.length] } };
}

function decorateWithNudge(brief, data) {
    if (brief.level === 'risk') return brief;
    const nudge = rotatingNudge(data);
    const items = [...brief.items];
    if (!items.some((item) => item.title === nudge.item.title)) items.push(nudge.item);
    return { ...brief, status: ['good', 'neutral'].includes(brief.level) ? nudge.status : brief.status, items: items.slice(-4) };
}

function normalize(value, fallback) {
    const levels = ['good', 'attention', 'risk', 'neutral'];
    const tones = ['good', 'warn', 'risk', 'info'];
    const items = Array.isArray(value?.items) ? value.items.slice(0, 8).map((item) => ({
        tone: tones.includes(item?.tone) ? item.tone : 'info',
        title: compactText(item?.title, 58),
        text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 360),
        action: ['learn', 'calendar', 'screens', 'stats', 'ai'].includes(item?.action) ? item.action : '',
        actionLabel: String(item?.actionLabel || '').trim().slice(0, 60),
        compareTrader: String(item?.compareTrader || '').trim().slice(0, 80),
    })).filter((item) => item.title && item.text) : [];
    return { level: levels.includes(value?.level) ? value.level : fallback.level, status: compactText(value?.status || fallback.status, 42), summary: compactText(value?.summary || fallback.summary, 130), items: items.length ? items : fallback.items };
}

function compactText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
    if (firstSentence && firstSentence.length <= maxLength) return firstSentence;
    const cut = text.slice(0, maxLength - 1);
    const boundary = cut.lastIndexOf(' ');
    return `${cut.slice(0, boundary > maxLength * 0.65 ? boundary : cut.length).trim()}…`;
}

function render(brief, updatedAt = '') {
    const host = document.getElementById('dashboard-ai-items');
    const status = document.getElementById('dashboard-ai-status');
    const summary = document.getElementById('dashboard-ai-summary');
    const updated = document.getElementById('dashboard-ai-updated');
    if (!host || !status || !summary) return;
    status.className = `dashboard-ai-status is-${brief.level}`;
    status.textContent = brief.status;
    summary.textContent = compactText(brief.summary, 90);
    mentorAllItems = brief.items.length ? brief.items.map((item) => ({ ...item })) : [{ tone: 'info', title: brief.status, text: brief.summary }];
    const visibleItems = mentorAllItems.slice(-2);
    carouselItems = visibleItems.map((item) => ({ ...item, title: compactText(item.title, 48), text: compactText(item.text, 100) }));
    carouselIndex = Math.min(carouselIndex, carouselItems.length - 1);
    renderCarouselItem();
    const carousel = document.querySelector('.dashboard-ai-carousel');
    if (carousel) carousel.hidden = carouselItems.length < 2;
    restartCarousel();
    if (updated) updated.textContent = updatedAt ? new Date(updatedAt).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) : '';
    renderHistory();
}

function renderCarouselItem() {
    const host = document.getElementById('dashboard-ai-items');
    const position = document.getElementById('dashboard-ai-position');
    if (!host || !carouselItems.length) return;
    const item = carouselItems[carouselIndex];
    host.textContent = '';
    const card = document.createElement('article'); card.className = `dashboard-ai-point is-${item.tone}`; card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', 'Відкрити наставника');
    const title = document.createElement('strong'); title.textContent = item.title;
    const text = document.createElement('p'); text.textContent = item.text;
    card.append(title, text);
    if (item.action && item.actionLabel) {
        const action = document.createElement('button'); action.type = 'button'; action.className = 'dashboard-ai-point__action'; action.dataset.tab = item.action; if (item.compareTrader) action.dataset.compareTrader = item.compareTrader; action.textContent = `${item.actionLabel} →`; card.appendChild(action);
    }
    host.appendChild(card);
    card.addEventListener('click', (event) => { if (!event.target.closest('button')) openDashboardMentor(); });
    card.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) { event.preventDefault(); openDashboardMentor(); } });
    if (position) position.textContent = `${carouselIndex + 1} / ${carouselItems.length}`;
}

function restartCarousel() {
    clearInterval(carouselTimer);
}

function renderHistory() {
    const host = document.getElementById('dashboard-ai-history');
    if (!host) return;
    const history = Array.isArray(state.appData?.settings?.dashboardAIHistory) ? state.appData.settings.dashboardAIHistory : [];
    host.textContent = '';
    if (!history.length) {
        const empty = document.createElement('p'); empty.textContent = 'Історія висновків з’явиться після перших AI-аналізів.'; host.appendChild(empty); return;
    }
    history.slice(0, 12).forEach((entry) => {
        const row = document.createElement('article'); row.className = `dashboard-ai-history__item is-${entry.level || 'neutral'}`;
        const head = document.createElement('strong'); head.textContent = `${entry.status || 'AI-висновок'} · ${new Date(entry.createdAt).toLocaleDateString('uk-UA')}`;
        const text = document.createElement('p'); text.textContent = entry.summary || '';
        row.append(head, text); host.appendChild(row);
    });
}

function rememberBrief(brief, dataSignature) {
    if (!state.appData.settings) state.appData.settings = {};
    const history = Array.isArray(state.appData.settings.dashboardAIHistory) ? state.appData.settings.dashboardAIHistory : [];
    const dayKey = new Date().toISOString().slice(0, 13);
    const entryKey = `${dataSignature}|${dayKey}`;
    const next = [{ key: entryKey, createdAt: new Date().toISOString(), level: brief.level, status: brief.status, summary: brief.summary, items: brief.items }, ...history.filter((item) => item?.key !== entryKey)].slice(0, 40);
    state.appData.settings.dashboardAIHistory = next;
}

function parseResponse(text) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    try { return match ? JSON.parse(match[0]) : null; } catch { return null; }
}

async function askAI(days, fallback, dataSignature) {
    if (busy || state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) return;
    busy = true;
    const button = document.getElementById('dashboard-ai-refresh');
    if (button) { button.disabled = true; button.textContent = '…'; button.setAttribute('aria-busy', 'true'); }
    try {
        const data = snapshot(days);
        const types = buildTradeTypeAIContext(state.appData?.journal || {}, { tradeTypes: state.appData?.tradeTypes, recentDays: 45, limit: 6 });
        const prompt = `Ти міні-помічник активного трейдера. Скажи, чи все гаразд, що переглянути у входах і ризику, чи був завеликий мінус, або чи варто продовжувати так само.
Дні: ${days.slice(0, 10).map((item) => `${item.date}: ${item.pnl}$, угод ${item.day?.trades?.length || 0}, помилки ${(item.day?.errors || []).join(', ') || 'немає'}`).join(' | ')}
Дейлос ${data.limit}$. Серія мінусів ${data.lossStreak}.
${types}
Сильні історичні дні трейдера: ${data.strongDays.map((item) => `${item.date}: ${item.pnl}$`).join(' | ') || 'немає'}.
Ключові записи зі сильних днів: ${data.strongNotes.map((item) => `${item.date}: ${item.note}`).join(' | ') || 'немає записів'}.
Помічник також може запропонувати навчання, запис дня, план сесії, скріншоти або порівняння. Для доречної тези можеш додати action: learn, calendar, screens, stats або ai та короткий actionLabel.
Не вигадуй відсутні причини, не прогнозуй ринок і не радь відігруватися. Говори як спокійний наставник: по-людськи, без канцеляризмів і довгого звіту. Назви одну головну помилку або скажи, що процес нормальний, та запропонуй одну дію. Поверни лише JSON: {"level":"good|attention|risk|neutral","status":"до 4 слів","summary":"одне коротке речення","items":[{"tone":"good|warn|risk|info","title":"до 5 слів","text":"одне коротке речення з порадою"}]}. Дай 1-2 items.`;
        const response = await callGemini(getGeminiKeys()[0], { contents: [{ parts: [{ text: prompt }] }] });
        const brief = normalize(parseResponse(response), fallback);
        const cache = { signature: dataSignature, updatedAt: new Date().toISOString(), brief };
        state.appData.settings.dashboardAIBrief = cache;
        rememberBrief(brief, dataSignature);
        const peers = await teamMomentum();
        render(withTeamMomentum(decorateWithNudge(brief, data), peers), cache.updatedAt);
        await saveSettings();
    } catch (error) {
        console.warn('[Dashboard AI]', error?.message || error);
        render(fallback);
    } finally {
        busy = false;
        if (button) { button.disabled = false; button.textContent = '↻'; button.removeAttribute('aria-busy'); }
    }
}

export async function renderDashboardAI(options = {}) {
    if (!document.getElementById('dashboard-ai-brief')) return;
    const days = recentDays();
    const key = signature(days);
    const data = snapshot(days);
    const fallback = fallbackBrief(data);
    const cache = state.appData?.settings?.dashboardAIBrief;
    const age = Date.now() - Date.parse(cache?.updatedAt || '');
    const valid = cache?.signature === key && Number.isFinite(age) && age < CACHE_MS;
    const baseBrief = valid ? normalize(cache.brief, fallback) : fallback;
    const decorated = decorateWithNudge(baseBrief, data);
    render(decorated, valid ? cache.updatedAt : '');
    void teamMomentum().then((rows) => render(withTeamMomentum(decorated, rows), valid ? cache.updatedAt : ''));
    if ((!valid || options.force) && days.length) void askAI(days, fallback, key);
}

export function refreshDashboardAI() {
    return renderDashboardAI({ force: true });
}

export function toggleDashboardAIHistory() {
    const host = document.getElementById('dashboard-ai-history');
    if (!host) return;
    host.hidden = !host.hidden;
    if (!host.hidden) renderHistory();
}

export function rotateDashboardAI(direction = 1) {
    if (!carouselItems.length) return;
    carouselIndex = (carouselIndex + (Number(direction) < 0 ? -1 : 1) + carouselItems.length) % carouselItems.length;
    renderCarouselItem();
    restartCarousel();
}

function mentorHistory() {
    return Array.isArray(state.appData?.settings?.dashboardMentorConversation) ? state.appData.settings.dashboardMentorConversation : [];
}

function renderMentorConversation() {
    const host = document.getElementById('dashboard-mentor-chat');
    if (!host) return;
    host.textContent = '';
    const history = mentorHistory();
    if (!history.length) {
        const welcome = document.createElement('p'); welcome.className = 'dashboard-mentor-empty'; welcome.textContent = 'Я пам’ятатиму наші розмови. Розкажи, що зараз не виходить.'; host.appendChild(welcome);
    }
    history.slice(-60).forEach((message) => {
        const row = document.createElement('div'); row.className = `dashboard-mentor-message is-${message.role === 'user' ? 'user' : 'mentor'}`;
        const text = document.createElement('p'); text.textContent = message.text || ''; row.appendChild(text);
        if (message.action && message.actionLabel) {
            const action = document.createElement('button'); action.type = 'button'; action.dataset.tab = message.action; action.className = 'dashboard-ai-point__action'; action.textContent = `${message.actionLabel} →`; row.appendChild(action);
        }
        host.appendChild(row);
    });
    host.scrollTop = host.scrollHeight;
}

function renderMentorTheses() {
    const host = document.getElementById('dashboard-mentor-theses');
    const count = document.getElementById('dashboard-mentor-theses-count');
    if (count) count.textContent = mentorAllItems.length ? `(${mentorAllItems.length})` : '';
    if (!host) return;
    host.textContent = '';
    mentorAllItems.forEach((item) => {
        const card = document.createElement('article'); card.className = `dashboard-mentor-thesis is-${item.tone || 'info'}`;
        const title = document.createElement('strong'); title.textContent = item.title || 'Думка';
        const text = document.createElement('p'); text.textContent = item.text || '';
        card.append(title, text);
        if (item.action && item.actionLabel) {
            const action = document.createElement('button'); action.type = 'button'; action.dataset.tab = item.action; action.className = 'dashboard-ai-point__action'; if (item.compareTrader) action.dataset.compareTrader = item.compareTrader; action.textContent = `${item.actionLabel} →`; card.appendChild(action);
        }
        host.appendChild(card);
    });
}

export function switchDashboardMentorTab(tab = 'chat') {
    const safeTab = tab === 'theses' ? 'theses' : 'chat';
    document.querySelectorAll('.dashboard-mentor-tabs [data-mentor-tab]').forEach((button) => button.classList.toggle('active', button.dataset.mentorTab === safeTab));
    document.querySelectorAll('.dashboard-mentor-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `dashboard-mentor-pane-${safeTab}`));
    if (safeTab === 'theses') renderMentorTheses();
    else setTimeout(() => document.getElementById('dashboard-mentor-input')?.focus(), 0);
}

export function openDashboardMentor() {
    const modal = document.getElementById('dashboard-mentor-modal');
    const context = document.getElementById('dashboard-mentor-context');
    if (!modal) return;
    if (context) {
        context.textContent = '';
        carouselItems.forEach((item) => { const p = document.createElement('p'); p.textContent = `${item.title}: ${item.text}`; context.appendChild(p); });
    }
    modal.hidden = false;
    document.body.classList.add('dashboard-mentor-open');
    renderMentorConversation();
    renderMentorTheses();
    switchDashboardMentorTab('chat');
}

export function closeDashboardMentor() {
    const modal = document.getElementById('dashboard-mentor-modal');
    if (modal) modal.hidden = true;
    document.body.classList.remove('dashboard-mentor-open');
}

export async function sendDashboardMentorMessage() {
    if (mentorBusy || state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) return;
    const input = document.getElementById('dashboard-mentor-input');
    const text = String(input?.value || '').trim();
    if (!text) return;
    if (!state.appData.settings) state.appData.settings = {};
    const history = mentorHistory();
    history.push({ role: 'user', text: text.slice(0, 1200), at: new Date().toISOString() });
    state.appData.settings.dashboardMentorConversation = history.slice(-120);
    if (input) input.value = '';
    renderMentorConversation();
    mentorBusy = true;
    document.getElementById('dashboard-mentor-compose')?.classList.add('is-busy');
    try {
        const days = recentDays();
        const data = snapshot(days);
        const memory = String(state.appData.settings.dashboardMentorMemory || '').slice(0, 2500);
        const dialogue = history.slice(-20).map((m) => `${m.role === 'user' ? 'Трейдер' : 'Наставник'}: ${m.text}`).join('\n');
        const prompt = `Ти особистий універсальний помічник і наставник людини. З тобою можна говорити про трейдинг, роботу, побут, плани, навчання, переживання або будь-яку іншу тему. Ти пам'ятаєш характер і минулі розмови та відповідаєш у близькому людині темпі, але не копіюєш грубість. Якщо питання про трейдинг — не вигадуй фактів, не прогнозуй ринок, допоможи побачити помилку й дай один конкретний крок. Якщо тема не про трейдинг — відповідай як звичайний розумний співрозмовник і не намагайся штучно повертати розмову до торгівлі.
Пам'ять: ${memory || 'ще формується'}
Останні дні: ${days.slice(0, 10).map((d) => `${d.date} ${d.pnl}$, помилки ${(d.day?.errors || []).join(', ') || 'немає'}, запис ${String(d.day?.notes || '').slice(0, 160) || 'немає'}`).join(' | ')}
Дейлос: ${data.limit}$. Діалог:\n${dialogue}
Поверни лише JSON: {"reply":"коротка жива відповідь до 4 речень","memory":"стисле оновлене розуміння підходу, характеру й важливих фактів трейдера","action":"calendar|stats|trades|screens|learn|ai або порожньо","actionLabel":"коротка назва переходу"}.`;
        const response = parseResponse(await callGemini(getGeminiKeys()[0], { contents: [{ parts: [{ text: prompt }] }] })) || {};
        const reply = compactText(response.reply || 'Я почув. Давай спершу подивимось на останні входи й знайдемо один повторюваний момент.', 520);
        history.push({ role: 'mentor', text: reply, action: ['calendar', 'stats', 'trades', 'screens', 'learn', 'ai'].includes(response.action) ? response.action : '', actionLabel: compactText(response.actionLabel, 40), at: new Date().toISOString() });
        state.appData.settings.dashboardMentorConversation = history.slice(-120);
        if (response.memory) state.appData.settings.dashboardMentorMemory = String(response.memory).slice(0, 2500);
        await saveSettings();
    } catch (error) {
        history.push({ role: 'mentor', text: 'Зараз не зміг відповісти. Твоя думка збережена — повернемось до неї трохи пізніше.', at: new Date().toISOString() });
        console.warn('[Dashboard mentor]', error?.message || error);
    } finally {
        mentorBusy = false;
        document.getElementById('dashboard-mentor-compose')?.classList.remove('is-busy');
        renderMentorConversation();
        void saveSettings().catch((error) => console.warn('[Dashboard mentor memory]', error?.message || error));
    }
}
