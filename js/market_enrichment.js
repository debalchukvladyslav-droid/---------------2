import { supabase } from './supabase.js';

let timer = null; let controller = null;
const $ = (id) => document.getElementById(id);

export function debounceMarketLookup(callback, delay = 450) { clearTimeout(timer); timer = setTimeout(callback, delay); }
function sourceState(text, state = '') { const node = $('swarm-market-source'); if (!node) return; node.textContent = text; node.className = `swarm-market-source${state ? ` is-${state}` : ''}`; }
function fillIfUntouched(id, value) { const input = $(id); if (!input || value == null || input.dataset.userEdited === 'true') return; input.value = value; input.dataset.marketFilled = 'true'; }

async function lookup(ticker) {
    controller?.abort(); controller = new AbortController(); sourceState(`Отримую ринкові дані для ${ticker}…`, 'loading');
    try {
        const { data } = await supabase.auth.getSession(); const token = data?.session?.access_token;
        if (!token) throw new Error('Потрібна активна сесія STRUM.');
        const response = await fetch('/api/gemini', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'market-enrich', ticker }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(payload.message || `Market HTTP ${response.status}`); error.code = payload.code; throw error; }
        if ($('swarm-ticker')?.value.trim().toUpperCase() !== payload.ticker) return;
        fillIfUntouched('swarm-gap', payload.gapPct); fillIfUntouched('swarm-rvol', payload.rvol); fillIfUntouched('swarm-float', payload.floatShares); fillIfUntouched('swarm-atr', payload.atr);
        const filled = [payload.gapPct, payload.rvol, payload.floatShares, payload.atr].filter((value) => value != null).length;
        sourceState(`${filled}/4 полів · ${payload.provider || 'Market API'}${payload.cached ? ' · кеш 60 с' : ''}${filled < 4 ? ' · решта вручну' : ''}`, filled < 4 ? 'partial' : '');
    } catch (error) {
        if (error.name === 'AbortError') return;
        const message = error.code === 'TICKER_NOT_FOUND' ? 'Ticker не знайдено.' : error.code === 'MARKET_RATE_LIMITED' ? 'Ліміт API. Спробуйте через 60 секунд.' : error.message;
        sourceState(message, 'error');
    }
}

export function initMarketEnrichment() {
    const ticker = $('swarm-ticker'); if (!ticker || ticker.dataset.marketBound) return; ticker.dataset.marketBound = 'true';
    ['swarm-gap', 'swarm-rvol', 'swarm-float', 'swarm-atr'].forEach((id) => $(id)?.addEventListener('input', (event) => { if (event.isTrusted) event.currentTarget.dataset.userEdited = 'true'; }));
    ticker.addEventListener('input', () => {
        const value = ticker.value.trim().toUpperCase(); ticker.value = value; clearTimeout(timer); controller?.abort();
        if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(value)) { sourceState(value ? 'Перевірте ticker.' : 'Введіть ticker — дані підтягнуться у фоні.', value ? 'error' : ''); return; }
        debounceMarketLookup(() => lookup(value));
    });
}
