import { state } from './state.js';

const VERSION = 1;
const RELEASED_AT = Date.parse('2026-07-14T00:00:00Z');
const LOCAL_PREFIX = 'tj:onboarding:';

let deps = null;
let active = false;
let stepIndex = 0;
let root = null;
let target = null;
let actionCleanup = null;
let layoutFrame = 0;
let eventsBound = false;
let saveTimer = 0;
let interfaceObserver = null;

const steps = [
    { id: 'overview', tab: 'dash', target: ['.app-sidebar', '.mobile-bottom-nav'], title: 'Головна навігація', text: 'Звідси відкриваються календар, скріншоти, імпорт, аналітика, AI Ментор, навчання та налаштування.' },
    { id: 'team', tab: 'dash', target: '#team-toggle-btn', title: 'Команда', text: 'Тут можна відкрити свою команду та переходити до доступних профілів трейдерів.', action: '#team-toggle-btn', actionLabel: 'Відкрийте «Команда»', optional: true },
    { id: 'notifications', tab: 'dash', target: '#notif-bell-btn', title: 'Сповіщення', text: 'Увімкніть сповіщення на ПК, щоб бачити нові події та запити на рев’ю.', prepare: 'notifications', action: '#notif-enable-push', actionLabel: 'Натисніть «Сповіщення на ПК»', optional: true },
    { id: 'sync', tab: 'dash', target: '#manual-sync-btn', title: 'Загальна синхронізація', text: 'Ця кнопка синхронізує журнал, Google Sheets, скріншоти та інші дані. Та сама синхронізація автоматично виконується кожні 5 хвилин.' },
    { id: 'calendar', tab: 'calendar', target: '.day-cell', title: 'Календар торгових днів', text: 'Один клік вибирає день. Подвійний клік або кнопка «+» відкриває форму додавання та редагування дня.' },
    { id: 'drive-open', tab: 'screens', target: '.screens-settings-btn', title: '1. Відкрийте налаштування скріншотів', text: 'Натисніть шестерню. Наступні пункти проведуть через підключення Drive.', group: 'drive', action: '.screens-settings-btn', actionLabel: 'Відкрийте налаштування', optional: true },
    { id: 'drive-share', tab: 'screens', target: '#drive-service-email', title: '2. Надайте доступ до папки', text: 'Скопіюйте цю service account пошту та додайте її до папки Google Drive з правами Viewer.', group: 'drive', prepare: 'screens-open', optional: true },
    { id: 'drive-folder', tab: 'screens', target: '#drive-service-folder-input', title: '3. Вставте папку', text: 'Вставте посилання на папку Google Drive або її ID.', group: 'drive', prepare: 'screens-open', action: '#drive-service-folder-input', event: 'input', actionLabel: 'Вставте посилання або ID', optional: true },
    { id: 'drive-sync', tab: 'screens', target: '[data-action="drive-service-sync"]', title: '4. Запустіть синхронізацію', text: 'Натисніть «Синхронізувати». Сайт збере доступні зображення з папки.', group: 'drive', prepare: 'screens-open', action: '[data-action="drive-service-sync"]', actionLabel: 'Запустіть синхронізацію', optional: true },
    { id: 'drive-result', tab: 'screens', target: '#unassigned-container', title: '5. Дочекайтеся скріншота', text: 'Нові скріншоти з’являються тут. Їх можна розподілити по днях і угодах.', group: 'drive', prepare: 'screens-open', optional: true },
    { id: 'ocr-select', tab: 'screens', target: '#ocr-setup-container', title: 'OCR-зона тікера', text: 'На завантаженому скріншоті виділіть мишкою або пальцем ділянку, де показаний тікер.', prepare: 'screens-open', action: '#ocr-setup-container', event: 'pointerup', actionLabel: 'Виділіть область тікера', optional: true },
    { id: 'ocr-save', tab: 'screens', target: '[data-action="ocr-save"]', title: 'Збережіть OCR-зону', text: 'Після виділення збережіть зону. Сайт використає її для автоматичного визначення тікерів.', prepare: 'screens-open', action: '[data-action="ocr-save"]', actionLabel: 'Збережіть OCR-зону', optional: true },
    { id: 'broker-imports', tab: 'table', target: '.broker-import-card', title: 'Імпорт брокерських звітів', text: 'Summary by date оновлює денні підсумки, Trades додає угоди, а PPRO імпортує денні результати PPRO. Тур не відкриватиме вибір файлу автоматично.' },
    { id: 'sheet-source', tab: 'table', target: '.sheet-preset-picker', title: 'Виберіть Google-таблицю', text: 'Оберіть готову таблицю своєї групи або вставте власне посилання. Основна таблиця працює щодня, накопичувальна зберігає історичний контекст.', prepare: 'sheet-open', action: '.sheet-preset-btn, [data-action="sheet-service-load"]', actionLabel: 'Оберіть або підключіть таблицю', optional: true },
    { id: 'sheet-map', tab: 'table', target: '[data-action="sheet-auto-map"]', title: 'Автомапінг колонок', text: 'Після завантаження прев’ю натисніть «Автомапінг». Поля нижче можна виправити вручну.', prepare: 'sheet-open', action: '[data-action="sheet-auto-map"]', actionLabel: 'Запустіть автомапінг', optional: true },
    { id: 'sheet-preview', tab: 'table', target: '.sheet-grid-picker', title: 'Перевірте Excel-прев’ю', text: 'Кнопки − і + змінюють масштаб. Прев’ю можна гортати горизонтально й вертикально, а кліком по клітинці задавати колонку та стартовий рядок.', prepare: 'sheet-open' },
    { id: 'sheet-save', tab: 'table', target: '#sheet-save-sync-btn', title: 'Збережіть і синхронізуйте', text: 'Кнопка збереже мапінг та перенесе дані таблиці до журналу.', prepare: 'sheet-open', action: '#sheet-save-sync-btn', actionLabel: 'Збережіть мапінг і синхронізуйте', optional: true },
    { id: 'datagrid', tab: 'datagrid', target: '#view-datagrid', title: 'Таблиця угод', text: 'Тут відображаються угоди брокера, доповнені даними Google Sheets. Використовуйте таблицю для швидкої перевірки всіх записів.' },
    { id: 'analytics', tab: 'stats', target: '.stats-pro-toolbar', title: 'Аналітика', text: 'Фільтруйте джерело, тип угоди й період. Нижче доступні PnL, winrate, profit factor, просадка, комісії та графіки.' },
    { id: 'comparison', tab: 'stats', target: '#stats-compare-toggle', title: 'Режим порівняння', text: 'Відкрийте порівняння, щоб зіставити свої результати з будь-яким доступним трейдером.', prepare: 'comparison' },
    { id: 'ai', tab: 'ai', target: '.ai-workspace', title: 'AI Ментор', text: 'Ставте власні запитання або використовуйте швидкі запити про тиждень, помилки, ризик і сетапи. Тур не надсилає запитів автоматично.' },
    { id: 'learn', tab: 'learn', target: '#learn-refresh-btn', title: 'Навчання', text: 'Кнопка формує персональні рекомендації на основі журналу. Кожна картка коротко пояснює, чому матеріал корисний саме зараз.' },
    { id: 'settings', tab: 'settings', target: '.settings-dayloss-row', title: 'Налаштуйте дейлос', text: 'Виберіть місяць і встановіть денний ліміт втрат. Через «Всі місяці з даними» можна переглянути та змінити попередні періоди.' },
    { id: 'finish', title: 'Готово до роботи', text: 'Основні розділи налаштовані. Тур завжди можна повторити в налаштуваннях.', finish: true },
];

function localKey() {
    return `${LOCAL_PREFIX}${state.myUserId || state.USER_DOC_NAME || 'anonymous'}`;
}

function onboardingState() {
    return state.appData?.settings?.onboarding || {};
}

function writeState(status, extra = {}) {
    if (!state.appData?.settings) return;
    const value = { version: VERSION, status, ...extra };
    state.appData.settings.onboarding = value;
    try { localStorage.setItem(localKey(), JSON.stringify(value)); } catch (_) {}
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void deps?.saveSettings?.(), 350);
}

function visibleElement(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
        for (const element of document.querySelectorAll(selector || '')) {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden') return element;
        }
    }
    return null;
}

function ensureRoot() {
    if (root?.isConnected) return root;
    root = document.createElement('div');
    root.id = 'onboarding-tour';
    root.className = 'onboarding-tour';
    root.hidden = true;
    root.innerHTML = `
        <div class="onboarding-spotlight" aria-hidden="true"></div>
        <section class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
            <button type="button" class="onboarding-close" data-onboarding="later" aria-label="Закрити">×</button>
            <div class="onboarding-kicker"></div>
            <h2 id="onboarding-title" class="onboarding-title"></h2>
            <p class="onboarding-text"></p>
            <div class="onboarding-action-hint" hidden></div>
            <div class="onboarding-dots" aria-hidden="true"></div>
            <div class="onboarding-progress"><span></span></div>
            <div class="onboarding-actions">
                <button type="button" class="btn-secondary onboarding-back" data-onboarding="back">Назад</button>
                <button type="button" class="btn-secondary onboarding-skip" data-onboarding="skip-step">Пропустити крок</button>
                <button type="button" class="btn-primary onboarding-next" data-onboarding="next">Далі</button>
            </div>
        </section>`;
    document.body.appendChild(root);
    root.addEventListener('click', handleControl);
    return root;
}

function handleControl(event) {
    const control = event.target.closest('[data-onboarding]');
    if (!control) return;
    const action = control.dataset.onboarding;
    if (action === 'next') void nextStep();
    if (action === 'back') void showStep(Math.max(0, stepIndex - 1));
    if (action === 'skip-step') void nextStep();
    if (action === 'later') stopTour('later');
    if (action === 'dismiss') stopTour('dismissed');
    if (action === 'start') void showStep(0);
    if (action === 'home') finishTour(true);
    if (action === 'stay') finishTour(false);
}

function renderWelcome() {
    ensureRoot();
    active = true;
    root.hidden = false;
    document.body.classList.add('onboarding-active');
    root.querySelector('.onboarding-spotlight').classList.add('is-fullscreen');
    const card = root.querySelector('.onboarding-card');
    card.classList.add('is-welcome');
    card.style.cssText = '';
    root.querySelector('.onboarding-kicker').textContent = 'Знайомство із сайтом · 7–10 хвилин';
    root.querySelector('.onboarding-title').textContent = 'Налаштуймо Trading Journal Pro';
    root.querySelector('.onboarding-text').textContent = 'Покажемо головні розділи, підключення скріншотів, OCR, імпорт таблиць, аналітику та AI. Зовнішні підключення можна пропускати.';
    root.querySelector('.onboarding-action-hint').hidden = true;
    root.querySelector('.onboarding-dots').innerHTML = '';
    root.querySelector('.onboarding-progress').hidden = true;
    root.querySelector('.onboarding-actions').innerHTML = `
        <button type="button" class="btn-secondary" data-onboarding="dismiss">Не показувати</button>
        <button type="button" class="btn-secondary" data-onboarding="later">Пізніше</button>
        <button type="button" class="btn-primary" data-onboarding="start">Почати</button>`;
}

async function prepareStep(step) {
    if (step.id !== 'team') window.closeTeamSidebar?.();
    if (step.id !== 'notifications' && document.getElementById('notif-dropdown')?.classList.contains('open')) {
        document.getElementById('notif-close-btn')?.click();
    }
    if (step.tab) await deps.switchMainTab(step.tab);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (step.prepare === 'notifications') document.getElementById('notif-bell-btn')?.click();
    if (step.prepare === 'screens-open' && document.getElementById('screens-settings-panel')?.classList.contains('initially-hidden')) {
        document.querySelector('.screens-settings-btn')?.click();
        await new Promise((resolve) => setTimeout(resolve, 180));
    }
    if (step.prepare === 'sheet-open' && document.getElementById('sheet-google-panel-toggle')?.getAttribute('aria-expanded') !== 'true') {
        document.getElementById('sheet-google-panel-toggle')?.click();
        await new Promise((resolve) => setTimeout(resolve, 180));
    }
    if (step.prepare === 'comparison' && document.getElementById('stats-compare-toggle')?.getAttribute('aria-expanded') !== 'true') {
        document.getElementById('stats-compare-toggle')?.click();
    }
}

function bindRequiredAction(step) {
    actionCleanup?.();
    actionCleanup = null;
    const next = root.querySelector('.onboarding-next');
    const hint = root.querySelector('.onboarding-action-hint');
    if (!step.action) {
        next.disabled = false;
        hint.hidden = true;
        return;
    }
    const eventName = step.event || 'click';
    next.disabled = true;
    hint.hidden = false;
    hint.textContent = step.actionLabel || 'Виконайте дію, щоб продовжити';
    const listener = (event) => {
        if (!event.target?.closest?.(step.action)) return;
        next.disabled = false;
        hint.hidden = true;
        setTimeout(positionTour, 80);
    };
    document.addEventListener(eventName, listener, true);
    actionCleanup = () => document.removeEventListener(eventName, listener, true);
}

function renderGroupDots(step) {
    const host = root.querySelector('.onboarding-dots');
    if (!step.group) {
        host.innerHTML = '';
        return;
    }
    const grouped = steps.filter((item) => item.group === step.group);
    host.innerHTML = grouped.map((item) => `<span class="${item.id === step.id ? 'active' : ''}"></span>`).join('');
}

async function showStep(index) {
    if (!active) return;
    actionCleanup?.();
    const step = steps[index];
    if (!step) return finishTour(false);
    stepIndex = index;
    if (step.finish) return renderFinish();
    await prepareStep(step);
    target?.classList.remove('onboarding-target');
    target = visibleElement(step.target);
    if (!target) return showStep(index + 1);
    target.classList.add('onboarding-target');
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await new Promise((resolve) => setTimeout(resolve, 240));

    const card = root.querySelector('.onboarding-card');
    card.classList.remove('is-welcome');
    root.querySelector('.onboarding-spotlight').classList.remove('is-fullscreen');
    root.querySelector('.onboarding-kicker').textContent = `Крок ${index + 1} із ${steps.length}`;
    root.querySelector('.onboarding-title').textContent = step.title;
    root.querySelector('.onboarding-text').textContent = step.text;
    root.querySelector('.onboarding-progress').hidden = false;
    root.querySelector('.onboarding-progress span').style.width = `${((index + 1) / steps.length) * 100}%`;
    root.querySelector('.onboarding-actions').innerHTML = `
        <button type="button" class="btn-secondary onboarding-back" data-onboarding="back" ${index === 0 ? 'disabled' : ''}>Назад</button>
        <button type="button" class="btn-secondary onboarding-skip" data-onboarding="skip-step" ${step.optional ? '' : 'hidden'}>Пропустити крок</button>
        <button type="button" class="btn-primary onboarding-next" data-onboarding="next">Далі</button>`;
    renderGroupDots(step);
    bindRequiredAction(step);
    writeState('in_progress', { stepId: step.id, updatedAt: new Date().toISOString() });
    positionTour();
}

function renderFinish() {
    target?.classList.remove('onboarding-target');
    target = null;
    root.querySelector('.onboarding-spotlight').classList.add('is-fullscreen');
    const card = root.querySelector('.onboarding-card');
    card.classList.add('is-welcome');
    card.style.cssText = '';
    root.querySelector('.onboarding-kicker').textContent = 'Тур завершено';
    root.querySelector('.onboarding-title').textContent = steps.at(-1).title;
    root.querySelector('.onboarding-text').textContent = steps.at(-1).text;
    root.querySelector('.onboarding-action-hint').hidden = true;
    root.querySelector('.onboarding-dots').innerHTML = '';
    root.querySelector('.onboarding-progress').hidden = true;
    root.querySelector('.onboarding-actions').innerHTML = `
        <button type="button" class="btn-secondary" data-onboarding="stay">Залишитися тут</button>
        <button type="button" class="btn-primary" data-onboarding="home">Перейти на головну</button>`;
}

function positionTour() {
    if (!active || !target || !root) return;
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const spot = root.querySelector('.onboarding-spotlight');
        const pad = 8;
        spot.style.left = `${Math.max(4, rect.left - pad)}px`;
        spot.style.top = `${Math.max(4, rect.top - pad)}px`;
        spot.style.width = `${Math.min(innerWidth - 8, rect.width + pad * 2)}px`;
        spot.style.height = `${Math.min(innerHeight - 8, rect.height + pad * 2)}px`;
        const card = root.querySelector('.onboarding-card');
        const cardWidth = Math.min(390, innerWidth - 24);
        card.style.width = `${cardWidth}px`;
        const estimatedHeight = Math.min(card.offsetHeight || 320, innerHeight - 24);
        if (innerWidth <= 720) return;

        const gap = 16;
        const clampLeft = (value) => Math.max(12, Math.min(innerWidth - cardWidth - 12, value));
        const clampTop = (value) => Math.max(12, Math.min(innerHeight - estimatedHeight - 12, value));
        const candidates = [
            { left: clampLeft(rect.left + rect.width / 2 - cardWidth / 2), top: clampTop(rect.bottom + gap) },
            { left: clampLeft(rect.left + rect.width / 2 - cardWidth / 2), top: clampTop(rect.top - estimatedHeight - gap) },
            { left: clampLeft(rect.right + gap), top: clampTop(rect.top + rect.height / 2 - estimatedHeight / 2) },
            { left: clampLeft(rect.left - cardWidth - gap), top: clampTop(rect.top + rect.height / 2 - estimatedHeight / 2) },
        ];
        const blockers = [
            '#team-sidebar.open',
            '#notif-dropdown.open',
            '#form-sidebar.open',
            '.stats-bar-dropdown:not(.initially-hidden)',
            '.mobile-more-menu.open',
            '.app-modal-overlay[style*="display: flex"]',
        ].flatMap((selector) => [...document.querySelectorAll(selector)])
            .filter((element) => !root.contains(element) && element !== target)
            .map((element) => element.getBoundingClientRect())
            .filter((item) => item.width > 0 && item.height > 0);
        const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
            * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const scored = candidates.map((candidate, order) => {
            const box = {
                left: candidate.left,
                top: candidate.top,
                right: candidate.left + cardWidth,
                bottom: candidate.top + estimatedHeight,
            };
            const targetOverlap = overlapArea(box, rect) * 20;
            const interfaceOverlap = blockers.reduce((sum, blocker) => sum + overlapArea(box, blocker), 0);
            return { ...candidate, score: targetOverlap + interfaceOverlap + order };
        }).sort((a, b) => a.score - b.score)[0];
        card.style.left = `${scored.left}px`;
        card.style.top = `${scored.top}px`;
    });
}

async function nextStep() {
    await showStep(stepIndex + 1);
}

function stopTour(status = 'later') {
    if (!active) return;
    active = false;
    actionCleanup?.();
    target?.classList.remove('onboarding-target');
    target = null;
    root.hidden = true;
    document.body.classList.remove('onboarding-active');
    writeState(status, { stepId: steps[stepIndex]?.id || null, updatedAt: new Date().toISOString() });
}

function finishTour(goHome) {
    writeState('completed', { stepId: 'finish', completedAt: new Date().toISOString() });
    active = false;
    target?.classList.remove('onboarding-target');
    root.hidden = true;
    document.body.classList.remove('onboarding-active');
    if (goHome) void deps.switchMainTab('dash');
}

export function startOnboardingTour(options = {}) {
    if (!deps || state.CURRENT_VIEWED_USER !== state.USER_DOC_NAME) return;
    ensureRoot();
    if (options.resume) {
        const saved = onboardingState();
        const index = Math.max(0, steps.findIndex((step) => step.id === saved.stepId));
        active = true;
        root.hidden = false;
        document.body.classList.add('onboarding-active');
        void showStep(index);
        return;
    }
    renderWelcome();
}

export function resetOnboardingRuntime() {
    active = false;
    actionCleanup?.();
    actionCleanup = null;
    target?.classList.remove('onboarding-target');
    target = null;
    if (root) root.hidden = true;
    document.body.classList.remove('onboarding-active');
}

export function initOnboarding(options) {
    deps = options;
    ensureRoot();
    if (!eventsBound) {
        eventsBound = true;
        document.addEventListener('click', (event) => {
            if (event.target.closest('[data-action="onboarding-restart"]')) startOnboardingTour();
        });
        window.addEventListener('resize', positionTour, { passive: true });
        window.addEventListener('scroll', positionTour, { passive: true, capture: true });
        interfaceObserver = new MutationObserver((mutations) => {
            if (!active || mutations.every((mutation) => root?.contains(mutation.target))) return;
            positionTour();
        });
        interfaceObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-expanded'],
            subtree: true,
        });
    }

    const server = onboardingState();
    let local = null;
    try { local = JSON.parse(localStorage.getItem(localKey()) || 'null'); } catch (_) {}
    const saved = server.version === VERSION ? server : (local?.version === VERSION ? local : null);
    if (saved?.status === 'in_progress') return setTimeout(() => startOnboardingTour({ resume: true }), 900);
    if (saved && ['completed', 'dismissed'].includes(saved.status)) return;
    if (saved?.status === 'later') return setTimeout(() => startOnboardingTour(), 900);

    const createdAt = Date.parse(options.user?.created_at || '');
    if (Number.isFinite(createdAt) && createdAt >= RELEASED_AT) {
        setTimeout(() => startOnboardingTour(), 1100);
    }
}
