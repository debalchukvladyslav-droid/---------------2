// === Запити розбору до ментора куща (daily_metrics.review_requests) ===
import { state } from './state.js';
import { saveJournalData, markJournalDayDirty } from './storage.js';
import { showToast } from './utils.js';
import { getDefaultDayEntry } from './data_utils.js';
import { isMentorViewingOtherJournal } from './auth.js';
import { supabase } from './supabase.js';

const SEEN_POLL_KEY = 'pj:rr-mentor-seen';

function readSeen() {
    try {
        const raw = sessionStorage.getItem(SEEN_POLL_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeSeen(obj) {
    try {
        sessionStorage.setItem(SEEN_POLL_KEY, JSON.stringify(obj));
    } catch (_) {}
}

function getKyivClock() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
    }).formatToParts(new Date());
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return {
        date: `${v.year}-${v.month}-${v.day}`,
        hour: parseInt(v.hour || '0', 10) || 0,
        weekday: v.weekday || '',
    };
}

function isKyivTradingDay(weekday) {
    return !['Sat', 'Sun'].includes(String(weekday));
}

function pnlFieldEmpty(pnl) {
    return pnl === null || pnl === undefined || String(pnl).trim() === '';
}

export function getPrimaryMentorForMyTeam() {
    const myNick = (state.USER_DOC_NAME || '').replace('_stats', '');
    const profiles = Object.values(state._teamProfiles || {});
    const me = state._teamProfiles?.[myNick];
    const team = me?.team || 'Без куща';
    const mentors = profiles.filter(
        (p) => p && p.nick && p.nick !== myNick && p.mentor_enabled && (p.team || 'Без куща') === team
    );
    mentors.sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'uk'));
    const m = mentors[0];
    return m?.id && m?.nick ? { id: m.id, nick: m.nick } : null;
}

function ensureDay(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    if (!state.appData.journal[dateStr]) state.appData.journal[dateStr] = getDefaultDayEntry();
    if (!state.appData.journal[dateStr].review_requests || typeof state.appData.journal[dateStr].review_requests !== 'object') {
        state.appData.journal[dateStr].review_requests = {};
    }
    return state.appData.journal[dateStr];
}

function isPendingSlot(slot) {
    return slot && typeof slot === 'object' && slot.status === 'pending';
}

export function getReviewRequestSlot(dateStr, kind, screenKey = null) {
    const day = state.appData.journal[dateStr];
    const rr = day?.review_requests;
    if (!rr) return null;
    if (kind === 'screen_item' && screenKey) {
        return rr.by_screen?.[screenKey] || null;
    }
    return rr[kind] || null;
}

export async function submitReviewRequest(kind, screenKey = null) {
    if (isMentorViewingOtherJournal()) {
        showToast('Недоступно в режимі перегляду чужого журналу');
        return;
    }
    const dateStr = state.selectedDateStr;
    if (!dateStr) {
        showToast('Оберіть день у календарі');
        return;
    }
    const mentor = getPrimaryMentorForMyTeam();
    if (!mentor) {
        showToast('У вашому кущі немає наставника (ментор у профілі).');
        return;
    }
    const day = ensureDay(dateStr);
    if (!day) return;

    const payload = {
        status: 'pending',
        at: new Date().toISOString(),
        mentor_user_id: mentor.id,
        mentor_nick: mentor.nick,
        accepted_at: null,
        accepted_by: null,
    };

    if (kind === 'screen_item' && screenKey) {
        const sk = decodeURIComponent(screenKey);
        day.review_requests.by_screen = day.review_requests.by_screen || {};
        if (isPendingSlot(day.review_requests.by_screen[sk])) {
            showToast('Запит по цьому скріну вже активний');
            refreshReviewRequestButtons();
            return;
        }
        day.review_requests.by_screen[sk] = payload;
    } else {
        if (isPendingSlot(day.review_requests[kind])) {
            showToast('Цей запит уже активний');
            refreshReviewRequestButtons();
            return;
        }
        day.review_requests[kind] = payload;
    }

    try {
        markJournalDayDirty(dateStr);
        await saveJournalData();
    } catch (e) {
        console.error(e);
        showToast('Не вдалося зберегти запит');
        return;
    }

    showToast(`Запит надіслано ментору (${mentor.nick})`);
    refreshReviewRequestButtons();
    if (window.renderAssignedScreens) void window.renderAssignedScreens();
}

export function refreshReviewRequestButtons() {
    const dateStr = state.selectedDateStr;
    const rr = dateStr ? state.appData.journal[dateStr]?.review_requests : null;

    const setBtn = (id, kind, screenKey = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        const slot = screenKey ? rr?.by_screen?.[decodeURIComponent(screenKey)] : rr?.[kind];
        const pend = isPendingSlot(slot);
        el.classList.toggle('rr-toggle-btn--active', pend);
        el.disabled = pend;
        el.setAttribute('aria-pressed', pend ? 'true' : 'false');
    };

    setBtn('rr-btn-screens-general', 'screens_general');
    setBtn('rr-btn-calendar-profit', 'calendar_profit');

    document.querySelectorAll('.rr-screen-btn').forEach((btn) => {
        const enc = btn.getAttribute('data-screen-path');
        if (!enc) return;
        const sk = decodeURIComponent(enc);
        const slot = rr?.by_screen?.[sk];
        const pend = isPendingSlot(slot);
        btn.classList.toggle('rr-toggle-btn--active', pend);
        btn.disabled = pend;
    });

    const mentorPanel = document.getElementById('mentor-rr-panel');
    if (mentorPanel) {
        const show = isMentorViewingOtherJournal() && rr;
        mentorPanel.style.display = show ? 'block' : 'none';
        if (show) renderMentorAcceptList(rr, dateStr);
    }
}

function renderMentorAcceptList(rr, dateStr) {
    const host = document.getElementById('mentor-rr-list');
    if (!host) return;
    const myId = state.myUserId;
    const rows = [];

    ['screens_general', 'calendar_profit'].forEach((k) => {
        const s = rr[k];
        if (isPendingSlot(s) && s.mentor_user_id === myId) {
            rows.push({ kind: k, label: k === 'screens_general' ? 'Загальний розбір (скріни)' : 'Прибутковість / календар' });
        }
    });
    Object.entries(rr.by_screen || {}).forEach(([path, s]) => {
        if (isPendingSlot(s) && s.mentor_user_id === myId) {
            rows.push({ kind: 'screen_item', screenKey: path, label: `Скрін: ${path.split('/').pop() || path}` });
        }
    });

    if (rows.length === 0) {
        host.innerHTML = '<p class="rr-mentor-empty">Немає активних запитів на вас за цей день.</p>';
        return;
    }
    host.innerHTML = rows
        .map((r) => {
            const esc = (t) =>
                String(t)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/"/g, '&quot;');
            const sk = r.screenKey ? esc(encodeURIComponent(r.screenKey)) : '';
            return `<div class="rr-mentor-row">
                <span>${esc(r.label)}</span>
                <button type="button" class="btn-primary rr-accept-btn rr-exempt-access" data-rr-kind="${esc(r.kind)}" data-rr-screen="${sk}">Прийняти</button>
            </div>`;
        })
        .join('');

    host.querySelectorAll('.rr-accept-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const k = btn.getAttribute('data-rr-kind');
            const enc = btn.getAttribute('data-rr-screen') || '';
            await window.mentorAcceptReviewRequest?.(dateStr, k, enc ? decodeURIComponent(enc) : null);
        });
    });
}

/** Повертає нові події для ментора (без побічних імпортів у notifications). */
export async function fetchMentorReviewNotificationHits() {
    const hits = [];
    if (!state.myUserId || !state.USER_DOC_NAME) return hits;
    const myNick = state.USER_DOC_NAME.replace('_stats', '');
    const me = state._teamProfiles?.[myNick];
    if (!me?.mentor_enabled && state.myRole !== 'mentor' && state.myRole !== 'admin') return hits;

    const profiles = Object.values(state._teamProfiles || {});
    const team = me?.team || 'Без куща';
    const isTraderProfile = (p) => p?.id && !p.mentor_enabled && p.role !== 'mentor';
    const traderIds = profiles
        .filter((p) => isTraderProfile(p) && p.id !== state.myUserId && (p.team || 'Без куща') === team)
        .map((p) => p.id);
    if (!traderIds.length) return hits;

    const seen = readSeen();
    const kyiv = getKyivClock();
    if (kyiv.hour >= 19 && isKyivTradingDay(kyiv.weekday)) {
        try {
            const { data: dayRows, error: dayErr } = await supabase
                .from('journal_days')
                .select('user_id, trade_date, pnl')
                .in('user_id', traderIds)
                .eq('trade_date', kyiv.date)
                .limit(500);

            if (!dayErr) {
                const rowsByUser = new Map((dayRows || []).map((row) => [row.user_id, row]));
                for (const p of profiles) {
                    if (!isTraderProfile(p) || p.id === state.myUserId || (p.team || 'Без куща') !== team) continue;
                    const row = rowsByUser.get(p.id);
                    if (row && !pnlFieldEmpty(row.pnl)) continue;
                    const sid = `missing-day|${p.id}|${kyiv.date}`;
                    if (seen[sid]) continue;
                    seen[sid] = 1;
                    hits.push({
                        sid,
                        title: 'Трейдер не заповнив день',
                        body: `${p.nick || p.id} · ${kyiv.date} · після 19:00 Київ`,
                    });
                }
            }
        } catch (e) {
            console.warn('[review_requests] missing day notification', e);
        }
    }

    const from = new Date();
    from.setDate(from.getDate() - 45);
    const fromStr = from.toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from('journal_days')
        .select('user_id, trade_date, daily_metrics')
        .in('user_id', traderIds)
        .gte('trade_date', fromStr)
        .limit(400);

    if (error || !data) {
        writeSeen(seen);
        return hits;
    }

    for (const row of data) {
        const m = row.daily_metrics && typeof row.daily_metrics === 'object' ? row.daily_metrics : {};
        const rr = m.review_requests && typeof m.review_requests === 'object' ? m.review_requests : {};
        const prof = profiles.find((p) => p.id === row.user_id);
        const nick = prof?.nick || row.user_id;

        const push = (sid, title, body) => {
            if (seen[sid]) return;
            seen[sid] = 1;
            hits.push({ sid, title, body });
        };

        const checkSlot = (key, label) => {
            const slot = rr[key];
            if (!isPendingSlot(slot) || slot.mentor_user_id !== state.myUserId) return;
            const sid = `${row.user_id}|${row.trade_date}|${key}`;
            push(sid, 'Запит на розбір', `${nick} · ${row.trade_date} · ${label}`);
        };

        checkSlot('screens_general', 'скріни (загальне)');
        checkSlot('calendar_profit', 'прибутковість');
        Object.keys(rr.by_screen || {}).forEach((path) => {
            const slot = rr.by_screen[path];
            if (!isPendingSlot(slot) || slot.mentor_user_id !== state.myUserId) return;
            const sid = `${row.user_id}|${row.trade_date}|s:${path}`;
            push(sid, 'Запит на розбір (скрін)', `${nick} · ${row.trade_date}`);
        });
    }
    writeSeen(seen);
    return hits;
}
