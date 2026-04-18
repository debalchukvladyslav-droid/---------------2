import { state } from './state.js';
import { supabase } from './supabase.js';
import { callGemini, getGeminiKeys } from './ai.js';

const CLIENT_CACHE_TTL_MS = 2 * 60 * 1000;
let _newsCache = { key: '', ts: 0, payload: null };
let _newsPromise = null;

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

function setTickerHTML(html) {
    const ticker = document.getElementById('news-ticker-text');
    if (!ticker) return;
    ticker.style.animation = 'none';
    ticker.innerHTML = html;
    ticker.offsetHeight;
    ticker.style.animation = '';
}

function getRecentTradeTickers(limit = 8) {
    const tickers = [];
    const seen = new Set();
    const rows = Object.entries(state.appData?.journal || {})
        .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort((a, b) => b[0].localeCompare(a[0]));

    for (const [, day] of rows) {
        const fromTrades = Array.isArray(day?.trades) ? day.trades.map((trade) => trade.symbol) : [];
        const fromDay = Array.isArray(day?.traded_tickers) ? day.traded_tickers : [];
        for (const raw of [...fromTrades, ...fromDay]) {
            const ticker = String(raw || '').trim().toUpperCase();
            if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) || seen.has(ticker)) continue;
            seen.add(ticker);
            tickers.push(ticker);
            if (tickers.length >= limit) return tickers;
        }
    }
    return tickers;
}

async function getAccessToken() {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        return data?.session?.access_token || '';
    } catch (error) {
        console.warn('[News] auth token unavailable:', error);
        return '';
    }
}

async function fetchDashboardNews(force = false) {
    const tickers = getRecentTradeTickers();
    const cacheKey = tickers.join(',') || 'market';
    if (!force && _newsCache.payload && _newsCache.key === cacheKey && Date.now() - _newsCache.ts < CLIENT_CACHE_TTL_MS) {
        return _newsCache.payload;
    }

    const token = await getAccessToken();
    if (!token) throw new Error('Потрібна активна сесія');

    const qs = new URLSearchParams();
    if (tickers.length) qs.set('tickers', tickers.join(','));
    const response = await fetch(`/api/news?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `News API error ${response.status}`);

    const translated = await translateNewsPayload(data);
    _newsCache = { key: cacheKey, ts: Date.now(), payload: translated };
    return translated;
}

async function translateNewsPayload(payload) {
    const items = Array.isArray(payload?.items) ? payload.items.slice(0, 24) : [];
    if (!items.length) return payload;

    try {
        const key = getGeminiKeys()[0];
        if (!key) return payload;

        const source = items.map((item, index) => ({
            index,
            title: String(item.title || '').slice(0, 240),
        }));
        const text = await callGemini(key, {
            systemInstruction: {
                parts: [{
                    text: 'Переклади фінансові новинні заголовки українською. Збережи тикери, назви компаній і цифри. Відповідай тільки JSON масивом рядків у тому самому порядку.',
                }],
            },
            contents: [{ parts: [{ text: JSON.stringify(source) }] }],
        });

        const match = text.match(/\[[\s\S]*\]/);
        const translated = match ? JSON.parse(match[0]) : [];
        if (!Array.isArray(translated) || translated.length !== items.length) return payload;

        return {
            ...payload,
            items: payload.items.map((item, index) => ({
                ...item,
                titleUk: typeof translated[index] === 'string' && translated[index].trim()
                    ? translated[index].trim()
                    : item.title,
            })),
        };
    } catch (error) {
        console.warn('[News] translate skipped:', error);
        return payload;
    }
}

function formatNewsTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('uk-UA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderTickerNews(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const tickers = Array.isArray(payload?.tickers) ? payload.tickers : [];

    if (!items.length) {
        const scope = tickers.length ? `по ${sanitizeHTML(tickers.join(', '))}` : 'по ринку';
        setTickerHTML(`Немає свіжих новин ${scope}<span class="news-ticker-sep">•</span>Імпортуйте угоди, щоб стрічка брала ваші тикери`);
        return;
    }

    const generalItems = items.filter((item) => item.section === 'general').slice(0, 6);
    const tickerItems = items.filter((item) => item.section !== 'general').slice(0, 8);
    const orderedItems = [...generalItems, ...tickerItems];
    const tickerLabel = tickers.length ? `Після угод: ${sanitizeHTML(tickers.join(', '))}` : 'Після угод';

    const html = orderedItems.map((item, index) => {
        const beforeTickerLabel = index === generalItems.length && tickerItems.length;
        const label = index === 0
            ? '<strong>Загальні</strong><span class="news-ticker-sep">•</span>'
            : beforeTickerLabel
                ? `<strong>${tickerLabel}</strong><span class="news-ticker-sep">•</span>`
                : '';
        const related = Array.isArray(item.related) && item.related.length
            ? `[${sanitizeHTML(item.related.slice(0, 3).join(','))}] `
            : '';
        const time = formatNewsTime(item.datetime);
        const title = sanitizeHTML(item.titleUk || item.title);
        const suffix = time ? ` (${sanitizeHTML(time)})` : '';
        return `${label}<a href="${sanitizeHTML(item.url)}" target="_blank" rel="noopener noreferrer">${related}${title}${suffix}</a>`;
    }).join('<span class="news-ticker-sep">•</span>');

    setTickerHTML(html);
}

export async function renderDashboardNews(options = {}) {
    const ticker = document.getElementById('news-ticker-text');
    if (!ticker) return;
    const force = !!options.force;

    if (!_newsPromise || force) {
        setTickerHTML('Завантаження live news українською...');
        _newsPromise = fetchDashboardNews(force);
    }

    try {
        const payload = await _newsPromise;
        renderTickerNews(payload);
    } catch (error) {
        const msg = String(error?.message || error);
        const hint = msg.includes('FINNHUB_API_KEY')
            ? 'Додайте FINNHUB_API_KEY у Vercel Environment Variables і зробіть Redeploy'
            : msg;
        setTickerHTML(`Live news не підключені: ${sanitizeHTML(hint)}`);
    }
}

export function refreshDashboardNews() {
    _newsPromise = null;
    _newsCache = { key: '', ts: 0, payload: null };
    return renderDashboardNews({ force: true });
}
