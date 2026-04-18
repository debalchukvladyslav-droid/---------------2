import { state } from './state.js';
import { supabase } from './supabase.js';
import { hideGlobalLoader, showGlobalLoader } from './loading.js';

const CLIENT_CACHE_TTL_MS = 2 * 60 * 1000;
let _newsCache = { key: '', ts: 0, payload: null };
let _newsPromise = null;

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
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

function renderNewsItems(payload) {
    const list = document.getElementById('dash-news-list');
    const meta = document.getElementById('dash-news-meta');
    if (!list) return;

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const tickers = Array.isArray(payload?.tickers) ? payload.tickers : [];
    if (meta) {
        meta.textContent = tickers.length
            ? `Тикери: ${tickers.join(', ')}`
            : 'Загальні market headlines';
    }

    if (!items.length) {
        list.innerHTML = '<div class="dash-news-empty">Новин поки немає. Після імпорту угод тут зʼявляться заголовки по ваших тикерах.</div>';
        return;
    }

    list.innerHTML = items.slice(0, 12).map((item) => {
        const related = Array.isArray(item.related) ? item.related.slice(0, 4) : [];
        const relatedHtml = related.length
            ? `<div class="dash-news-tags">${related.map((ticker) => `<span>${sanitizeHTML(ticker)}</span>`).join('')}</div>`
            : '';
        const summary = item.summary
            ? `<p class="dash-news-summary">${sanitizeHTML(item.summary).slice(0, 220)}</p>`
            : '';
        return `<a class="dash-news-item" href="${sanitizeHTML(item.url)}" target="_blank" rel="noopener noreferrer">
            <div class="dash-news-top">
                <span class="dash-news-source">${sanitizeHTML(item.source || 'Finnhub')}</span>
                <span class="dash-news-time">${sanitizeHTML(formatNewsTime(item.datetime))}</span>
            </div>
            <h4>${sanitizeHTML(item.title)}</h4>
            ${summary}
            ${relatedHtml}
        </a>`;
    }).join('');
}

export async function renderDashboardNews(options = {}) {
    const list = document.getElementById('dash-news-list');
    if (!list) return;
    const force = !!options.force;

    if (!_newsPromise || force) {
        list.innerHTML = '<div class="dash-news-empty">Завантаження новин...</div>';
        showGlobalLoader('dash-news', 'Завантаження новин...');
        _newsPromise = fetchDashboardNews(force)
            .finally(() => hideGlobalLoader('dash-news'));
    }

    try {
        const payload = await _newsPromise;
        renderNewsItems(payload);
    } catch (error) {
        const msg = String(error?.message || error);
        list.innerHTML = `<div class="dash-news-empty">Новини не завантажились: ${sanitizeHTML(msg)}</div>`;
    }
}

export function refreshDashboardNews() {
    _newsPromise = null;
    _newsCache = { key: '', ts: 0, payload: null };
    return renderDashboardNews({ force: true });
}
