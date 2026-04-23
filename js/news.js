import { state } from './state.js';
import { supabase } from './supabase.js';
import { callGemini, getGeminiKeys } from './ai.js';
import { loadTradeDays } from './storage.js';

const CLIENT_CACHE_TTL_MS = 2 * 60 * 1000;
const NEWS_CACHE_VERSION = 'uk-v2';
const NEWS_PROXY_FALLBACK = 'https://traderjournal-six.vercel.app/api/news';
let _newsCache = { key: '', ts: 0, payload: null };
let _newsPromise = null;

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

function safeExternalUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '#';
    } catch {
        return '#';
    }
}

function setTickerHTML(html) {
    const ticker = document.getElementById('news-ticker-text');
    if (!ticker) return;
    const content = html || 'Новини завантажуються...';
    ticker.style.animation = 'none';
    ticker.innerHTML = `<span class="news-ticker-segment">${content}</span><span class="news-ticker-segment" aria-hidden="true">${content}</span>`;
    ticker.offsetHeight;
    ticker.style.animation = '';
}

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getPersistentCacheKey(context) {
    const userKey = state.myUserId || state.USER_DOC_NAME || 'anon';
    const tickerKey = context?.tickers?.length ? context.tickers.join(',') : 'market';
    const dayKey = context?.date || getTodayKey();
    const windowKey = context?.fromTs && context?.toTs ? `${context.fromTs}-${context.toTs}` : 'latest';
    return `pj:news:${NEWS_CACHE_VERSION}:${userKey}:${dayKey}:${tickerKey}:${windowKey}`;
}

function loadPersistentNewsCache(context) {
    try {
        const raw = localStorage.getItem(getPersistentCacheKey(context));
        if (!raw) return null;
        const payload = JSON.parse(raw);
        if (!payload || !Array.isArray(payload.items)) return null;
        if (payload.items.some((item) => item?.title && !item?.titleUk)) return null;
        return payload;
    } catch {
        return null;
    }
}

function savePersistentNewsCache(context, payload) {
    try {
        localStorage.setItem(getPersistentCacheKey(context), JSON.stringify(payload));
    } catch (error) {
        console.warn('[News] local cache skipped:', error);
    }
}

function getNYOffset(dateStr) {
    const nyStr = new Date(`${dateStr}T12:00:00`).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        timeZoneName: 'short',
    });
    return nyStr.includes('EDT') ? '-04:00' : '-05:00';
}

function parseTradeTs(timeStr, dateStr) {
    if (!timeStr || !dateStr) return 0;
    const full = String(timeStr).includes('-') ? String(timeStr) : `${dateStr} ${timeStr}`;
    const ts = Math.floor(new Date(full.replace(' ', 'T') + getNYOffset(dateStr)).getTime() / 1000);
    return Number.isFinite(ts) ? ts : 0;
}

function getSessionWindow(dateStr) {
    const offset = getNYOffset(dateStr);
    return {
        fromTs: Math.floor(new Date(`${dateStr}T04:00:00${offset}`).getTime() / 1000),
        toTs: Math.floor(new Date(`${dateStr}T20:00:00${offset}`).getTime() / 1000),
    };
}

function getLastTradeDayNewsContext(limit = 8) {
    const tickers = [];
    const seen = new Set();
    const rows = Object.entries(state.appData?.journal || {})
        .filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray(day?.trades) && day.trades.length > 0)
        .sort((a, b) => b[0].localeCompare(a[0]));

    const [latestDate, latestDay] = rows[0] || [];
    if (!latestDay || !latestDate) {
        return { date: getTodayKey(), tickers, fromTs: null, toTs: null };
    }

    const fromTrades = latestDay.trades.map((trade) => trade.symbol);
    const fromDay = Array.isArray(latestDay.traded_tickers) ? latestDay.traded_tickers : [];
    for (const raw of [...fromTrades, ...fromDay]) {
        const ticker = String(raw || '').trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) || seen.has(ticker)) continue;
        seen.add(ticker);
        tickers.push(ticker);
        if (tickers.length >= limit) break;
    }

    const timestamps = latestDay.trades
        .flatMap((trade) => [
            parseTradeTs(trade.opened, latestDate),
            parseTradeTs(trade.closed, latestDate),
        ])
        .filter((ts) => ts > 0);

    const session = getSessionWindow(latestDate);
    const fromTs = timestamps.length
        ? Math.max(session.fromTs, Math.min(...timestamps) - 120 * 60)
        : session.fromTs;
    const toTs = timestamps.length
        ? Math.min(session.toTs, Math.max(...timestamps) + 120 * 60)
        : session.toTs;

    return { date: latestDate, tickers, fromTs, toTs };
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
    await loadTradeDays();
    if (document.getElementById('view-dash')?.classList.contains('active') && window.renderView) {
        window.renderView();
    }

    const newsContext = getLastTradeDayNewsContext();
    const tickers = newsContext.tickers;
    const cacheKey = getPersistentCacheKey(newsContext);
    if (!force && _newsCache.payload && _newsCache.key === cacheKey && Date.now() - _newsCache.ts < CLIENT_CACHE_TTL_MS) {
        return _newsCache.payload;
    }

    if (!force) {
        const cached = loadPersistentNewsCache(newsContext);
        if (cached) {
            _newsCache = { key: cacheKey, ts: Date.now(), payload: cached };
            return cached;
        }
    }

    const token = await getAccessToken();
    if (!token) throw new Error('Потрібна активна сесія');

    const qs = new URLSearchParams();
    if (tickers.length) qs.set('tickers', tickers.join(','));
    if (newsContext.fromTs && newsContext.toTs) {
        qs.set('fromTs', String(newsContext.fromTs));
        qs.set('toTs', String(newsContext.toTs));
    }
    const requestPath = `/api/news?${qs.toString()}`;
    const headers = { Authorization: `Bearer ${token}` };
    const isLocalHost = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
    if (isLocalHost) {
        throw new Error('News API недоступний на localhost (CORS). Відкрийте застосунок на production-домені.');
    }

    let response = await fetch(requestPath, { headers });
    if (response.status === 404) {
        response = await fetch(`${NEWS_PROXY_FALLBACK}?${qs.toString()}`, { headers });
    }

    // Backend degraded mode: avoid repeated failing requests on server 5xx.
    if (!response.ok && response.status >= 500) {
        const degraded = {
            items: [],
            tickers,
            newsWindow: { matched: 0 },
            degraded: true,
        };
        _newsCache = { key: cacheKey, ts: Date.now(), payload: degraded };
        savePersistentNewsCache(newsContext, degraded);
        return degraded;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `News API error ${response.status}`);

    const translated = await translateNewsPayload(data);
    _newsCache = { key: cacheKey, ts: Date.now(), payload: translated };
    savePersistentNewsCache(newsContext, translated);
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
            section: item.section || 'general',
            tickers: Array.isArray(item.related) ? item.related.slice(0, 4) : [],
            datetime: item.datetime || null,
            title: String(item.title || '').slice(0, 240),
            summary: String(item.summary || '').slice(0, 420),
        }));
        const text = await callGemini(key, {
            systemInstruction: {
                parts: [{
                    text: [
                        'Ти редактор трейдингової live-стрічки.',
                        'Для кожної новини зроби короткий український рядок до 125 символів.',
                        'Для general: передай суть ринку без зайвих деталей.',
                        'Для tickers: це catalyst tape навколо пампу/угоди. Пиши причину руху, а не факт що акція росте.',
                        'Шукай конкретику: фаза дослідження, FDA, trial data, offering, earnings, guidance, downgrade, merger, contract, lawsuit.',
                        'Збережи тикери, час, назви компаній, цифри і фази. Не вигадуй фактів, яких немає у title/summary.',
                        'Відповідай тільки JSON масивом рядків у тому самому порядку.',
                    ].join(' '),
                }],
            },
            contents: [{ parts: [{ text: JSON.stringify(source) }] }],
        });

        const match = text.match(/\[[\s\S]*\]/);
        const translated = match ? JSON.parse(match[0]) : [];
        if (!Array.isArray(translated) || translated.length !== items.length) return withFallbackUkrainianTitles(payload);

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
        return withFallbackUkrainianTitles(payload);
    }
}

function withFallbackUkrainianTitles(payload) {
    return {
        ...payload,
        items: Array.isArray(payload?.items)
            ? payload.items.map((item) => ({
                ...item,
                titleUk: item.titleUk || buildUkrainianFallbackLine(item),
            }))
            : [],
    };
}

function buildUkrainianFallbackLine(item) {
    const section = item?.section || 'general';
    const related = Array.isArray(item?.related) ? item.related.filter(Boolean) : [];
    const ticker = related[0] || '';
    const source = item?.source ? ` (${item.source})` : '';
    const text = `${item?.title || ''} ${item?.summary || ''}`.toLowerCase();

    if (section === 'general') {
        if (/fed|fomc|rate|inflation|cpi|pce|jobs|payroll/.test(text)) return `Ринок: макро/ФРС у фокусі${source}`;
        if (/oil|crude|energy|gold|yield|treasury|dollar/.test(text)) return `Ринок: рух у сировині, дохідностях або доларі${source}`;
        if (/earnings|guidance|revenue|profit/.test(text)) return `Ринок: сезон звітів впливає на настрій${source}`;
        return `Ринок: свіжа новина без точного catalyst${source}`;
    }

    const prefix = ticker ? `${ticker}: ` : '';
    if (/phase\s*(1|2|3|i|ii|iii)|clinical trial|trial data|endpoint|patients|study|data readout/.test(text)) {
        return `${prefix}новина щодо клінічних даних або фази дослідження${source}`;
    }
    if (/fda|approval|clearance|pdufa|regulatory|drug|therapy/.test(text)) {
        return `${prefix}регуляторна/FDA новина по препарату або терапії${source}`;
    }
    if (/offering|public offering|registered direct|private placement|atm|warrant|dilution|convertible/.test(text)) {
        return `${prefix}новина про розміщення акцій або можливе розмивання${source}`;
    }
    if (/earnings|revenue|guidance|forecast|outlook|eps|sales|profit|loss|quarter|q[1-4]/.test(text)) {
        return `${prefix}звітність, прогноз або фінансові показники компанії${source}`;
    }
    if (/merger|acquisition|buyout|takeover|strategic alternatives|asset sale/.test(text)) {
        return `${prefix}угода M&A, продаж активів або стратегічні варіанти${source}`;
    }
    if (/upgrade|downgrade|price target|initiates|analyst|rating/.test(text)) {
        return `${prefix}аналітики оновили рейтинг або цільову ціну${source}`;
    }
    if (/contract|partnership|collaboration|agreement|license|supply|order/.test(text)) {
        return `${prefix}контракт, партнерство або ліцензійна угода${source}`;
    }
    if (/sec|investigation|lawsuit|class action|delisting|nasdaq notice|compliance/.test(text)) {
        return `${prefix}SEC, судовий ризик або питання лістингу${source}`;
    }
    if (/launch|product|patent|presentation|conference|webcast/.test(text)) {
        return `${prefix}продуктова, патентна або презентаційна новина${source}`;
    }
    return `${prefix}корпоративна новина, перевір деталі у джерелі${source}`;
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
        if (payload?.degraded) {
            const reason = String(payload.reason || '').includes('FINNHUB_API_KEY')
                ? 'додайте FINNHUB_API_KEY у Vercel Environment Variables і зробіть Redeploy'
                : (payload.reason || 'провайдер новин тимчасово недоступний');
            setTickerHTML(`Live news тимчасово недоступні: ${sanitizeHTML(reason)}`);
            return;
        }
        const scope = tickers.length ? `по ${sanitizeHTML(tickers.join(', '))}` : 'по ринку';
        setTickerHTML(`Немає свіжих новин ${scope}<span class="news-ticker-sep">•</span>Імпортуйте угоди, щоб стрічка брала ваші тикери`);
        return;
    }

    const generalItems = items.filter((item) => item.section === 'general').slice(0, 6);
    const tickerItems = items.filter((item) => item.section !== 'general').slice(0, 8);
    const orderedItems = [...generalItems, ...tickerItems];
    const windowMatched = Number(payload?.newsWindow?.matched) || 0;
    const tickerLabel = tickers.length
        ? `${windowMatched ? 'Памп-вікно' : 'Останні тікери'}: ${sanitizeHTML(tickers.join(', '))}`
        : 'Останні тікери';

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
        return `${label}<a href="${sanitizeHTML(safeExternalUrl(item.url))}" target="_blank" rel="noopener noreferrer">${related}${title}${suffix}</a>`;
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
