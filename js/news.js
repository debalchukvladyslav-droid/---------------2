import { state } from './state.js';
import { supabase } from './supabase.js';

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
    if (ticker) ticker.innerHTML = html;
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

    _newsCache = { key: cacheKey, ts: Date.now(), payload: data };
    return data;
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

    const prefix = tickers.length
        ? `<strong>${sanitizeHTML(tickers.join(', '))}</strong><span class="news-ticker-sep">•</span>`
        : '';

    const html = items.slice(0, 10).map((item) => {
        const related = Array.isArray(item.related) && item.related.length
            ? `[${sanitizeHTML(item.related.slice(0, 3).join(','))}] `
            : '';
        const time = formatNewsTime(item.datetime);
        const title = sanitizeHTML(item.title);
        const suffix = time ? ` (${sanitizeHTML(time)})` : '';
        return `<a href="${sanitizeHTML(item.url)}" target="_blank" rel="noopener noreferrer">${related}${title}${suffix}</a>`;
    }).join('<span class="news-ticker-sep">•</span>');

    setTickerHTML(prefix + html);
}

export async function renderDashboardNews(options = {}) {
    const ticker = document.getElementById('news-ticker-text');
    if (!ticker) return;
    const force = !!options.force;

    if (!_newsPromise || force) {
        setTickerHTML('Завантаження live news...');
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
