(function clientErrorBoot() {
    const steps = [];
    const seen = new Map();
    let enabled = true;
    try { enabled = sessionStorage.getItem('tj-error-report') !== 'off'; } catch { /* Залишаємо збір увімкненим. */ }
    let token = '';
    let reporting = false;

    const tabLabels = {
        dash: 'Огляд',
        calendar: 'Календар',
        trades: 'Угоди',
        datagrid: 'Сітка угод',
        table: 'Імпорт таблиці',
        screens: 'Скріни',
        'stop-errors': 'Помилки стопа',
        stats: 'Статистика',
        ai: 'AI',
        learn: 'Навчання',
        settings: 'Налаштування',
        admin: 'Адмінка',
        testing: 'Тестування',
    };

    function clean(value, max) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function tabLabel(tab) {
        return tabLabels[tab] || tab;
    }

    function pushStep(what) {
        const text = clean(what, 160);
        if (!text) return;
        const now = new Date();
        const label = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((part) => String(part).padStart(2, '0'))
            .join(':');
        const previous = steps[steps.length - 1];
        if (previous && previous.what === text) return;
        steps.push({ at: now.toISOString(), label, what: text });
        if (steps.length > 20) steps.shift();
    }

    function interactiveTarget(node) {
        let element = node && node.nodeType === 1 ? node : node?.parentElement;
        for (let depth = 0; element && element !== document.body && depth < 5; depth += 1) {
            if (element.matches('button, a, summary, [data-action], [data-tab], [role="button"]')) return element;
            element = element.parentElement;
        }
        return null;
    }

    function clickText(element) {
        const action = element.getAttribute('data-action')
            || element.closest('[data-action]')?.getAttribute('data-action')
            || '';
        const tab = element.getAttribute('data-tab')
            || element.closest('[data-tab]')?.getAttribute('data-tab')
            || '';
        const text = clean(element.getAttribute('aria-label') || element.innerText || '', 50);
        const bits = [];
        if (tab) bits.push(`вкладка ${tabLabel(tab)}`);
        if (action) bits.push(`дія ${action}`);
        if (text) bits.push(`«${text}»`);
        return `натиснув ${bits.join(', ') || element.tagName.toLowerCase()}`;
    }

    function fieldLabel(element) {
        const id = element.id;
        if (id && window.CSS?.escape) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) return clean(label.textContent, 40);
        }
        const wrap = element.closest('label');
        if (wrap) return clean(wrap.textContent, 40);
        return clean(element.getAttribute('aria-label') || element.name || element.id || 'поле', 40);
    }

    function isPrivateField(element) {
        const hint = `${element.type || ''} ${element.id || ''} ${element.name || ''} ${element.getAttribute('autocomplete') || ''}`.toLowerCase();
        return element.tagName === 'TEXTAREA' || /password|pass|token|secret|email|note|comment/.test(hint);
    }

    function changeText(element) {
        const label = fieldLabel(element);
        if (element.type === 'checkbox' || element.type === 'radio') {
            return `${element.checked ? 'увімкнув' : 'вимкнув'} «${label}»`;
        }
        if (element.tagName === 'SELECT') {
            const option = clean(element.selectedOptions?.[0]?.text || '', 40);
            return option ? `обрав «${option}» у полі «${label}»` : `змінив список «${label}»`;
        }
        if (element.type === 'date' || element.type === 'time' || element.type === 'datetime-local') {
            return `поставив ${element.value || 'порожньо'} у полі «${label}»`;
        }
        if (element.type === 'file') {
            return `обрав файл ${clean(element.files?.[0]?.name || 'файл', 60)}`;
        }
        if (isPrivateField(element)) return `редагував поле «${label}»`;
        if (element.type === 'number' || /^[\d.,+\-\s]{0,16}$/.test(element.value || '')) {
            return `ввів ${element.value || 'порожньо'} у полі «${label}»`;
        }
        return `редагував поле «${label}»`;
    }

    function currentTab() {
        const view = document.querySelector('.view-content.active');
        return view?.id?.replace(/^view-/, '') || '';
    }

    function safePath() {
        return `${location.pathname}${location.search}`.split('#')[0].slice(0, 300);
    }

    function noteRoute() {
        pushStep(`перейшов на ${safePath() || '/'}`);
    }

    function describeArg(value) {
        if (value instanceof Error) return value.message || value.name || 'Error';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (value && typeof value === 'object' && value.message) return String(value.message);
        return '';
    }

    function callerStack() {
        const stack = new Error().stack || '';
        return stack
            .split('\n')
            .filter((line) => !line.includes('client_error_boot.js'))
            .join('\n');
    }

    function shouldSend(message) {
        const key = message.slice(0, 180);
        const now = Date.now();
        let recent = 0;
        for (const [seenKey, at] of seen) {
            if (now - at > 10 * 60 * 1000) seen.delete(seenKey);
            else recent += 1;
        }
        if (seen.has(key)) return false;
        if (recent >= 8) return false;
        seen.set(key, now);
        return true;
    }

    function report(partial) {
        if (!enabled || reporting) return;
        const message = clean(partial.message, 700);
        if (!message || message === 'Script error.' || /ResizeObserver loop/i.test(message)) return;
        if (!shouldSend(message)) return;
        reporting = true;
        try {
            const payload = {
                kind: partial.kind || 'error',
                message,
                stack: String(partial.stack || '').slice(0, 2200),
                source: String(partial.source || '').slice(0, 200),
                line: partial.line || 0,
                column: partial.column || 0,
                page: safePath(),
                tab: currentTab(),
                viewport: `${window.innerWidth}x${window.innerHeight}`,
                happenedAt: new Date().toISOString(),
                scenario: steps.slice(),
            };
            const body = JSON.stringify(payload);
            const headers = { 'Content-Type': 'application/json' };
            if (token.split('.').length === 3) headers.Authorization = `Bearer ${token}`;
            fetch('/api/client-errors', { method: 'POST', headers, body, keepalive: true }).catch(() => {});
        } finally {
            reporting = false;
        }
    }

    document.addEventListener('click', (event) => {
        const element = interactiveTarget(event.target);
        if (!element) return;
        pushStep(clickText(element));
    }, true);

    document.addEventListener('change', (event) => {
        const element = event.target;
        if (!(element instanceof HTMLElement)) return;
        if (!element.matches('input, select, textarea')) return;
        pushStep(changeText(element));
    }, true);

    window.addEventListener('error', (event) => {
        report({
            kind: 'error',
            message: event.message || event.error?.message || 'Error',
            stack: event.error?.stack || '',
            source: event.filename || '',
            line: event.lineno || 0,
            column: event.colno || 0,
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        report({
            kind: 'unhandledrejection',
            message: reason instanceof Error
                ? reason.message
                : (typeof reason === 'string' ? reason : reason?.message || 'Unhandled rejection'),
            stack: reason instanceof Error ? reason.stack || '' : '',
        });
    });

    const originalError = console.error.bind(console);
    console.error = (...args) => {
        originalError(...args);
        try {
            const errorArg = args.find((item) => item instanceof Error);
            report({
                kind: 'console',
                message: args.map(describeArg).filter(Boolean).join(' '),
                stack: errorArg?.stack || callerStack(),
            });
        } catch { /* Збір помилки не має ламати консоль. */ }
    };

    ['pushState', 'replaceState'].forEach((name) => {
        const original = history[name];
        if (typeof original !== 'function') return;
        history[name] = function historyWithScenario(...args) {
            const result = original.apply(this, args);
            try { noteRoute(); } catch { /* Маршрут лишається робочим. */ }
            return result;
        };
    });
    window.addEventListener('popstate', noteRoute);
    window.addEventListener('tj-error-report', (event) => {
        enabled = event.detail?.enabled !== false;
        token = String(event.detail?.token || '');
        try { sessionStorage.setItem('tj-error-report', enabled ? 'on' : 'off'); } catch { /* Налаштування лишається в пам’яті вкладки. */ }
    });

    pushStep(`відкрив ${safePath() || '/'}`);
}());
