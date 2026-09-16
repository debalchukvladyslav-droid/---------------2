const activeLoaders = new Map();
let syncState = null;
let syncDetail = {};
let syncHideTimer = null;

function ensureLoaderRoot() {
    let root = document.getElementById('app-loading-stack');
    if (root) return root;

    root = document.createElement('aside');
    root.id = 'app-loading-stack';
    root.className = 'app-activity-center';
    root.setAttribute('aria-label', 'Стан даних і поточні дії');
    const sync = document.createElement('button');
    sync.type = 'button'; sync.className = 'app-activity-sync'; sync.hidden = true;
    sync.addEventListener('click', () => window.switchMainTab?.('settings'));
    const jobs = document.createElement('div'); jobs.className = 'app-activity-jobs';
    root.append(sync, jobs);
    document.body.appendChild(root);
    return root;
}

function renderActivity() {
    if (!document.body) return;
    const root = ensureLoaderRoot();
    const sync = root.querySelector('.app-activity-sync');
    const jobs = root.querySelector('.app-activity-jobs');
    const labels = {
        local: ['Збережено на пристрої', syncDetail.pending ? `Відправимо ${syncDetail.pending} змін` : 'Очікуємо сервер'],
        syncing: ['Синхронізація', syncDetail.pending ? `${syncDetail.pending} змін` : 'Перевіряємо зміни'],
        synced: ['Все збережено', 'Сервер підтвердив зміни'],
        offline: ['Немає мережі', syncDetail.pending ? `${syncDetail.pending} змін на пристрої` : 'Дані залишаються на пристрої'],
        conflict: ['Потрібна увага', 'Є дві версії однієї правки'],
        error: ['Не вдалося зберегти', syncDetail.message || 'Спробуємо ще раз автоматично'],
    };
    const [title, detail] = labels[syncState] || ['', ''];
    sync.hidden = !syncState;
    sync.dataset.state = syncState || '';
    sync.replaceChildren(Object.assign(document.createElement('span'), { className: 'app-activity-indicator', ariaHidden: 'true' }),
        (() => { const text = document.createElement('span'); const heading = document.createElement('strong'); const description = document.createElement('small'); heading.textContent = title; description.textContent = detail; text.append(heading, description); return text; })(),
        Object.assign(document.createElement('span'), { className: 'app-activity-arrow', ariaHidden: 'true', textContent: '›' }));
    jobs.hidden = activeLoaders.size === 0;
    root.hidden = !syncState && activeLoaders.size === 0;
}

document.addEventListener('strum:sync-state', event => {
    syncState = event.detail?.state || null;
    syncDetail = event.detail || {};
    clearTimeout(syncHideTimer);
    if (syncState === 'synced') syncHideTimer = setTimeout(() => { syncState = null; renderActivity(); }, 4000);
    renderActivity();
});

export function showGlobalLoader(key, message, options = {}) {
    const root = ensureLoaderRoot();
    const id = String(key || 'default');
    let item = activeLoaders.get(id);
    if (!item) {
        item = document.createElement('div');
        item.className = 'app-loading-item';
        const spinner = document.createElement('span');
        spinner.className = 'app-loading-spinner';
        const text = document.createElement('span');
        text.className = 'app-loading-text';
        item.append(spinner, text);
        root.querySelector('.app-activity-jobs').appendChild(item);
        activeLoaders.set(id, item);
    }

    item.classList.toggle('app-loading-done', options.type === 'success');
    item.classList.toggle('app-loading-error', options.type === 'error');
    item.querySelector('.app-loading-text').textContent = message || 'Завантаження...';
    renderActivity();
    return item;
}

export function hideGlobalLoader(key, delay = 0) {
    const id = String(key || 'default');
    const item = activeLoaders.get(id);
    if (!item) return;
    window.setTimeout(() => {
        item.remove();
        activeLoaders.delete(id);
        renderActivity();
    }, delay);
}

export async function withGlobalLoader(key, message, task, doneMessage = '') {
    showGlobalLoader(key, message);
    try {
        const result = await task();
        if (doneMessage) {
            showGlobalLoader(key, doneMessage, { type: 'success' });
            hideGlobalLoader(key, 1200);
        } else {
            hideGlobalLoader(key);
        }
        return result;
    } catch (error) {
        showGlobalLoader(key, `Помилка: ${error?.message || error}`, { type: 'error' });
        hideGlobalLoader(key, 2800);
        throw error;
    }
}

export function setElementLoading(elementOrId, isLoading, loadingText = '') {
    const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!el) return;
    if (isLoading) {
        if (!el.dataset.loadingOriginalText) el.dataset.loadingOriginalText = el.textContent || '';
        if (loadingText) el.textContent = loadingText;
        el.classList.add('is-loading-local');
        el.disabled = true;
    } else {
        if (el.dataset.loadingOriginalText) {
            el.textContent = el.dataset.loadingOriginalText;
            delete el.dataset.loadingOriginalText;
        }
        el.classList.remove('is-loading-local');
        el.disabled = false;
    }
}
