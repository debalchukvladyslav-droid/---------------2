import { getOrLoadPolygonDay } from './polygon_intraday_cache.js';
import { SUPABASE_URL } from './supabase.js';

function nyOffset(date) {
    const label = new Date(`${date}T12:00:00Z`).toLocaleString('en-US', {
        timeZone: 'America/New_York', timeZoneName: 'short', hour: '2-digit',
    });
    return label.includes('EDT') ? '-04:00' : '-05:00';
}

export async function loadJournalPolygonDay(symbol, date, accessToken, { from = '04:00:00', to = '20:00:00', signal = null } = {}) {
    const offset = nyOffset(date);
    const fromMs = new Date(`${date}T${from}${offset}`).getTime();
    const toMs = new Date(`${date}T${to}${offset}`).getTime();
    return getOrLoadPolygonDay(symbol, date, async () => {
        const response = await fetch(`${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/polygon-aggs`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, fromMs, toMs }),
            ...(signal ? { signal } : {}),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || `Polygon журналу: HTTP ${response.status}`);
        return Array.isArray(payload?.results) ? payload.results : [];
    });
}
