import { supabase } from './supabase.js';

const el = (id) => document.getElementById(id);

export async function requestSessionCoachAnalysis(tradeDate, active = {}) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token || !tradeDate) return null;
    const response = await fetch('/api/gemini', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'coach-session', tradeDate, filters: active.filters || {}, selectedTradeKeys: active.selectedTradeKeys || [] }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'AI coach analysis failed');
    renderCoachInsight(payload.insight, tradeDate);
    return payload.insight;
}

export async function loadLatestCoachInsight() {
    const host = el('proactive-coach-card'); if (!host) return;
    const { data, error } = await supabase.from('ai_coach_insights').select('id,trade_date,severity,title,summary,evidence,recommendations,created_at').eq('status', 'ready').order('trade_date', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) { host.hidden = true; return; }
    renderCoachInsight(data, data.trade_date);
}

function renderCoachInsight(insight, tradeDate) {
    const host = el('proactive-coach-card'); if (!host || !insight) return;
    host.hidden = false; host.dataset.severity = insight.severity || 'info';
    if (insight.id) host.dataset.insightId = insight.id;
    el('proactive-coach-date').textContent = tradeDate || '';
    el('proactive-coach-title').textContent = insight.title || 'Розбір сесії';
    el('proactive-coach-summary').textContent = insight.summary || '';
    const list = el('proactive-coach-actions');
    if (list) { list.replaceChildren(...(insight.recommendations || []).slice(0, 3).map((value) => { const item = document.createElement('li'); item.textContent = value; return item; })); }
}

document.addEventListener('click',async(event)=>{const button=event.target.closest?.('[data-coach-rating]');if(!button)return;const host=el('proactive-coach-card'),insightId=host?.dataset.insightId;if(!insightId)return;const rating=Number(button.dataset.coachRating);let correction='';if(rating<0)correction=window.prompt('Що саме неточно? Виправлення потрапить у ручну перевірку.')?.trim()||'';if(rating<0&&!correction)return;const{data:{user}}=await supabase.auth.getUser();if(!user)return;const{error}=await supabase.from('ai_feedback').upsert({user_id:user.id,insight_id:insightId,rating,correction,context:{trade_date:el('proactive-coach-date')?.textContent||''},training_status:'pending'},{onConflict:'user_id,insight_id'});if(!error)host.querySelectorAll('[data-coach-rating]').forEach(node=>node.classList.toggle('active',node===button));});
