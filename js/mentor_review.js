// === Матриця рев'ю для ментора / адміна ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { canAccessMentorReviewQueue } from './auth.js';
import { switchUser } from './teams.js';
import { switchMainTab } from './ui.js';
import { selectDateFromInput } from './calendar.js';

const DEFAULT_TEAM = 'Без куща';
const SEEN_KEY = 'tj:mentor-review-red-seen:v2';

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

function weekdaysBetween(start, end) {
    const out = [];
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    while (d <= end) {
        if (isWeekday(d)) out.push(localYmd(d));
        d.setDate(d.getDate() + 1);
    }
    return out;
}

function getKyivClock() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date()).reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
    }, {});

    const hour = Number(parts.hour || 0);
    const minute = Number(parts.minute || 0);
    return {
        today: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: hour * 60 + minute,
        afterDeadline: hour * 60 + minute >= 19 * 60,
    };
}

function getPeriodDates(period = 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    let start = new Date(today);
    let label = 'сьогодні';

    if (period === '3d') {
        label = '3 дні';
        const dates = [];
        let d = new Date(today);
        while (dates.length < 3) {
            if (isWeekday(d)) dates.unshift(localYmd(d));
            d = addDays(d, -1);
        }
        return { start: parseYmd(dates[0]), end, dates, label };
    }

    if (period === 'week') {
        label = 'цей тиждень';
        const day = today.getDay() || 7;
        start = addDays(today, 1 - day);
    } else if (period === 'month') {
        label = 'місяць';
        start = new Date(today.getFullYear(), today.getMonth(), 1);
    }

    const dates = weekdaysBetween(start, end);
    if (dates.length === 0 && period === 'today') dates.push(localYmd(today));
    return { start, end, dates, label };
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

function profileDisplayName(profile) {
    if (profile?.first_name && profile?.last_name) return `${profile.last_name} ${profile.first_name}`;
    if (profile?.first_name) return profile.first_name;
    if (profile?.last_name) return profile.last_name;
    return profile?.nick || '—';
}

function profileSettings(profile) {
    return profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
}

function getTraderDayloss(profile, periodStart) {
    const settings = profileSettings(profile);
    const monthKey = localYmd(periodStart || new Date()).slice(0, 7);
    const monthly = settings.monthlyDayloss && typeof settings.monthlyDayloss === 'object'
        ? Number(settings.monthlyDayloss[monthKey])
        : NaN;
    const base = Number.isFinite(monthly)
        ? monthly
        : Number(settings.defaultDayloss ?? settings.daylossLimit ?? -100);
    return Math.max(1, Math.abs(Number.isFinite(base) ? base : -100));
}

function getScopedProfiles() {
    if (!canAccessMentorReviewQueue()) return [];

    const myNick = state.USER_DOC_NAME ? state.USER_DOC_NAME.replace('_stats', '') : '';
    const myTeam = state._teamProfiles?.[myNick]?.team || DEFAULT_TEAM;

    return Object.values(state._teamProfiles || {})
        .filter((p) => {
            if (!p?.id || !p?.nick || p.mentor_enabled || p.role === 'mentor') return false;
            if (state.myRole === 'admin') return true;
            return (p.team || DEFAULT_TEAM) === myTeam;
        })
        .sort((a, b) => {
            const teamCmp = String(a.team || DEFAULT_TEAM).localeCompare(String(b.team || DEFAULT_TEAM), 'uk');
            if (teamCmp !== 0) return teamCmp;
            return profileDisplayName(a).localeCompare(profileDisplayName(b), 'uk');
        });
}

function makeRowKey(userId, dateStr) {
    return `${userId}__${dateStr}`;
}

function rowPnl(row) {
    if (!row) return null;
    const directRaw = row.pnl;
    const direct = directRaw === null || directRaw === undefined || directRaw === '' ? NaN : Number(directRaw);
    if (Number.isFinite(direct)) return direct;
    const metrics = parseMetrics(row?.daily_metrics);
    const nestedRaw = metrics?.pnl ?? metrics?.gross_pnl;
    const nested = nestedRaw === null || nestedRaw === undefined || nestedRaw === '' ? NaN : Number(nestedRaw);
    return Number.isFinite(nested) ? nested : null;
}

function hasPreparation(row) {
    if (!row) return false;
    const m = parseMetrics(row.daily_metrics);
    const values = [
        m.sessionGoal,
        m.sessionPlan,
        m.sessionPrep,
        m.session_preparation,
        m.preparation,
        m.plan,
    ];
    if (values.some((v) => String(v || '').trim())) return true;
    if (Array.isArray(m.checkedParams) && m.checkedParams.length > 0) return true;
    return Array.isArray(m.checklist) && m.checklist.some((x) => x?.checked || x === true);
}

function hasThought(row) {
    return !!String(row?.notes || '').trim();
}

function isPastDeadline(dateStr, kyiv) {
    if (dateStr < kyiv.today) return true;
    if (dateStr > kyiv.today) return false;
    return kyiv.afterDeadline;
}

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}$`;
}

function shortDates(dates, max = 3) {
    if (!dates.length) return '';
    const head = dates.slice(0, max).join(', ');
    return dates.length > max ? `${head} +${dates.length - max}` : head;
}

function makeBaseCell(key, label, missingDates, pendingDates, okDetail = 'заповнено') {
    if (missingDates.length) {
        return {
            key,
            label,
            tone: 'red',
            detail: `не заповнено: ${shortDates(missingDates)}`,
            date: missingDates[0],
        };
    }
    if (pendingDates.length) {
        return {
            key,
            label,
            tone: 'gray',
            detail: `очікує: ${shortDates(pendingDates)}`,
            date: pendingDates[0],
        };
    }
    return { key, label, tone: 'green', detail: okDetail, date: null };
}

function calcDrawdown(rows) {
    let equity = 0;
    let peak = 0;
    let worst = 0;

    for (const row of rows) {
        const pnl = rowPnl(row);
        if (!Number.isFinite(pnl)) continue;
        equity += pnl;
        peak = Math.max(peak, equity);
        worst = Math.min(worst, equity - peak);
    }

    return worst;
}

function buildTraderReview(profile, rowMap, dates, kyiv, periodStart) {
    const dayloss = getTraderDayloss(profile, periodStart);
    const rows = dates
        .map((date) => rowMap.get(makeRowKey(profile.id, date)))
        .filter(Boolean)
        .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));

    const missingPrep = [];
    const pendingPrep = [];
    const missingPnl = [];
    const pendingPnl = [];
    const missingThought = [];
    const pendingThought = [];
    const negativeDays = [];
    const bigLossDays = [];
    let totalPnl = 0;
    let pnlCount = 0;

    for (const date of dates) {
        const row = rowMap.get(makeRowKey(profile.id, date));
        const pastDeadline = isPastDeadline(date, kyiv);
        const pnl = rowPnl(row);

        if (!hasPreparation(row)) {
            (pastDeadline ? missingPrep : pendingPrep).push(date);
        }

        if (!Number.isFinite(pnl)) {
            (pastDeadline ? missingPnl : pendingPnl).push(date);
        } else {
            pnlCount++;
            totalPnl += pnl;
            if (pnl < 0) negativeDays.push({ date, pnl });
            if (pnl <= -(dayloss * 0.5)) bigLossDays.push({ date, pnl });
        }

        if (!hasThought(row)) {
            (pastDeadline ? missingThought : pendingThought).push(date);
        }
    }

    const cells = [
        makeBaseCell('prep', 'Підготовка до сесії', missingPrep, pendingPrep),
        makeBaseCell('pnl', 'Результат PnL', missingPnl, pendingPnl, pnlCount ? money(totalPnl) : 'заповнено'),
        makeBaseCell('thought', 'Думка дня', missingThought, pendingThought),
    ];

    if (!missingPnl.length && !pendingPnl.length && negativeDays.length) {
        const pnlCell = cells.find((c) => c.key === 'pnl');
        if (pnlCell) {
            pnlCell.tone = 'red';
            pnlCell.detail = `мінус: ${money(totalPnl)}`;
            pnlCell.date = negativeDays[0].date;
        }
    }

    if (bigLossDays.length) {
        const worst = bigLossDays.reduce((acc, item) => item.pnl < acc.pnl ? item : acc, bigLossDays[0]);
        cells.push({
            key: 'big-loss',
            label: 'Великий мінус',
            tone: 'red',
            detail: `${money(worst.pnl)} / ліміт ${money(-dayloss * 0.5)}`,
            date: worst.date,
        });
    }

    if (negativeDays.length) {
        cells.push({
            key: 'negative-days',
            label: 'Мінусові дні',
            tone: 'red',
            detail: `${negativeDays.length} дн. · ${money(negativeDays.reduce((s, x) => s + x.pnl, 0))}`,
            date: negativeDays[0].date,
        });
    }

    const drawdown = calcDrawdown(rows);
    if (Math.abs(drawdown) > dayloss) {
        cells.push({
            key: 'drawdown',
            label: 'Великий відкат',
            tone: 'red',
            detail: `${money(drawdown)} / дейлос ${money(-dayloss)}`,
            date: rows.find((row) => rowPnl(row) < 0)?.trade_date || dates[0],
        });
    }

    return {
        profile,
        dayloss,
        cells,
        redCount: cells.filter((c) => c.tone === 'red').length,
        openDate: cells.find((c) => c.tone === 'red' && c.date)?.date || dates[dates.length - 1],
    };
}

async function fetchRowsForProfiles(profiles, startStr, endStr) {
    const userIds = [...new Set(profiles.map((p) => p.id).filter(Boolean))];
    const rows = [];

    for (let i = 0; i < userIds.length; i += 60) {
        const chunk = userIds.slice(i, i + 60);
        const { data, error } = await supabase
            .from('journal_days')
            .select('id, user_id, trade_date, pnl, notes, daily_metrics')
            .in('user_id', chunk)
            .gte('trade_date', startStr)
            .lte('trade_date', endStr)
            .order('trade_date', { ascending: true })
            .limit(2000);

        if (error) throw error;
        rows.push(...(data || []));
    }

    const rowMap = new Map();
    for (const row of rows) {
        row.daily_metrics = parseMetrics(row.daily_metrics);
        rowMap.set(makeRowKey(row.user_id, row.trade_date), row);
    }
    return rowMap;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderCell(cell) {
    return `
        <button type="button" class="mr-status-cell is-${escapeHtml(cell.tone)} mr-open-btn" data-date="${escapeHtml(cell.date || '')}">
            <span class="mr-status-dot" aria-hidden="true"></span>
            <span class="mr-status-label">${escapeHtml(cell.label)}</span>
            <span class="mr-status-detail">${escapeHtml(cell.detail)}</span>
        </button>
    `;
}

function renderTraderRow(item) {
    const p = item.profile;
    const name = profileDisplayName(p);
    const team = p.team || DEFAULT_TEAM;
    const redText = item.redCount ? `${item.redCount} черв.` : 'ок';

    return `
        <article class="mentor-review-row ${item.redCount ? 'has-red' : ''}">
            <button type="button" class="mentor-review-main mr-open-btn" data-nick="${escapeHtml(p.nick)}" data-date="${escapeHtml(item.openDate || '')}">
                <span class="mentor-review-person">
                    <span class="mentor-review-name">${escapeHtml(name)}</span>
                    <span class="mentor-review-nick">${escapeHtml(p.nick)} · ${escapeHtml(team)}</span>
                </span>
                <span class="mentor-review-status">${escapeHtml(redText)}</span>
            </button>
            <div class="mr-status-grid" data-nick="${escapeHtml(p.nick)}">
                ${item.cells.map((cell) => renderCell(cell)).join('')}
            </div>
        </article>
    `;
}

/** Оновлює цифри на кнопках «Рев'ю» (сайдбар і мобільне меню). */
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

    const period = document.getElementById('mr-period')?.value || 'today';
    const { start, end, dates, label } = getPeriodDates(period);
    const profiles = getScopedProfiles();
    const kyiv = getKyivClock();

    if (!profiles.length) {
        list.innerHTML = `<div class="mentor-review-empty">Немає трейдерів або команда ще не завантажена.</div>`;
        if (meta) meta.textContent = '';
        setMentorReviewNavBadges(0);
        return;
    }

    if (!dates.length) {
        list.innerHTML = `<div class="mentor-review-empty">Для цього періоду немає торгових днів.</div>`;
        if (meta) meta.textContent = '';
        setMentorReviewNavBadges(0);
        return;
    }

    list.innerHTML = `<div class="mentor-review-empty">Завантаження...</div>`;
    if (meta) meta.textContent = '';

    try {
        const rowMap = await fetchRowsForProfiles(profiles, localYmd(start), localYmd(end));
        const items = profiles.map((profile) => buildTraderReview(profile, rowMap, dates, kyiv, start));
        const redTotal = items.reduce((sum, item) => sum + item.redCount, 0);

        setMentorReviewNavBadges(redTotal);
        if (meta) {
            meta.textContent = `${redTotal} червоних клітинок · ${profiles.length} трейдерів · ${label}`;
        }

        list.innerHTML = items.map(renderTraderRow).join('');
    } catch (e) {
        console.error('[mentor_review]', e);
        list.innerHTML = `<div class="mentor-review-empty">Помилка: ${escapeHtml(e.message || e)}</div>`;
        setMentorReviewNavBadges(0);
    }
}

function readSeenSet() {
    try {
        const arr = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

function writeSeenSet(seen) {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-800)));
    } catch {
        // localStorage can be unavailable in private contexts.
    }
}

export async function fetchMentorReviewNotificationHits() {
    if (!canAccessMentorReviewQueue()) return [];

    const profiles = getScopedProfiles();
    if (!profiles.length) return [];

    const period = getPeriodDates('today');
    if (!period.dates.length) return [];

    const kyiv = getKyivClock();
    const rowMap = await fetchRowsForProfiles(profiles, localYmd(period.start), localYmd(period.end));
    const seen = readSeenSet();
    const hits = [];

    for (const profile of profiles) {
        const item = buildTraderReview(profile, rowMap, period.dates, kyiv, period.start);
        const redCells = item.cells.filter((cell) => cell.tone === 'red');
        for (const cell of redCells) {
            const key = `${profile.id}|${cell.key}|${cell.date || kyiv.today}|${cell.detail}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push({
                title: `Рев'ю: ${profileDisplayName(profile)}`,
                body: `${cell.label}: ${cell.detail}`,
                href: 'tab:mentor-review',
            });
        }
    }

    if (hits.length) writeSeenSet(seen);
    return hits;
}

async function openTraderDay(nick, dateStr) {
    if (!nick) return;
    try {
        await switchUser(nick);
        switchMainTab('dash');
        if (dateStr) selectDateFromInput(dateStr);
        showToast(`Відкрито: ${nick}${dateStr ? ` · ${dateStr}` : ''}`);
    } catch (e) {
        console.error(e);
        showToast('Помилка: ' + (e.message || String(e)));
    }
}

function scheduleRefresh() {
    clearTimeout(scheduleRefresh._t);
    scheduleRefresh._t = setTimeout(() => {
        void refreshMentorReviewQueue();
    }, 150);
}

export function initMentorReviewUI() {
    if (_uiBound || !canAccessMentorReviewQueue()) return;
    _uiBound = true;

    const root = document.getElementById('mentor-review-root');
    if (!root) return;

    root.querySelector('#mr-refresh-btn')?.addEventListener('click', () => void refreshMentorReviewQueue());

    const syncMrPeriodButtons = () => {
        const v = document.getElementById('mr-period')?.value || 'today';
        root.querySelectorAll('.mr-period-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-mr-period') === v);
        });
    };

    root.querySelector('.mr-period')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-period-btn');
        if (!btn || !root.contains(btn)) return;
        const period = btn.getAttribute('data-mr-period');
        const hidden = document.getElementById('mr-period');
        if (hidden && period) {
            hidden.value = period;
            syncMrPeriodButtons();
            scheduleRefresh();
        }
    });
    syncMrPeriodButtons();

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-open-btn');
        if (!btn) return;
        const row = btn.closest('.mentor-review-row');
        const nick = btn.getAttribute('data-nick') || row?.querySelector('.mr-status-grid')?.getAttribute('data-nick');
        const date = btn.getAttribute('data-date') || row?.querySelector('.mentor-review-main')?.getAttribute('data-date');
        void openTraderDay(nick, date);
    });
}
