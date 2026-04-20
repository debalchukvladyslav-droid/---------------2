// === js/learn.js ===
import { state } from './state.js';
import { supabase, SUPABASE_URL } from './supabase.js';
import { callGemini, getGeminiKeys } from './ai.js';
import { appendTextWithLineBreaks, normalizeHttpUrl } from './utils.js';

const MAX_QUERIES = 3;

function youtubeSearchEdgeUrl() {
    return `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/youtube-search`;
}

async function youtubeSearchViaEdge(query) {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return { __noAuth: true };

    const res = await fetch(youtubeSearchEdgeUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `YouTube proxy: ${res.status}`);
    return data;
}

function getTodayStr() {
    return new Date().toISOString().split('T')[0];
}

function clearNode(node) {
    if (node) node.textContent = '';
}

function appendEmptyMessage(parent, text, extraStyle = '') {
    clearNode(parent);
    const div = document.createElement('div');
    div.style.cssText = `color:var(--text-muted);text-align:center;padding:40px;grid-column:1/-1;${extraStyle}`;
    div.textContent = text;
    parent.appendChild(div);
}

function normalizeVideoItem(item) {
    const videoId = String(item?.id?.videoId || '').trim();
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) return null;

    const snippet = item?.snippet || {};
    const thumb = normalizeHttpUrl(snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url);
    return {
        videoId,
        title: String(snippet.title || 'Без назви'),
        channel: String(snippet.channelTitle || 'YouTube'),
        description: String(snippet.description || ''),
        publishedAt: snippet.publishedAt || '',
        thumbnail: thumb,
    };
}

function renderQueriesOnly(resultsEl, queries, reason = 'default') {
    clearNode(resultsEl);
    const hints = {
        noAuth: 'Увійдіть у акаунт, щоб завантажувати прев’ю відео через захищений сервер.',
        noServerKey: 'На сервері не задано YOUTUBE_API_KEY. Показуємо пошукові посилання без прев’ю.',
        default: 'Показуємо персональні пошукові запити без прев’ю відео.',
    };

    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--text-muted);font-size:0.82rem;margin:0 0 16px;grid-column:1/-1;line-height:1.45;';
    hint.textContent = hints[reason] || hints.default;
    resultsEl.appendChild(hint);

    queries.slice(0, MAX_QUERIES).filter(Boolean).forEach((query, idx) => {
        const card = document.createElement('div');
        card.className = 'learn-card learn-card--search-only';

        const body = document.createElement('div');
        body.className = 'learn-card-body';

        const title = document.createElement('div');
        title.className = 'learn-card-title';
        title.textContent = query;

        const meta = document.createElement('div');
        meta.className = 'learn-card-meta';
        meta.textContent = `Запит ${idx + 1} · підібрано AI`;

        const link = document.createElement('a');
        link.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'btn-secondary';
        link.style.cssText = 'display:inline-block;margin-top:10px;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:0.85rem;';
        link.textContent = 'Відкрити пошук на YouTube';

        body.appendChild(title);
        body.appendChild(meta);
        body.appendChild(link);
        card.appendChild(body);
        resultsEl.appendChild(card);
    });
}

function renderVideoCards(resultsEl, videos, summaries = {}) {
    clearNode(resultsEl);
    videos.forEach((video) => {
        const card = document.createElement('div');
        card.className = 'learn-card';

        const link = document.createElement('a');
        link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        if (video.thumbnail) {
            const img = document.createElement('img');
            img.src = video.thumbnail;
            img.alt = video.title;
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            img.style.cssText = 'width:100%;border-radius:8px;display:block;';
            link.appendChild(img);
        } else {
            const fallback = document.createElement('div');
            fallback.style.cssText = 'padding:28px 14px;border-radius:8px;background:var(--bg-main);color:var(--text-muted);text-align:center;';
            fallback.textContent = 'YouTube';
            link.appendChild(fallback);
        }

        const body = document.createElement('div');
        body.className = 'learn-card-body';

        const title = document.createElement('div');
        title.className = 'learn-card-title';
        title.textContent = video.title;

        const meta = document.createElement('div');
        meta.className = 'learn-card-meta';
        const date = video.publishedAt ? new Date(video.publishedAt).toLocaleDateString('uk-UA') : '';
        meta.textContent = [video.channel, date].filter(Boolean).join(' · ');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = 'margin-top:8px;background:rgba(139,92,246,0.15);border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:0.8rem;';
        btn.textContent = 'Коротко про відео';

        const summary = document.createElement('div');
        summary.id = `summary-${video.videoId}`;
        summary.style.cssText = 'display:none;margin-top:8px;font-size:0.82rem;color:var(--text-main);background:rgba(139,92,246,0.08);border:1px solid var(--accent);border-radius:6px;padding:10px;line-height:1.5;';

        const savedSummary = summaries[video.videoId];
        if (savedSummary) {
            summary.style.display = 'block';
            appendTextWithLineBreaks(summary, savedSummary);
        }

        btn.addEventListener('click', () => window.summarizeVideo(video.videoId, video.title, video.description));

        body.appendChild(title);
        body.appendChild(meta);
        body.appendChild(btn);
        body.appendChild(summary);
        card.appendChild(link);
        card.appendChild(body);
        resultsEl.appendChild(card);
    });
}

export function renderLearnCache() {
    const cache = state.appData.learnCache;
    const resultsEl = document.getElementById('learn-results');
    const queryLabel = document.getElementById('learn-query-label');
    if (!resultsEl) return;

    if (!cache) {
        appendEmptyMessage(resultsEl, 'Натисніть «Оновити рекомендації», щоб отримати відео');
        if (queryLabel) queryLabel.textContent = '';
        return;
    }

    if (cache.date !== getTodayStr()) return;
    if (queryLabel) queryLabel.textContent = cache.queryLabel || '';

    if (Array.isArray(cache.videos) && cache.videos.length) {
        renderVideoCards(resultsEl, cache.videos, cache.summaries || {});
        return;
    }
    if (Array.isArray(cache.queries) && cache.queries.length) {
        renderQueriesOnly(resultsEl, cache.queries, cache.fallbackReason || 'default');
        return;
    }

    appendEmptyMessage(resultsEl, 'Оновіть рекомендації, щоб зібрати нову підбірку');
}

export async function loadLearnContent() {
    const btn = document.getElementById('learn-refresh-btn');
    const resultsEl = document.getElementById('learn-results');
    const queryLabel = document.getElementById('learn-query-label');
    if (!btn || !resultsEl) return;

    btn.disabled = true;
    btn.textContent = 'AI аналізує...';
    appendEmptyMessage(resultsEl, 'AI підбирає теми для вас...');

    try {
        const errors = state.appData.errorTypes || [];
        const tags = state.appData.screenTags ? [...new Set(Object.values(state.appData.screenTags).flat())] : [];
        const playbook = state.appData.playbook || [];
        const recentDays = Object.entries(state.appData.journal || {})
            .filter(([d, v]) => d.match(/^\d{4}-\d{2}-\d{2}$/) && v.pnl !== null && v.pnl !== undefined)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .slice(0, 7)
            .map(([d, v]) => `${d}: PnL=${v.pnl}$, помилки=${(v.errors || []).join(',') || 'немає'}`);

        const seed = Math.floor(Math.random() * 1000);
        const contextPrompt = `Trader learning profile, seed=${seed}.
Common mistakes: ${errors.slice(0, 5).join(', ') || 'none'}
Setup tags: ${tags.slice(0, 8).join(', ') || 'none'}
Playbook: ${playbook.map(p => p.name).slice(0, 5).join(', ') || 'none'}
Recent sessions: ${recentDays.join(' | ') || 'no data'}

Generate exactly 3 different English YouTube search queries:
1. One query for the trader's weakest point.
2. One query about trading psychology or discipline.
3. One surprising adjacent-field query useful for trader decision-making.

Return only a JSON array of strings.`;

        const geminiKey = getGeminiKeys()[0];
        if (!geminiKey) throw new Error('AI недоступний. Перевірте GEMINI_API_KEY на сервері.');

        const aiResponse = await callGemini(geminiKey, {
            contents: [{ parts: [{ text: contextPrompt }] }],
        });

        let queries = [];
        try {
            const match = aiResponse.match(/\[.*\]/s);
            const parsed = match ? JSON.parse(match[0]) : [];
            queries = Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, MAX_QUERIES) : [];
        } catch {
            queries = [];
        }
        if (!queries.length) queries = ['prop trading psychology', 'day trading mistakes', 'trading discipline'];

        const allVideos = [];
        let fallbackReason = null;

        for (const query of queries) {
            const data = await youtubeSearchViaEdge(query);
            if (data?.__noAuth) {
                fallbackReason = 'noAuth';
                break;
            }
            if (data?.message === 'YOUTUBE_API_KEY not set') {
                fallbackReason = 'noServerKey';
                break;
            }
            if (data?.error?.message) throw new Error(`YouTube API: ${data.error.message}`);
            if (Array.isArray(data?.items)) {
                allVideos.push(...data.items.map(normalizeVideoItem).filter(Boolean));
            }
        }

        const labelText = `Пошук по: ${queries.join(' | ')}`;
        if (queryLabel) queryLabel.textContent = labelText;

        if (fallbackReason) {
            renderQueriesOnly(resultsEl, queries, fallbackReason);
            state.appData.learnCache = { date: getTodayStr(), queries, fallbackReason, queryLabel: labelText };
        } else if (!allVideos.length) {
            appendEmptyMessage(resultsEl, 'Нічого не знайдено');
            state.appData.learnCache = { date: getTodayStr(), queries, queryLabel: labelText };
        } else {
            renderVideoCards(resultsEl, allVideos);
            state.appData.learnCache = { date: getTodayStr(), queries, videos: allVideos, queryLabel: labelText, summaries: {} };
        }

        import('./storage.js').then(m => m.saveToLocal());
    } catch (e) {
        clearNode(resultsEl);
        const div = document.createElement('div');
        div.style.cssText = 'color:var(--loss);text-align:center;padding:40px;grid-column:1/-1;';
        div.textContent = `Помилка: ${e.message}`;
        resultsEl.appendChild(div);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Оновити рекомендації';
    }
}

window.summarizeVideo = async function summarizeVideo(vid, title, desc) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(vid || ''))) return;
    const box = document.getElementById(`summary-${vid}`);
    const btn = box?.previousElementSibling;
    if (!box || !btn) return;
    if (box.style.display === 'block' && box.textContent.trim()) {
        box.style.display = 'none';
        return;
    }

    box.style.display = 'block';
    box.textContent = 'AI читає...';
    btn.disabled = true;
    try {
        const geminiKey = getGeminiKeys()[0];
        if (!geminiKey) throw new Error('AI недоступний. Перевірте GEMINI_API_KEY на сервері.');
        const text = await callGemini(geminiKey, {
            systemInstruction: {
                parts: [{
                    text: 'Ти помічник трейдера. Пиши коротко українською: про що відео, що головне і чи корисно це трейдеру.',
                }],
            },
            contents: [{ parts: [{ text: `Назва: "${String(title || '')}"\nОпис: "${String(desc || '').slice(0, 700)}"` }] }],
        });

        box.textContent = '';
        appendTextWithLineBreaks(box, text);
        if (!state.appData.learnCache) state.appData.learnCache = {};
        if (!state.appData.learnCache.summaries) state.appData.learnCache.summaries = {};
        state.appData.learnCache.summaries[vid] = text;
        import('./storage.js').then(m => m.saveToLocal());
    } catch (e) {
        box.textContent = `Помилка: ${e.message}`;
    } finally {
        btn.disabled = false;
    }
};
