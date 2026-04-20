// === Центр сповіщень (в додатку + системні Notification API) ===
import { state } from './state.js';
import { showToast } from './utils.js';
import { isMentorViewingOtherJournal } from './auth.js';

const STORAGE_LIST = 'pj:inbox-notifications';
const STORAGE_SNAPSHOT = 'pj:notif-snapshot-v1';
const MAX_ITEMS = 80;

function readList() {
    try {
        const raw = localStorage.getItem(STORAGE_LIST);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function writeList(items) {
    localStorage.setItem(STORAGE_LIST, JSON.stringify(items.slice(0, MAX_ITEMS)));
}

function readSnapshot() {
    try {
        const raw = localStorage.getItem(STORAGE_SNAPSHOT);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeSnapshot(obj) {
    localStorage.setItem(STORAGE_SNAPSHOT, JSON.stringify(obj));
}

function uid() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function addNotification({ type, title, body, href }) {
    const list = readList();
    const id = uid();
    const item = {
        id,
        type: type || 'info',
        title: String(title || 'Сповіщення'),
        body: body ? String(body) : '',
        href: href || '',
        t: Date.now(),
        read: false,
    };
    list.unshift(item);
    writeList(list);
    updateBellBadge();
    renderDropdown();
    tryDesktopNotify(item.title, item.body);
    return id;
}

function tryDesktopNotify(title, body) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
        new Notification(title, { body: body || '', tag: 'tj-pro', silent: false });
    } catch (_) {}
}

export async function requestNotificationPermission() {
    if (typeof Notification === 'undefined') {
        showToast('Браузер не підтримує сповіщення');
        return 'unsupported';
    }
    const cur = Notification.permission;
    if (cur === 'granted') {
        showToast('Сповіщення вже увімкнені');
        return 'granted';
    }
    if (cur === 'denied') {
        showToast('Доступ заборонено в налаштуваннях браузера');
        return 'denied';
    }
    const p = await Notification.requestPermission();
    if (p === 'granted') {
        showToast('Сповіщення на ПК увімкнено');
        tryDesktopNotify('TJ Pro', 'Ви отримуватимете нагадування та події тут і в системі.');
    } else {
        showToast('Дозвіл не надано');
    }
    return p;
}

function updateBellBadge() {
    const n = readList().filter((x) => !x.read).length;
    document.querySelectorAll('.notif-bell-badge').forEach((el) => {
        if (n > 0) {
            el.textContent = n > 99 ? '99+' : String(n);
            el.hidden = false;
        } else {
            el.textContent = '';
            el.hidden = true;
        }
    });
}

function renderDropdown() {
    const root = document.getElementById('notif-dropdown-list');
    if (!root) return;
    root.textContent = '';
    const safeItems = readList();
    if (safeItems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'notif-empty';
        empty.textContent = 'Поки порожньо - з’являться події з журналу та ментора.';
        root.appendChild(empty);
        return;
    }

    safeItems.forEach((it) => {
        const row = document.createElement('div');
        row.className = `notif-row${it.read ? '' : ' notif-row--unread'}`;
        row.role = 'button';
        row.tabIndex = 0;

        const title = document.createElement('div');
        title.className = 'notif-row-title';
        title.textContent = it.title ?? '';

        const body = document.createElement('div');
        body.className = 'notif-row-body';
        body.textContent = it.body ?? '';

        const meta = document.createElement('div');
        meta.className = 'notif-row-meta';
        meta.textContent = new Date(it.t).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });

        const activate = () => handleNotificationRowClick(it.id, it.href);
        row.addEventListener('click', activate);
        row.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            activate();
        });

        row.appendChild(title);
        row.appendChild(body);
        row.appendChild(meta);
        root.appendChild(row);
    });
}

function markAllRead() {
    const list = readList().map((x) => ({ ...x, read: true }));
    writeList(list);
    updateBellBadge();
    renderDropdown();
}

function markOneRead(id) {
    const list = readList().map((x) => (x.id === id ? { ...x, read: true } : x));
    writeList(list);
    updateBellBadge();
    renderDropdown();
}

/** Періодична перевірка: зміни менторського коментаря, тег розбору, порожній сьогоднішній день. */
function closeNotificationPanel() {
    document.getElementById('notif-dropdown')?.classList.remove('open');
    document.getElementById('notif-dropdown-backdrop')?.classList.remove('visible');
}

function openNotificationHref(href) {
    const tabs = {
        'tab:dash': 'dash',
        'tab:calendar': 'calendar',
        'tab:mentor-review': 'mentor-review',
    };
    const target = tabs[href];
    if (target && window.switchMainTab) window.switchMainTab(target);
}

function handleNotificationRowClick(id, href = '') {
    markOneRead(id);
    openNotificationHref(href);
    closeNotificationPanel();
}

export function scanJournalForNotifications() {
    if (!state.USER_DOC_NAME || !state.appData?.journal) return;

    const snap = readSnapshot();
    const today = state.todayObj;
    const y = today.getFullYear();
    const mo = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const todayStr = `${y}-${mo}-${d}`;
    const day = state.appData.journal[todayStr] || {};
    const notes = String(day.notes || '');
    const mentor = String(day.mentor_comment || '');

    const keyM = `m:${state.CURRENT_VIEWED_USER || 'me'}:${todayStr}`;
    const prevM = snap[keyM] || '';
    if (mentor && mentor !== prevM) {
        snap[keyM] = mentor;
        writeSnapshot(snap);
        if (!isMentorViewingOtherJournal()) {
            const appr = /(схвал|прийнят|зарахован|розглянув|переглянув|ok\b|ок\b|✓|готово)/i.test(mentor);
            const keyAppr = `appr:${state.CURRENT_VIEWED_USER || 'me'}:${todayStr}`;
            if (appr && !snap[keyAppr]) {
                snap[keyAppr] = '1';
                writeSnapshot(snap);
                addNotification({
                    type: 'mentor',
                    title: 'Ментор: розбір переглянуто / схвалено',
                    body: mentor.length > 120 ? mentor.slice(0, 120) + '…' : mentor,
                    href: `tab:dash`,
                });
            } else if (!appr) {
                addNotification({
                    type: 'mentor',
                    title: 'Коментар ментора',
                    body: mentor.length > 120 ? mentor.slice(0, 120) + '…' : mentor,
                    href: `tab:dash`,
                });
            }
        }
        return;
    }
    snap[keyM] = mentor;

    const keyAsk = `ask:${state.CURRENT_VIEWED_USER || 'me'}:${todayStr}`;
    const hadAsk = /#розбір|#review|#ментор/i.test(notes);
    if (!isMentorViewingOtherJournal() && hadAsk && !snap[keyAsk]) {
        snap[keyAsk] = '1';
        writeSnapshot(snap);
        addNotification({
            type: 'review',
            title: 'Запит на розбір',
            body: 'У нотатках дня додано тег для менторської черги.',
            href: `tab:calendar`,
        });
    }

    const hour = today.getHours();
    const pnlEmpty = day.pnl === null || day.pnl === undefined || String(day.pnl).trim() === '';
    const keyRem = `rem:${todayStr}`;
    if (!isMentorViewingOtherJournal() && hour >= 18 && pnlEmpty && !snap[keyRem]) {
        snap[keyRem] = '1';
        writeSnapshot(snap);
        addNotification({
            type: 'remind',
            title: 'Нагадування: день не закрито',
            body: 'Запишіть PnL або відмітку, що не торгували.',
            href: `tab:dash`,
        });
    }

    writeSnapshot(snap);
}

async function pollMentorReviewRequests() {
    try {
        const { fetchMentorReviewNotificationHits } = await import('./review_requests.js');
        const hits = await fetchMentorReviewNotificationHits();
        for (const h of hits) {
            addNotification({
                type: 'review',
                title: h.title,
                body: h.body,
                href: 'tab:mentor-review',
            });
        }
    } catch (e) {
        console.warn('[notif] mentor review poll', e);
    }
}

export function initNotifications() {
    const bell = document.getElementById('notif-bell-btn');
    const panel = document.getElementById('notif-dropdown');
    const backdrop = document.getElementById('notif-dropdown-backdrop');

    window.markNotifRead = (id) => {
        markOneRead(id);
    };
    window.handleNotifRowClick = (id, href) => {
        handleNotificationRowClick(id, href);
    };
    window.requestNotificationPermission = requestNotificationPermission;
    window.scanJournalForNotifications = scanJournalForNotifications;

    function closePanel() {
        closeNotificationPanel();
    }
    function togglePanel() {
        const open = panel?.classList.toggle('open');
        backdrop?.classList.toggle('visible', !!open);
        if (open) renderDropdown();
    }

    bell?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
    });
    backdrop?.addEventListener('click', closePanel);
    document.getElementById('notif-close-btn')?.addEventListener('click', closePanel);
    document.getElementById('notif-mark-all')?.addEventListener('click', () => {
        markAllRead();
        showToast('Усі позначено прочитаними');
    });
    document.getElementById('notif-enable-push')?.addEventListener('click', () => void requestNotificationPermission());

    updateBellBadge();
    renderDropdown();

    void pollMentorReviewRequests();

    setInterval(() => {
        scanJournalForNotifications();
        void pollMentorReviewRequests();
    }, 120000);

    document.addEventListener('click', (e) => {
        if (!panel?.classList.contains('open')) return;
        if (bell?.contains(e.target)) return;
        if (panel.contains(e.target)) return;
        closePanel();
    });
}
