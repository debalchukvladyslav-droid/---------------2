// === js/learn.js ===
import { state } from './state.js';
import { callGemini, getGeminiKeys } from './ai.js';

function getYoutubeApiKeyOptional() {
    const raw = state.systemConfig?.youtube_api_key || state.appData?.settings?.youtube_api_key || '';
    const key = String(raw).trim();
    return key || null;
}

function escapeLearnHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Без YouTube Data API: лише посилання на пошук за запитами від AI. */
function buildLearnHtmlFromQueriesOnly(queries) {
    const qList = queries.slice(0, 3).filter(Boolean);
    if (!qList.length) {
        return '<div style="color:var(--text-muted); text-align:center; padding:40px; grid-column:1/-1;">Немає пошукових запитів</div>';
    }
    const hint =
        '<p style="color:var(--text-muted); font-size:0.82rem; margin:0 0 16px; grid-column:1/-1; line-height:1.45;">' +
        'Ключ YouTube Data API не задано — показуємо лише персональні пошукові запити. ' +
        'Для карток з превʼю відео додайте ключ у <strong>Налаштування → API ключі</strong>.</p>';
    const cards = qList.map((query, idx) => {
        const safeQ = escapeLearnHtml(query);
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        return `
            <div class="learn-card learn-card--search-only">
                <div class="learn-card-body">
                    <div class="learn-card-title">${safeQ}</div>
                    <div class="learn-card-meta">Запит ${idx + 1} · підібрано AI</div>
                    <a href="${searchUrl}" target="_blank" rel="noopener noreferrer" class="btn-secondary" style="display:inline-block;margin-top:10px;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:0.85rem;">Відкрити пошук на YouTube</a>
                </div>
            </div>`;
    }).join('');
    return hint + cards;
}

function getTodayStr() {
    return new Date().toISOString().split('T')[0];
}

export function renderLearnCache() {
    const cache = state.appData.learnCache;
    const resultsEl = document.getElementById('learn-results');
    const queryLabel = document.getElementById('learn-query-label');
    if (!resultsEl) return;
    if (cache && cache.date === getTodayStr() && cache.html) {
        if (queryLabel) queryLabel.textContent = cache.queryLabel || '';
        resultsEl.innerHTML = cache.html;
        // Відновлюємо збережені summaries
        const summaries = cache.summaries || {};
        Object.entries(summaries).forEach(([vid, text]) => {
            const box = document.getElementById(`summary-${vid}`);
            if (box) { box.style.display = 'block'; box.innerHTML = text; }
        });
    } else if (!cache) {
        resultsEl.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:40px; grid-column:1/-1;">Натисніть «Оновити рекомендації» щоб отримати відео</div>';
        if (queryLabel) queryLabel.textContent = '';
    }
}

export async function loadLearnContent() {
    const btn = document.getElementById('learn-refresh-btn');
    const resultsEl = document.getElementById('learn-results');
    const queryLabel = document.getElementById('learn-query-label');
    if (!resultsEl) return;

    btn.disabled = true;
    btn.textContent = '⏳ AI аналізує...';
    resultsEl.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:40px; grid-column:1/-1;">⏳ AI підбирає теми для вас...</div>';

    try {
        // Збираємо контекст юзера
        const errors = state.appData.errorTypes || [];
        const tags = state.appData.screenTags ? [...new Set(Object.values(state.appData.screenTags).flat())] : [];
        const playbook = state.appData.playbook || [];

        // Останні 7 днів для персоналізації
        const recentDays = Object.entries(state.appData.journal || {})
            .filter(([d, v]) => d.match(/^\d{4}-\d{2}-\d{2}$/) && v.pnl !== null && v.pnl !== undefined)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .slice(0, 7)
            .map(([d, v]) => `${d}: PnL=${v.pnl}$, помилки=${(v.errors||[]).join(',') || 'немає'}`);

        const seed = Math.floor(Math.random() * 1000);

        // AI генерує пошуковий запит
        const contextPrompt = `Трейдер (seed=${seed} для унікальності):
- Типові помилки: ${errors.slice(0,5).join(', ') || 'не вказано'}
- Теги сетапів: ${tags.slice(0,8).join(', ') || 'не вказано'}
- Плейбук: ${playbook.map(p => p.name).slice(0,5).join(', ') || 'не вказано'}
- Останні дні: ${recentDays.join(' | ') || 'немає даних'}

Згенеруй 3 різних YouTube пошукових запити англійською:
1. Конкретно під слабке місце цього трейдера (на основі помилок/даних)
2. Про психологію або дисципліну в трейдингу (але не банальне)
3. НЕСПОДІВАНИЙ запит — щось з суміжних областей (спорт, нейронауки, прийняття рішень, поведінкова економіка) що може реально допомогти трейдеру але він би сам не шукав

Відповідь тільки JSON масив: ["query1", "query2", "query3"]`;

        const geminiKey = getGeminiKeys()[0];
        if (!geminiKey) throw new Error('AI недоступний (проксі). Перевірте GEMINI_API_KEY на сервері.');

        const aiResponse = await callGemini(geminiKey, {
            contents: [{ parts: [{ text: contextPrompt }] }]
        });

        let queries = [];
        try {
            const match = aiResponse.match(/\[.*\]/s);
            queries = match ? JSON.parse(match[0]) : ['prop trading psychology', 'day trading mistakes', 'trading discipline'];
        } catch {
            queries = ['prop trading psychology', 'day trading mistakes', 'trading discipline'];
        }

        const youtubeKey = getYoutubeApiKeyOptional();
        let html;

        if (!youtubeKey) {
            html = buildLearnHtmlFromQueriesOnly(queries);
        } else {
            const allVideos = [];
            for (const query of queries.slice(0, 3)) {
                const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=3&relevanceLanguage=en&key=${youtubeKey}`;
                const res = await fetch(url);
                const data = await res.json();
                if (data.error?.message) {
                    throw new Error(`YouTube API: ${data.error.message}`);
                }
                if (data.items) allVideos.push(...data.items);
            }

            if (allVideos.length === 0) {
                resultsEl.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:40px; grid-column:1/-1;">Нічого не знайдено</div>';
                return;
            }

            html = allVideos.map(item => {
            const vid = item.id.videoId;
            const title = item.snippet.title;
            const channel = item.snippet.channelTitle;
            const thumb = item.snippet.thumbnails.medium.url;
            const date = new Date(item.snippet.publishedAt).toLocaleDateString('uk-UA');
            const desc = item.snippet.description || '';
            const safeTitle = title.replace(/'/g, "\\'");
            const safeDesc = desc.replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 500);
            return `
            <div class="learn-card">
                <a href="https://www.youtube.com/watch?v=${vid}" target="_blank">
                    <img src="${thumb}" alt="${title}" style="width:100%; border-radius:8px; display:block;">
                </a>
                <div class="learn-card-body">
                    <div class="learn-card-title">${title}</div>
                    <div class="learn-card-meta">${channel} · ${date}</div>
                    <button onclick="summarizeVideo('${vid}', '${safeTitle}', '${safeDesc}')" style="margin-top:8px; background:rgba(139,92,246,0.15); border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:5px 12px; cursor:pointer; font-size:0.8rem;">📝 Коротко про відео</button>
                    <div id="summary-${vid}" style="display:none; margin-top:8px; font-size:0.82rem; color:var(--text-main); background:rgba(139,92,246,0.08); border:1px solid var(--accent); border-radius:6px; padding:10px; line-height:1.5;"></div>
                </div>
            </div>`;
            }).join('');
        }

        const labelText = `🔍 Пошук по: ${queries.join(' | ')}`;
        if (queryLabel) queryLabel.textContent = labelText;
        resultsEl.innerHTML = html;

        state.appData.learnCache = { date: getTodayStr(), html, queryLabel: labelText };
        import('./storage.js').then(m => m.saveToLocal());

    } catch (e) {
        resultsEl.innerHTML = `<div style="color:var(--loss); text-align:center; padding:40px; grid-column:1/-1;">⚠️ Помилка: ${e.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Оновити рекомендації';
    }
}

window.summarizeVideo = async function(vid, title, desc) {
    const box = document.getElementById(`summary-${vid}`);
    const btn = box.previousElementSibling;
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.textContent = '⏳ AI читає...';
    btn.disabled = true;
    try {
        const geminiKey = getGeminiKeys()[0];
        if (!geminiKey) throw new Error('AI недоступний (проксі). Перевірте GEMINI_API_KEY на сервері.');
        const text = await callGemini(geminiKey, {
            systemInstruction: { parts: [{ text: 'Ти помічник трейдера. Пиши коротко українською (3-4 речення): про що це відео, що головне розбирається і чи корисно це для трейдера.' }] },
            contents: [{ parts: [{ text: `Назва: "${title}"\nОпис: "${desc}"` }] }]
        });
        const html = text.replace(/\n/g, '<br>');
        box.innerHTML = html;
        if (!state.appData.learnCache) state.appData.learnCache = {};
        if (!state.appData.learnCache.summaries) state.appData.learnCache.summaries = {};
        state.appData.learnCache.summaries[vid] = html;
        import('./storage.js').then(m => m.saveToLocal());
    } catch(e) {
        box.textContent = '⚠️ Помилка: ' + e.message;
    } finally {
        btn.disabled = false;
    }
};
