// === js/utils.js ===

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function normalizeHttpUrl(value, fallback = '') {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    try {
        const url = new URL(raw, window.location.origin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : fallback;
    } catch {
        return fallback;
    }
}

export function parseDecimalInput(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const normalized = raw
        .replace(/\s/g, '')
        .replace(',', '.')
        .replace(/^\+/, '');
    if (!/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

export function appendTextWithLineBreaks(parent, value) {
    const lines = String(value ?? '').split(/\r?\n/);
    lines.forEach((line, idx) => {
        if (idx > 0) parent.appendChild(document.createElement('br'));
        parent.appendChild(document.createTextNode(line));
    });
}

/**
 * Показує тимчасовий toast-повідомлення внизу екрану.
 * @param {string} msg - текст повідомлення
 * @param {number} duration - тривалість у мс (за замовчуванням 3000)
 */
export function showToast(msg, duration = 3000) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid var(--border);color:var(--text-main);padding:10px 22px;border-radius:10px;font-size:0.95rem;z-index:300001;pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), duration);
}

export async function copyTextToClipboard(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch (_) {
        /* fallback below */
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch (_) {
        ok = false;
    }
    textarea.remove();
    return ok;
}

export function setCopyableText(el, value, fallback = '—') {
    if (!el) return;
    const text = String(value || '').trim();
    el.textContent = text || fallback;
    el.dataset.copyValue = text;

    let btn = el.nextElementSibling?.classList?.contains('technical-email-copy-btn')
        ? el.nextElementSibling
        : null;
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'technical-email-copy-btn';
        btn.title = 'Скопіювати';
        btn.setAttribute('aria-label', 'Скопіювати пошту');
        btn.textContent = '⧉';
        el.insertAdjacentElement('afterend', btn);
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const targetText = el.dataset.copyValue || el.textContent || '';
            const ok = await copyTextToClipboard(targetText);
            showToast(ok ? 'Пошту скопійовано' : 'Не вдалося скопіювати');
        });
    }
    btn.hidden = !text;
}

/**
 * Кастомний confirm-діалог замість window.confirm.
 * @param {string} msg
 * @returns {Promise<boolean>}
 */
export function showConfirm(msg) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:300000;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:360px;width:90%;display:flex;flex-direction:column;gap:16px;';
        const text = document.createElement('p');
        text.style.cssText = 'margin:0;color:var(--text-main);font-size:0.95rem;white-space:pre-wrap;';
        text.textContent = msg;
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
        const yes = document.createElement('button');
        yes.className = 'btn-secondary';
        yes.style.cssText = 'width:auto;margin:0;border-color:var(--loss);color:var(--loss);';
        yes.textContent = 'Так';
        const no = document.createElement('button');
        no.className = 'btn-secondary';
        no.style.cssText = 'width:auto;margin:0;';
        no.textContent = 'Ні';
        const done = val => { overlay.remove(); resolve(val); };
        yes.onclick = () => done(true);
        no.onclick = () => done(false);
        btns.appendChild(no);
        btns.appendChild(yes);
        box.appendChild(text);
        box.appendChild(btns);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}

/**
 * Кастомний prompt-діалог замість window.prompt.
 * @param {string} msg
 * @param {string} defaultVal
 * @returns {Promise<string|null>}
 */
export function showPrompt(msg, defaultVal = '') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:300000;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:360px;width:90%;display:flex;flex-direction:column;gap:14px;';
        const text = document.createElement('p');
        text.style.cssText = 'margin:0;color:var(--text-main);font-size:0.95rem;';
        text.textContent = msg;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultVal;
        input.style.cssText = 'width:100%;box-sizing:border-box;';
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
        const ok = document.createElement('button');
        ok.className = 'btn-primary';
        ok.style.cssText = 'width:auto;margin:0;';
        ok.textContent = 'OK';
        const cancel = document.createElement('button');
        cancel.className = 'btn-secondary';
        cancel.style.cssText = 'width:auto;margin:0;';
        cancel.textContent = 'Скасувати';
        const done = val => { overlay.remove(); resolve(val); };
        ok.onclick = () => done(input.value);
        cancel.onclick = () => done(null);
        input.onkeydown = e => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); };
        btns.appendChild(cancel);
        btns.appendChild(ok);
        box.appendChild(text);
        box.appendChild(input);
        box.appendChild(btns);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        input.focus();
    });
}
