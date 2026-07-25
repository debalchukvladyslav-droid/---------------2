import { state } from './state.js';
import { supabase } from './supabase.js';
import { calculateJournalScore } from './journal_score_core.js';

export async function renderJournalScore() {
    const chip = document.getElementById('journal-score-chip');
    if (!chip) return;
    let reviews = [];
    const userId = state.currentViewedUserId || state.myUserId;
    if (userId) {
        const { data, error } = await supabase
            .from('stop_reviews')
            .select('trade_date,active,initial_status,final_status')
            .eq('user_id', userId);
        if (!error) reviews = data || [];
    }
    const result = calculateJournalScore({
        journal: state.appData?.journal || {},
        reviews,
        learnCache: state.appData?.learnCache,
    });
    const value = document.getElementById('journal-score-value');
    const label = document.getElementById('journal-score-label');
    const ring = document.getElementById('journal-score-ring');
    if (value) value.textContent = result.score == null ? '—' : String(result.score);
    if (label) label.textContent = result.label;
    if (ring) ring.style.setProperty('--journal-score', `${(result.score || 0) * 10}%`);
    chip.title = `Індекс ведення журналу. ${result.details}`;
    chip.classList.toggle('has-score', result.score != null);
}

document.addEventListener('app:shell-ready', () => void renderJournalScore());
window.addEventListener('journal:score-refresh', () => void renderJournalScore());
