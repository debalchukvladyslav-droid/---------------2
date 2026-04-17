const activeLoaders = new Map();

function ensureLoaderRoot() {
    let root = document.getElementById('app-loading-stack');
    if (root) return root;

    const style = document.createElement('style');
    style.textContent = `
        #app-loading-stack{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:100000;max-width:min(360px,calc(100vw - 32px));pointer-events:none}
        .app-loading-item{display:flex;align-items:center;gap:10px;background:var(--bg-panel,#111827);color:var(--text-main,#f8fafc);border:1px solid var(--border,#334155);box-shadow:0 10px 30px rgba(0,0,0,.28);border-radius:8px;padding:10px 12px;font-size:.9rem;line-height:1.3;pointer-events:auto}
        .app-loading-spinner{width:15px;height:15px;border:2px solid rgba(148,163,184,.35);border-top-color:var(--accent,#8b5cf6);border-radius:50%;animation:app-spin .8s linear infinite;flex:0 0 auto}
        .app-loading-done .app-loading-spinner{animation:none;border-color:var(--profit,#10b981)}
        .app-loading-error .app-loading-spinner{animation:none;border-color:var(--loss,#ef4444)}
        .is-loading-local{position:relative;opacity:.72}
        .is-loading-local::after{content:"";position:absolute;right:10px;top:50%;width:13px;height:13px;margin-top:-7px;border:2px solid rgba(148,163,184,.35);border-top-color:var(--accent,#8b5cf6);border-radius:50%;animation:app-spin .8s linear infinite}
        @keyframes app-spin{to{transform:rotate(360deg)}}
    `;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'app-loading-stack';
    document.body.appendChild(root);
    return root;
}

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
        root.appendChild(item);
        activeLoaders.set(id, item);
    }

    item.classList.toggle('app-loading-done', options.type === 'success');
    item.classList.toggle('app-loading-error', options.type === 'error');
    item.querySelector('.app-loading-text').textContent = message || 'Завантаження...';
    return item;
}

export function hideGlobalLoader(key, delay = 0) {
    const id = String(key || 'default');
    const item = activeLoaders.get(id);
    if (!item) return;
    window.setTimeout(() => {
        item.remove();
        activeLoaders.delete(id);
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
