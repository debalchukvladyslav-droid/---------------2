// === Черга рев'ю для ментора / адміна (v1) ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { canAccessMentorReviewQueue } from './auth.js';
import { switchUser } from './teams.js';
import { switchMainTab } from './ui.js';
import { selectDateFromInput } from './calendar.js';
import { mergedJournalDayForReview, reviewReasonsForDay } from './review_signals.js';

const DEFAULT_TEAM = 'Без куща';

let _uiBound = false;

function localYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

function profileForUserId(userId) {
    for (const p of Object.values(state._teamProfiles || {})) {
        if (p.id === userId) return p;
    }
    return null;
}

function displayName(profile, nick) {
    if (profile?.first_name && profile?.last_name) {
        return `${profile.last_name} ${profile.first_name}`;
    }
    return nick || '—';
}

function getScopedUserIds() {
    const profiles = Object.values(state._teamProfiles || {});
    const ids = profiles.map((p) => p.id).filter(Boolean);
    if (state.myRole === 'admin') return [...new Set(ids)];

    if (!canAccessMentorReviewQueue()) return [];

    const myNick = state.USER_DOC_NAME?.replace('_stats', '') || '';
    const me = state._teamProfiles?.[myNick];
    const myTeam = me?.team || DEFAULT_TEAM;
    const sameTeam = profiles.filter((p) => (p.team || DEFAULT_TEAM) === myTeam);
    return [...new Set(sameTeam.map((p) => p.id).filter(Boolean))];
}

function rowReasons(row, metrics, lossThreshold) {
    return reviewReasonsForDay(mergedJournalDayForReview(row, metrics), lossThreshold);
}

function rowMatchesActiveFilters(reasons, active) {
    if (reasons.length === 0) return false;
    if (active.size === 0) return true;
    return reasons.some((r) => active.has(r.key));
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

function activeFilterSet() {
    const m = new Map([
        ['mentor', 'mr-f-need-mentor'],
        ['big', 'mr-f-big-loss'],
        ['err', 'mr-f-errors'],
        ['scr', 'mr-f-no-screens'],
        ['sess', 'mr-f-no-session'],
        ['ask', 'mr-f-notes-request'],
        ['ai', 'mr-f-ai-hint'],
        ['inc', 'mr-f-incomplete'],
    ]);
    const active = new Set();
    for (const [key, id] of m) {
        if (document.getElementById(id)?.checked) active.add(key);
    }
    return active;
}

export async function refreshMentorReviewQueue() {
    const root = document.getElementById('mentor-review-root');
    const tbody = document.getElementById('mentor-review-tbody');
    const meta = document.getElementById('mentor-review-meta');
    if (!root || !tbody) return;

    if (!canAccessMentorReviewQueue()) {
        tbody.innerHTML = '';
        if (meta) meta.textContent = 'Немає доступу';
        setMentorReviewNavBadges(0);
        return;
    }

    const days = parseInt(document.getElementById('mr-days')?.value || '1', 10) || 1;
    const lossTh = parseFloat(document.getElementById('mr-loss-threshold')?.value || '-200') || -200;

    const end = new Date();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    start.setDate(end.getDate() - (Math.max(1, days) - 1));
    const startStr = localYmd(start);
    const endStr = localYmd(end);

    const userIds = getScopedUserIds();
    if (userIds.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="mentor-review-empty">Немає профілів у кущі або команди ще не завантажені.</td></tr>`;
        if (meta) meta.textContent = '';
        setMentorReviewNavBadges(0);
        return;
    }

    tbody.innerHTML = `<tr><td colspan="5" class="mentor-review-empty">Завантаження…</td></tr>`;
    if (meta) meta.textContent = '';

    const chunks = [];
    for (let i = 0; i < userIds.length; i += 60) chunks.push(userIds.slice(i, i + 60));

    const rows = [];
    try {
        for (const chunk of chunks) {
            const { data, error } = await supabase
                .from('journal_days')
                .select('id, user_id, trade_date, pnl, notes, mentor_comment, ai_advice, daily_metrics')
                .in('user_id', chunk)
                .gte('trade_date', startStr)
                .lte('trade_date', endStr)
                .order('trade_date', { ascending: false })
                .limit(500);

            if (error) throw error;
            rows.push(...(data || []));
        }
    } catch (e) {
        console.error('[mentor_review]', e);
        tbody.innerHTML = `<tr><td colspan="5" class="mentor-review-empty">Помилка: ${String(e.message || e)}</td></tr>`;
        setMentorReviewNavBadges(0);
        return;
    }

    const active = activeFilterSet();
    const filtered = [];

    for (const row of rows) {
        const metrics = parseMetrics(row.daily_metrics);
        const prof = profileForUserId(row.user_id);
        const nick = prof?.nick;
        if (!nick) continue;
        if (state.myRole !== 'admin' && row.user_id === state.myUserId) continue;

        const reasons = rowReasons(row, metrics, lossTh);
        if (!rowMatchesActiveFilters(reasons, active)) continue;
        filtered.push({ row, metrics, prof, nick, reasons });
    }

    filtered.sort((a, b) => {
        const d = String(b.row.trade_date).localeCompare(String(a.row.trade_date));
        if (d !== 0) return d;
        return (parseFloat(a.row.pnl) || 0) - (parseFloat(b.row.pnl) || 0);
    });

    if (meta) {
        meta.textContent = `Показано ${filtered.length} з ${rows.length} записів (${periodMetaLabel(days)}, після фільтрів)`;
    }

    setMentorReviewNavBadges(filtered.length);

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="mentor-review-empty">Нічого не підпадає під обрані фільтри. Спробуйте зняти галочки або збільшити період.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered
        .map(({ row, prof, nick, reasons }) => {
            const pnl = parseFloat(row.pnl);
            const pnlStr = Number.isFinite(pnl) ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$' : '—';
            const pnlClass = pnl < 0 ? 'neg' : pnl > 0 ? 'pos' : '';
            const badges = reasons
                .map((r) => `<span class="mentor-review-tag" data-k="${r.key}">${escapeHtml(r.label)}</span>`)
                .join('');
            return `<tr>
                <td class="mr-cell-date">${escapeHtml(row.trade_date)}</td>
                <td class="mr-cell-name">${escapeHtml(displayName(prof, nick))}<div class="mr-cell-nick">${escapeHtml(nick)}</div></td>
                <td class="mr-cell-pnl ${pnlClass}">${pnlStr}</td>
                <td class="mr-cell-tags">${badges}</td>
                <td class="mr-cell-act"><button type="button" class="btn-secondary mr-open-btn" data-nick="${escapeHtml(nick)}" data-date="${escapeHtml(row.trade_date)}">Відкрити</button></td>
            </tr>`;
        })
        .join('');
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
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
        const v = document.getElementById('mr-days')?.value || '1';
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
