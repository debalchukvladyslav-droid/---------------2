const MESSAGE_LIMIT = 700;
const STACK_LIMIT = 2200;
const PAGE_LIMIT = 300;
const SOURCE_LIMIT = 200;
const SCENARIO_LIMIT = 20;
const STEP_LIMIT = 160;
const AGENT_LIMIT = 180;
export const CLIENT_ERROR_NOTIFY_WINDOW_MS = 20 * 60 * 1000;
export const CLIENT_ERROR_BURST_LIMIT = 20;

const TAB_LABELS = {
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

const SECRET_PATTERN = /(?:bearer\s+)[a-z0-9\-._~+/]+=*|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi;
const SENSITIVE_QUERY = /^(access_token|refresh_token|token|code|password|state)$/i;

function cleanLine(value, max) {
    return String(value ?? '')
        .replace(SECRET_PATTERN, '[приховано]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function cleanBlock(value, max) {
    return String(value ?? '')
        .replace(SECRET_PATTERN, '[приховано]')
        .replace(/\r\n/g, '\n')
        .slice(0, max)
        .trim();
}

export function isIgnorableClientError(message, source = '') {
    const text = String(message || '').trim();
    const from = String(source || '');
    if (!text) return true;
    if (text === 'Script error.') return true;
    if (/ResizeObserver loop/i.test(text)) return true;
    if (/^(chrome|moz|safari)-extension:\/\//i.test(from)) return true;
    if (from.includes('client_error_boot.js') || from.includes('client_error_report.js')) return true;
    return false;
}

export function safeClientPage(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw, 'https://journal.local');
        for (const key of [...url.searchParams.keys()]) {
            if (SENSITIVE_QUERY.test(key)) url.searchParams.delete(key);
        }
        url.hash = '';
        return `${url.pathname}${url.search}`.slice(0, PAGE_LIMIT);
    } catch {
        return raw.split('#')[0].slice(0, PAGE_LIMIT);
    }
}

export function clientErrorFingerprint(message, stack) {
    const frame = String(stack || '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('at ') || line.includes('@')) || '';
    const basis = `${cleanLine(message, 240)}\n${frame.replace(/:\d+:\d+/g, '')}`.slice(0, 500);
    let hash = 2166136261;
    for (let index = 0; index < basis.length; index += 1) {
        hash ^= basis.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function codeLocation(report) {
    const source = safeClientPage(report.source);
    if (source && report.line) return `${source}:${report.line}:${report.column || 0}`;
    const frame = String(report.stack || '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /js\/[\w./-]+\.js/.test(line));
    return frame || source || '';
}

function normalizeScenario(value) {
    if (!Array.isArray(value)) return [];
    const steps = [];
    for (const step of value.slice(-SCENARIO_LIMIT)) {
        if (!step || typeof step !== 'object') continue;
        const what = cleanLine(step.what, STEP_LIMIT);
        if (!what) continue;
        steps.push({
            at: cleanLine(step.at, 40),
            label: cleanLine(step.label, 12),
            what,
        });
    }
    return steps;
}

export function normalizeClientError(raw, context = {}) {
    const message = cleanLine(raw?.message, MESSAGE_LIMIT);
    const source = safeClientPage(raw?.source);
    if (isIgnorableClientError(message, source)) return null;
    const stack = cleanBlock(raw?.stack, STACK_LIMIT);
    const kind = ['error', 'unhandledrejection', 'console'].includes(raw?.kind) ? raw.kind : 'error';
    const line = Math.max(0, Math.min(1_000_000, Number(raw?.line) || 0));
    const column = Math.max(0, Math.min(1_000_000, Number(raw?.column) || 0));
    const happenedAt = Number.isNaN(Date.parse(raw?.happenedAt))
        ? (context.now instanceof Date ? context.now.toISOString() : new Date().toISOString())
        : new Date(raw.happenedAt).toISOString();
    const report = {
        fingerprint: clientErrorFingerprint(message, stack),
        kind,
        message,
        stack,
        page: safeClientPage(raw?.page),
        tab: cleanLine(raw?.tab, 40),
        source,
        line,
        column,
        scenario: normalizeScenario(raw?.scenario),
        viewport: cleanLine(raw?.viewport, 20),
        happenedAt,
        userId: context.userId || null,
        nick: cleanLine(context.nick, 80),
        email: cleanLine(context.email, 120),
        userAgent: cleanLine(context.userAgent, AGENT_LIMIT),
        sourceHash: cleanLine(context.sourceHash, 64),
    };
    report.location = codeLocation(report);
    return report;
}

export function formatClientErrorReport(report) {
    const who = [report.nick, report.email].filter(Boolean).join(' · ') || 'гість, ще не увійшов';
    const tab = TAB_LABELS[report.tab] || report.tab || 'невідома вкладка';
    const lines = [
        'Звіт про помилку журналу. Встав цей текст у чат: тут є сценарій дій і місце в коді.',
        '',
        `Акаунт: ${who}`,
        `Коли: ${report.happenedAt || ''}`,
    ];
    if (report.userId) lines.push(`ID акаунта: ${report.userId}`);
    lines.push(`Де на сайті: ${tab}${report.page ? `, адреса ${report.page}` : ''}`);
    if (report.viewport) lines.push(`Вікно: ${report.viewport}`);
    lines.push(`Що зламалось (${report.kind}): ${report.message}`);
    if (report.location) lines.push(`Місце в коді: ${report.location}`);
    lines.push('', 'Що користувач робив перед помилкою:');
    if (!report.scenario?.length) {
        lines.push('Немає записаних дій перед помилкою.');
    } else {
        report.scenario.forEach((step, index) => {
            lines.push(`${index + 1}. ${[step.label, step.what].filter(Boolean).join(' ')}`);
        });
    }
    if (report.stack) {
        lines.push('', 'Стек:', report.stack);
    }
    if (report.userAgent) lines.push('', `Браузер: ${report.userAgent}`);
    return lines.join('\n');
}

export function formatClientErrorTxt(reports) {
    return (Array.isArray(reports) ? reports : [])
        .map((report) => formatClientErrorReport(report))
        .join('\n\n-----\n\n');
}

export async function acceptClientError(raw, context, deps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, status: 400, error: 'Invalid report' };
    }
    const report = normalizeClientError(raw, context);
    if (!report) return { ok: true, status: 200, skipped: 'noise' };
    if (context?.isAdmin) return { ok: true, status: 200, skipped: 'admin' };

    const count = await deps.recentCount(report).catch(() => 0);
    if (count >= CLIENT_ERROR_BURST_LIMIT) return { ok: true, status: 200, dropped: true };

    const duplicate = await deps.wasNotified(report.fingerprint, context.now).catch(() => false);
    let stored = null;
    try {
        stored = await deps.insert(report);
    } catch {
        stored = null;
    }

    let notified = false;
    if (!duplicate) {
        try {
            notified = Boolean(await deps.notify(report));
        } catch {
            notified = false;
        }
        if (notified && stored?.id) {
            try {
                await deps.markNotified(stored.id);
            } catch { /* Лист уже пішов, навіть якщо позначку не зберегли. */ }
        }
    }

    return { ok: true, status: 200, stored: Boolean(stored?.id), notified };
}
