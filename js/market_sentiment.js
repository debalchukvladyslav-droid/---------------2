import { supabase } from './supabase.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = 'pj:market-sentiment:fear-greed:v1';
const PROXY_FALLBACK = 'https://traderjournal-six.vercel.app/api/fear-greed';
const CNN_FEAR_GREED_PAGE = 'https://www.cnn.com/markets/fear-and-greed';

let memoryCache = { ts: 0, payload: null };
let pendingRequest = null;

async function getAccessToken() {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        return data?.session?.access_token || '';
    } catch (error) {
        console.warn('[MarketSentiment] auth token unavailable:', error);
        return '';
    }
}

function loadPersistentCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object') return null;
        if (Date.now() - Number(payload.cachedAt || 0) > CACHE_TTL_MS) return null;
        return payload.data || null;
    } catch {
        return null;
    }
}

function savePersistentCache(payload) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            cachedAt: Date.now(),
            data: payload,
        }));
    } catch (error) {
        console.warn('[MarketSentiment] local cache skipped:', error);
    }
}

async function fetchMarketSentiment(force = false) {
    if (!force && memoryCache.payload && Date.now() - memoryCache.ts < CACHE_TTL_MS) {
        return memoryCache.payload;
    }

    if (!force) {
        const cached = loadPersistentCache();
        if (cached) {
            memoryCache = { ts: Date.now(), payload: cached };
            return cached;
        }
    }

    const token = await getAccessToken();
    if (!token) throw new Error('Active session required');

    const headers = { Authorization: `Bearer ${token}` };
    let response = await fetch('/api/fear-greed', { headers });
    if (response.status === 404 && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
        response = await fetch(PROXY_FALLBACK, { headers });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `Fear & Greed API error ${response.status}`);

    memoryCache = { ts: Date.now(), payload: data };
    savePersistentCache(data);
    return data;
}

function getTone(score, rating) {
    const n = Number(score);
    if (String(rating || '').includes('extreme_fear') || n <= 25) return 'extreme-fear';
    if (String(rating || '') === 'fear' || n < 45) return 'fear';
    if (String(rating || '').includes('extreme_greed') || n >= 75) return 'extreme-greed';
    if (String(rating || '') === 'greed' || n > 55) return 'greed';
    return 'neutral';
}

function formatTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('uk-UA', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDelta(current, previous) {
    const now = Number(current);
    const prev = Number(previous);
    if (!Number.isFinite(now) || !Number.isFinite(prev)) return '';
    const delta = Math.round((now - prev) * 10) / 10;
    if (Math.abs(delta) < 0.1) return 'flat vs 1W';
    return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} vs 1W`;
}

function renderLoading() {
    const root = document.getElementById('market-sentiment-card');
    if (!root) return;
    root.className = 'stat-card-pro market-sentiment-card is-loading';
    setText('market-sentiment-score', '--');
    setText('market-sentiment-label', 'Loading');
    setText('market-sentiment-delta', 'CNN Fear & Greed');
    setText('market-sentiment-updated', '');
    setNeedle(50);
}

function renderError(message) {
    const root = document.getElementById('market-sentiment-card');
    if (!root) return;
    root.className = 'stat-card-pro market-sentiment-card is-muted';
    setText('market-sentiment-score', '--');
    setText('market-sentiment-label', 'Unavailable');
    setText('market-sentiment-delta', 'CNN Fear & Greed');
    setText('market-sentiment-updated', message || 'Try again later');
    setNeedle(50);
}

function renderSentiment(payload) {
    const root = document.getElementById('market-sentiment-card');
    if (!root) return;

    if (payload?.degraded || payload?.score == null) {
        renderError(payload?.reason || 'Data temporarily unavailable');
        return;
    }

    const score = Math.round(Number(payload.score));
    const tone = getTone(score, payload.rating);
    root.className = `stat-card-pro market-sentiment-card market-sentiment-card--${tone}`;

    setText('market-sentiment-score', String(score));
    setText('market-sentiment-label', translateRating(payload.rating));
    setText('market-sentiment-delta', formatDelta(score, payload.previous?.week) || 'CNN Fear & Greed');
    setText('market-sentiment-updated', formatTimestamp(payload.timestamp));
    setNeedle(score);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '';
}

function setNeedle(score) {
    const needle = document.getElementById('market-sentiment-needle');
    if (!needle) return;
    const value = Math.max(0, Math.min(100, Number(score) || 0));
    const degrees = -90 + (value * 1.8);
    needle.style.setProperty('--market-needle-angle', `${degrees}deg`);
}

function translateRating(rating) {
    return {
        extreme_fear: 'Сильний страх',
        fear: 'Страх',
        neutral: 'Нейтрально',
        greed: 'Жадібність',
        extreme_greed: 'Сильна жадібність',
    }[String(rating || '').trim().toLowerCase()] || 'Нейтрально';
}

export async function renderMarketSentiment(options = {}) {
    const root = document.getElementById('market-sentiment-card');
    if (!root) return;

    const force = !!options.force;
    if (!pendingRequest || force) {
        renderLoading();
        pendingRequest = fetchMarketSentiment(force);
    }

    try {
        renderSentiment(await pendingRequest);
    } catch (error) {
        renderError(error?.message || 'Data temporarily unavailable');
    }
}

export function refreshMarketSentiment() {
    pendingRequest = null;
    memoryCache = { ts: 0, payload: null };
    return renderMarketSentiment({ force: true });
}

export function openMarketSentimentSource() {
    window.open(CNN_FEAR_GREED_PAGE, '_blank', 'noopener,noreferrer');
}
