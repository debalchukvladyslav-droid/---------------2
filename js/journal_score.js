import { state } from './state.js';
import { supabase } from './supabase.js';
import { calculateJournalScore } from './journal_score_core.js';

export async function renderJournalScore() {
    const chip = document.getElementById('journal-score-chip');
    if (!chip) return;
    let reviews = [];
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const monthStart = `${year}-${month}-01`;
    const monthEnd = `${year}-${month}-${String(new Date(year, now.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
    const userId = state.currentViewedUserId || state.myUserId;
    if (userId) {
        const { data, error } = await supabase
            .from('stop_reviews')
            .select('trade_date,active,initial_status,final_status')
            .eq('user_id', userId)
            .gte('trade_date', monthStart)
            .lte('trade_date', monthEnd);
        if (!error) reviews = data || [];
    }
    const result = calculateJournalScore({
        journal: state.appData?.journal || {},
        reviews,
        learnCache: state.appData?.learnCache,
        learningDates: state.appData?.settings?.learningHistory || [],
        now,
    });
    const value = document.getElementById('journal-score-value');
    const label = document.getElementById('journal-score-label');
    const ring = document.getElementById('journal-score-ring');
    if (value) value.textContent = String(result.score ?? 0);
    if (label) label.textContent = result.label;
    const hue = Math.round(Math.max(0, Math.min(10, result.score || 0)) * 12);
    if (ring) {
        ring.style.setProperty('--journal-score', `${(result.score || 0) * 10}%`);
        ring.style.setProperty('--journal-score-color', `hsl(${hue} 78% 46%)`);
    }
    chip.style.setProperty('--journal-score-color', `hsl(${hue} 78% 46%)`);
    const days = document.getElementById('journal-score-days');
    const gaps = document.getElementById('journal-score-gaps');
    if (days) days.textContent = `${result.activeDays || 0}/${result.workDays || 0} робочих днів`;
    if (gaps) gaps.innerHTML = (result.gaps || []).length
        ? result.gaps.map(item => `<div class="journal-score-gap"><span>${item.label}</span><strong>${item.done}/${item.total}</strong><i><b style="width:${Math.round((item.done / item.total) * 100)}%"></b></i></div>`).join('')
        : '<div class="journal-score-all-good">Усі основні звички ведуться регулярно.</div>';
    chip.title = `Індекс ведення журналу. ${result.details}`;
    chip.classList.toggle('has-score', true);
}

function bindJournalScorePopover() {
    const chip = document.getElementById('journal-score-chip');
    const popover = document.getElementById('journal-score-popover');
    if (!chip || !popover || chip.dataset.bound) return;
    chip.dataset.bound = 'true';
    chip.addEventListener('click', event => {
        event.stopPropagation();
        const opening = popover.hidden;
        popover.hidden = !opening;
        chip.setAttribute('aria-expanded', String(opening));
    });
    popover.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => {
        popover.hidden = true;
        chip.setAttribute('aria-expanded', 'false');
    });
}

document.addEventListener('app:shell-ready', () => {
    bindJournalScorePopover();
    void renderJournalScore();
});
window.addEventListener('journal:score-refresh', () => void renderJournalScore());
