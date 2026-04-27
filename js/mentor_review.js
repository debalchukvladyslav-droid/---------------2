// === Мінімалістична черга рев'ю для ментора / адміна ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { canAccessMentorReviewQueue } from './auth.js';
import { switchUser } from './teams.js';
import { switchMainTab } from './ui.js';
import { selectDateFromInput } from './calendar.js';

const DEFAULT_TEAM = 'Без куща';

let _uiBound = false;

function localYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseYmd(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, m - 1, d);
}

function addDays(date, amount) {
    const d = new Date(date);
    d.setDate(d.getDate() + amount);
    return d;
}

function isWeekday(date) {
    const day = date.getDay();
    return day >= 1 && day <= 5;
}

function previousTradingDay(fromDate = new Date()) {
    let d = addDays(fromDate, -1);
    while (!isWeekday(d)) d = addDays(d, -1);
    return localYmd(d);
}

function weekdaysBetween(start, end) {
    const out = [];
    const d = new Date(start);
    while (d <= end) {
        if (isWeekday(d)) out.push(localYmd(d));
        d.setDate(d.getDate() + 1);
    }
    return out;
}

function periodMetaLabel(days) {
    if (days <= 1) return 'сьогодні';
    if (days === 3) return 'останні 3 дні';
    if (days === 7) return 'останні 7 днів';
    return `останні ${days} дн.`;
}

function parseMetrics(raw) {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    try {
        return JSON.parse(String(raw));
    } catch {
        return {};
    }
}

function displayName(profile, nick) {
    if (profile?.first_name && profile?.last_name) {
        return `${profile.last_name} ${profile.first_name}`;
    }
    return nick || '—';
}

function getScopedProfiles() {
    const profiles = Object.values(state._teamProfiles || {});
    if (!canAccessMentorReviewQueue()) return [];

    const traderProfiles = profiles.filter((p) => p?.id && p?.nick && !p.mentor_enabled);
    if (state.myRole === 'admin') return traderProfiles;
    return traderProfiles;
}

function activeFilterSet() {
    const m = new Map([
        ['inc', 'mr-f-incomplete'],
        ['note', 'mr-f-no-note'],
        ['streak', 'mr-f-loss-streak'],
        ['big', 'mr-f-big-loss'],
    ]);
    const active = new Set();
    for (const [key, id] of m) {
        if (document.getElementById(id)?.checked) active.add(key);
    }
    return active;
}

function rowMatchesActiveFilters(reasons, active) {
    if (reasons.length === 0) return false;
    if (active.size === 0) return true;
    return reasons.some((r) => active.has(r.key));
}

function dateLabel(dateStr, todayStr, prevTradeStr) {
    if (dateStr === todayStr) return 'сьогодні';
    if (dateStr === prevTradeStr) return 'попередній день';
    return dateStr;
}

function pnlNumber(row) {
    const n = parseFloat(row?.pnl);
    return Number.isFinite(n) ? n : null;
}

function hasNotes(row) {
    return !!String(row?.notes || '').trim();
}

function makeRowKey(userId, dateStr) {
    return `${userId}__${dateStr}`;
}

function lossStreakLength(rowMap, userId, dateStr) {
    let count = 0;
    let d = parseYmd(dateStr);
    while (count < 20) {
        const key = localYmd(d);
        const row = rowMap.get(makeRowKey(userId, key));
        const pnl = pnlNumber(row);
        if (!(Number.isFinite(pnl) && pnl < 0)) break;
        count++;
        d = addDays(d, -1);
        while (!isWeekday(d)) d = addDays(d, -1);
    }
    return count;
}

function buildQueueItem({ profile, dateStr, row, lossThreshold, rowMap, todayStr, prevTradeStr }) {
    const pnl = pnlNumber(row);
    const hasRow = !!row;
    const reasons = [];
    const dateKind = dateLabel(dateStr, todayStr, prevTradeStr);

    if (!hasRow) {
        reasons.push({
            key: 'inc',
            label: dateKind === 'попередній день'
                ? 'попередній день: не заповнив дані'
                : 'не заповнив дані за день',
            tone: 'warn',
        });
    } else {
        if (Number.isFinite(pnl) && pnl <= lossThreshold) {
            reasons.push({ key: 'big', label: 'великий мінус за день', tone: 'loss' });
        }
        if (Number.isFinite(pnl) && pnl < 0) {
            const streak = lossStreakLength(rowMap, profile.id, dateStr);
            if (streak >= 2) {
                reasons.push({ key: 'streak', label: `мінус ${streak} дні підряд`, tone: 'loss' });
            }
        }
        if (Number.isFinite(pnl) && Math.abs(pnl) > 1e-9 && !hasNotes(row)) {
            reasons.push({ key: 'note', label: 'не записана думка', tone: 'warn' });
        }
        if (!Number.isFinite(pnl)) {
            reasons.push({ key: 'inc', label: 'не заповнив PnL за день', tone: 'warn' });
        }
    }

    return {
        profile,
        nick: profile.nick,
        dateStr,
        dateKind,
        row,
        pnl,
        reasons,
    };
}

/** Оновлює цифри на кнопках «Черга рев'ю» (сайдбар і мобільне меню). */
export function setMentorReviewNavBadges(count) {
    const n = Number.isFinite(count) && count > 0 ? Math.min(999, Math.floor(count)) : 0;
    document.querySelectorAll('.mentor-review-nav-badge').forEach((el) => {
        if (n > 0) {
            el.textContent = n > 99 ? '99+' : String(n);
            el.hidden = false;
        } else {
            el.textContent = '0';
            el.hidden = true;
        }
    });
}

export async function refreshMentorReviewQueue() {
    const root = document.getElementById('mentor-review-root');
    const list = document.getElementById('mentor-review-tbody');
    const meta = document.getElementById('mentor-review-meta');
    if (!root || !list) return;

    if (!canAccessMentorReviewQueue()) {
        list.innerHTML = '';
        if (meta) meta.textContent = 'Немає доступу';
        setMentorReviewNavBadges(0);
        return;
    }

    const days = parseInt(document.getElementById('mr-days')?.value || '3', 10) || 3;
    const lossTh = parseFloat(document.getElementById('mr-loss-threshold')?.value || '-200') || -200;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    const start = new Date(today);
    start.setDate(end.getDate() - (Math.max(1, days) - 1));

    const todayStr = localYmd(today);
    const prevTradeStr = previousTradingDay(today);
    const visibleDates = weekdaysBetween(start, end);
    const fetchStart = addDays(start, -14);
    const fetchStartStr = localYmd(fetchStart);
    const endStr = localYmd(end);

    const profiles = getScopedProfiles();
    if (profiles.length === 0) {
        list.innerHTML = `<div class="mentor-review-empty">Немає трейдерів у кущі або команда ще не завантажена.</div>`;
        if (meta) meta.textContent = '';
        setMentorReviewNavBadges(0);
        return;
    }

    list.innerHTML = `<div class="mentor-review-empty">Завантаження...</div>`;
    if (meta) meta.textContent = '';

    const userIds = [...new Set(profiles.map((p) => p.id).filter(Boolean))];
    const chunks = [];
    for (let i = 0; i < userIds.length; i += 60) chunks.push(userIds.slice(i, i + 60));

    const rows = [];
    try {
        for (const chunk of chunks) {
            const { data, error } = await supabase
                .from('journal_days')
                .select('id, user_id, trade_date, pnl, notes, mentor_comment, ai_advice, daily_metrics')
                .in('user_id', chunk)
                .gte('trade_date', fetchStartStr)
                .lte('trade_date', endStr)
                .order('trade_date', { ascending: false })
                .limit(1200);

            if (error) throw error;
            rows.push(...(data || []));
        }
    } catch (e) {
        console.error('[mentor_review]', e);
        list.innerHTML = `<div class="mentor-review-empty">Помилка: ${escapeHtml(e.message || e)}</div>`;
        setMentorReviewNavBadges(0);
        return;
    }

    const rowMap = new Map();
    for (const row of rows) {
        row.daily_metrics = parseMetrics(row.daily_metrics);
        rowMap.set(makeRowKey(row.user_id, row.trade_date), row);
    }

    const active = activeFilterSet();
    const items = [];

    for (const profile of profiles) {
        if (state.myRole !== 'admin' && profile.id === state.myUserId) continue;
        for (const dateStr of visibleDates) {
            const row = rowMap.get(makeRowKey(profile.id, dateStr));
            if (!row && dateStr >= todayStr) continue;

            const item = buildQueueItem({
                profile,
                dateStr,
                row,
                lossThreshold: lossTh,
                rowMap,
                todayStr,
                prevTradeStr,
            });

            if (!rowMatchesActiveFilters(item.reasons, active)) continue;
            items.push(item);
        }
    }

    items.sort((a, b) => {
        const d = String(b.dateStr).localeCompare(String(a.dateStr));
        if (d !== 0) return d;
        const pa = Number.isFinite(a.pnl) ? a.pnl : 0;
        const pb = Number.isFinite(b.pnl) ? b.pnl : 0;
        if (pa !== pb) return pa - pb;
        return displayName(a.profile, a.nick).localeCompare(displayName(b.profile, b.nick), 'uk');
    });

    if (meta) {
        meta.textContent = `${items.length} у черзі · ${periodMetaLabel(days)} · ${profiles.length} трейдерів`;
    }

    setMentorReviewNavBadges(items.length);

    if (items.length === 0) {
        list.innerHTML = `<div class="mentor-review-empty">Черга порожня. За обраний період критичних сигналів немає.</div>`;
        return;
    }

    list.innerHTML = items.map(renderQueueItem).join('');
}

function renderQueueItem(item) {
    const name = displayName(item.profile, item.nick);
    const primaryReason = item.reasons[0];
    const pnlClass = item.pnl < 0 ? 'neg' : item.pnl > 0 ? 'pos' : '';
    const pnlStr = Number.isFinite(item.pnl) ? `${item.pnl >= 0 ? '+' : ''}${item.pnl.toFixed(2)}$` : '';
    const reasonHtml = item.reasons
        .map((r) => `<span class="mentor-review-tag" data-k="${escapeHtml(r.key)}" data-tone="${escapeHtml(r.tone || '')}">${escapeHtml(r.label)}</span>`)
        .join('');

    return `
        <article class="mentor-review-row">
            <button type="button" class="mentor-review-main mr-open-btn" data-nick="${escapeHtml(item.nick)}" data-date="${escapeHtml(item.dateStr)}">
                <span class="mentor-review-person">
                    <span class="mentor-review-name">${escapeHtml(name)}</span>
                    <span class="mentor-review-nick">${escapeHtml(item.nick)}</span>
                </span>
                <span class="mentor-review-status">${escapeHtml(primaryReason?.label || 'потребує уваги')}</span>
            </button>
            <div class="mentor-review-side">
                <div class="mentor-review-date">${escapeHtml(item.dateKind)}</div>
                ${pnlStr ? `<div class="mr-cell-pnl ${pnlClass}">${pnlStr}</div>` : ''}
            </div>
            <div class="mr-cell-tags">${reasonHtml}</div>
        </article>
    `;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function openTraderDay(nick, dateStr) {
    if (!nick || !dateStr) return;
    try {
        await switchUser(nick);
        switchMainTab('dash');
        selectDateFromInput(dateStr);
        showToast(`Відкрито: ${nick} · ${dateStr}`);
    } catch (e) {
        console.error(e);
        showToast('Помилка: ' + (e.message || String(e)));
    }
}

function scheduleRefresh() {
    clearTimeout(scheduleRefresh._t);
    scheduleRefresh._t = setTimeout(() => {
        void refreshMentorReviewQueue();
    }, 200);
}

export function initMentorReviewUI() {
    if (_uiBound || !canAccessMentorReviewQueue()) return;
    _uiBound = true;

    const root = document.getElementById('mentor-review-root');
    if (!root) return;

    root.querySelector('#mr-refresh-btn')?.addEventListener('click', () => void refreshMentorReviewQueue());

    const syncMrPeriodButtons = () => {
        const v = document.getElementById('mr-days')?.value || '3';
        root.querySelectorAll('.mr-period-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-mr-days') === v);
        });
    };
    root.querySelector('.mr-period')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-period-btn');
        if (!btn || !root.contains(btn)) return;
        const d = btn.getAttribute('data-mr-days');
        const hidden = document.getElementById('mr-days');
        if (hidden && d) {
            hidden.value = d;
            syncMrPeriodButtons();
            scheduleRefresh();
        }
    });
    syncMrPeriodButtons();

    const lossEl = document.getElementById('mr-loss-threshold');
    lossEl?.addEventListener('change', scheduleRefresh);
    lossEl?.addEventListener('input', scheduleRefresh);
    root.querySelectorAll('input[type="checkbox"][id^="mr-f-"]').forEach((el) => {
        el.addEventListener('change', scheduleRefresh);
    });

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-open-btn');
        if (!btn) return;
        const nick = btn.getAttribute('data-nick');
        const date = btn.getAttribute('data-date');
        void openTraderDay(nick, date);
    });
}
