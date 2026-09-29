/**
 * Daily criteria for the last completed session before the trade date.
 * ATR14 is the average high-low of the 14 sessions before that day, not Wilder ATR.
 * AvgVol14 is their average volume. Vol is that day's full volume.
 */

export const CALCULATION_VERSION = 2;
export const PROVIDER = 'massive';
export const TIMEZONE = 'America/New_York';
export const DEFAULT_HIGH_LOW_SESSION = '09:30';
export const DEFAULT_VOLUME_SESSION = '04:00';

const FETCH_STATUS_LABELS = {
    ok: 'Отримано',
    partial: 'Частково',
    unavailable: 'Недоступно',
    delayed: 'Затримка котирувань',
    rate_limited: 'Ліміт запитів',
    forbidden: 'Немає доступу',
    missing_history: 'Немає історії',
    error: 'Помилка',
};

const COMPLETENESS_LABELS = {
    complete: 'Повні',
    incomplete: 'Неповні',
    unavailable: 'Немає даних',
};

export function snapshotIsFrozen(row) {
    if (!row) return false;
    const version = Number(row.calculationVersion || row.calculation_version) || 0;
    if (version < CALCULATION_VERSION) return false;
    const completeness = row.completeness;
    const status = row.fetchStatus || row.fetch_status;
    return completeness === 'complete' && status === 'ok';
}

export function decideSnapshotWrite(existing, { manual = false } = {}) {
    if (!existing) return 'insert';
    if (snapshotIsFrozen(existing)) return 'reuse';
    return manual ? 'replace' : 'reuse';
}

export function roundTo(value, digits) {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(digits));
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function pad(value) {
    return String(value).padStart(2, '0');
}

export function nyParts(epochMs) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
    };
}

function zoneOffsetMs(epochMs) {
    const parts = nyParts(epochMs);
    const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return zonedAsUtc - epochMs;
}

export function zonedDateTimeToUtcMs(dateStr, timeStr, timeZone = TIMEZONE) {
    if (timeZone !== TIMEZONE) throw new Error('Only America/New_York is supported');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr || '');
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    const [year, month, day] = dateStr.split('-').map(Number);
    const guess = Date.UTC(year, month - 1, day, hour, minute, second);
    let utc = guess - zoneOffsetMs(guess);
    const corrected = guess - zoneOffsetMs(utc);
    if (corrected !== utc) utc = corrected;
    return utc;
}

export function formatNy(epochMs) {
    if (!Number.isFinite(epochMs)) return '';
    const parts = nyParts(epochMs);
    return `${parts.date} ${parts.time.slice(0, 5)} ET`;
}

export function normalizeSessionClock(value, fallback) {
    const text = String(value || '').trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

export function hasExactEntryTime(value) {
    return /\d{1,2}:\d{2}/.test(String(value || ''));
}

export function parseEntryInstant({ entryAt, tradeDate, opened } = {}) {
    const explicit = String(entryAt || '').trim();
    if (explicit) {
        const parsed = Date.parse(explicit);
        if (Number.isFinite(parsed)) {
            const parts = nyParts(parsed);
            return { entryMs: parsed, tradeDate: parts.date, entryAt: new Date(parsed).toISOString() };
        }
    }
    const date = String(tradeDate || '').trim();
    const raw = String(opened || '').trim();
    if (!hasExactEntryTime(raw)) return null;
    const zoned = raw.match(/(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2})?)/);
    const clock = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) && zoned) {
        const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'));
        if (!Number.isFinite(parsed)) return null;
        const parts = nyParts(parsed);
        return { entryMs: parsed, tradeDate: parts.date, entryAt: new Date(parsed).toISOString() };
    }
    const resolvedDate = zoned?.[1] || date;
    if (!clock || !/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) return null;
    const time = `${pad(clock[1])}:${pad(clock[2])}:${pad(clock[3] || 0)}`;
    const entryMs = zonedDateTimeToUtcMs(resolvedDate, time);
    if (!Number.isFinite(entryMs)) return null;
    return { entryMs, tradeDate: nyParts(entryMs).date, entryAt: new Date(entryMs).toISOString() };
}

function shiftIsoDate(iso, days) {
    const [year, month, day] = String(iso || '').split('-').map(Number);
    if (!year || !month || !day) return '';
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return next.toISOString().slice(0, 10);
}

export function sessionDate(epochMs) {
    const parts = nyParts(epochMs);
    if (!parts?.date) return '';
    if (parts.hour >= 18) return shiftIsoDate(parts.date, 1);
    return parts.date;
}

function completedDailySessions(dailyBars) {
    const byDate = new Map();
    (dailyBars || []).forEach((bar) => {
        const time = Number(bar?.t ?? bar?.time);
        if (!Number.isFinite(time)) return;
        const date = sessionDate(time);
        const high = finite(bar?.h ?? bar?.high);
        const low = finite(bar?.l ?? bar?.low);
        const volume = finite(bar?.v ?? bar?.volume);
        const close = finite(bar?.c ?? bar?.close);
        if (!date || high == null || low == null || volume == null) return;
        byDate.set(date, { date, high, low, volume, close });
    });
    return [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
}

export function scoreDailyCriteria(dailyBars = [], date) {
    const ordered = completedDailySessions(dailyBars);
    let index = -1;
    for (let cursor = ordered.length - 1; cursor >= 0; cursor -= 1) {
        if (ordered[cursor].date < date) {
            index = cursor;
            break;
        }
    }
    const current = index >= 0 ? ordered[index] : null;
    const prior = current ? ordered.slice(Math.max(0, index - 14), index) : [];
    const blank = {
        date: current?.date || '',
        atr14: null,
        avgVol14: null,
        volume: current?.volume ?? null,
        high: current?.high ?? null,
        low: current?.low ?? null,
        close: current?.close ?? null,
        volPlay14: null,
        atrPlay14: null,
    };
    if (!current || prior.length !== 14) return blank;
    const atr14 = roundTo(prior.reduce((sum, session) => sum + (session.high - session.low), 0) / prior.length, 2);
    const avgVol14 = roundTo(prior.reduce((sum, session) => sum + session.volume, 0) / prior.length, 0);
    const range = current.high - current.low;
    return {
        date: current.date,
        atr14,
        avgVol14,
        volume: current.volume,
        high: current.high,
        low: current.low,
        close: current.close,
        volPlay14: avgVol14 > 0 ? roundTo(current.volume / avgVol14, 1) : null,
        atrPlay14: atr14 > 0 ? roundTo(range / atr14, 1) : null,
    };
}

export function calculateEntryCriteria({
    dailyBars = [],
    minuteBars = [],
    entryMs,
    tradeDate,
    highLowSessionStart = DEFAULT_HIGH_LOW_SESSION,
    volumeSessionStart = DEFAULT_VOLUME_SESSION,
    adjusted = true,
    fetchStatus = 'ok',
    statusDetail = '',
    responseIncomplete = false,
    quoteDelayed = false,
} = {}) {
    const highLowClock = normalizeSessionClock(highLowSessionStart, DEFAULT_HIGH_LOW_SESSION);
    const volumeClock = normalizeSessionClock(volumeSessionStart, DEFAULT_VOLUME_SESSION);
    const notes = [];
    const empty = (completeness, status, detail) => ({
        atr14: null,
        avgVol14: null,
        dayVolume: null,
        volPlay14: null,
        atrPlay14: null,
        high: null,
        low: null,
        lastCandleAt: null,
        highLowSessionStart: highLowClock,
        volumeSessionStart: volumeClock,
        provider: PROVIDER,
        adjusted: adjusted === true,
        completeness,
        fetchStatus: status,
        statusDetail: detail,
        calculationVersion: CALCULATION_VERSION,
        sourceMeta: {
            timezone: TIMEZONE,
            notes,
            priorDays: 0,
            minuteCount: 0,
        },
    });

    if (adjusted !== true) {
        return empty('unavailable', 'error', 'Massive повернув некориговані дані');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || '')) {
        return empty('unavailable', 'unavailable', 'Потрібні тікер і дата угоди');
    }
    if (fetchStatus === 'forbidden' || fetchStatus === 'rate_limited' || fetchStatus === 'missing_history') {
        return empty('unavailable', fetchStatus, statusDetail || FETCH_STATUS_LABELS[fetchStatus]);
    }

    const scored = scoreDailyCriteria(dailyBars, tradeDate);
    const atr14 = scored.atr14;
    const avgVol14 = scored.avgVol14;
    const dayVolume = scored.volume;
    let completeness = atr14 != null && avgVol14 != null && dayVolume != null ? 'complete' : 'incomplete';
    if (!scored.date) {
        completeness = 'unavailable';
        notes.push('Немає завершеної сесії перед датою угоди');
    } else if (atr14 == null || avgVol14 == null) {
        notes.push('Не вистачає 14 завершених сесій перед останнім днем');
    }
    if (responseIncomplete) {
        completeness = 'incomplete';
        notes.push('Відповідь Massive обірвана');
    }
    const delayed = quoteDelayed === true;
    let status = fetchStatus === 'ok' && completeness !== 'complete' ? 'partial' : fetchStatus;
    if (delayed && status === 'ok') status = 'delayed';
    if (delayed && completeness === 'complete') completeness = 'incomplete';
    if (completeness === 'unavailable' && status === 'ok') status = 'missing_history';

    return {
        atr14,
        avgVol14,
        dayVolume,
        volPlay14: scored.volPlay14,
        atrPlay14: scored.atrPlay14,
        high: scored.high,
        low: scored.low,
        lastCandleAt: null,
        highLowSessionStart: highLowClock,
        volumeSessionStart: volumeClock,
        provider: PROVIDER,
        adjusted: true,
        completeness,
        fetchStatus: status,
        statusDetail: statusDetail || notes[0] || '',
        calculationVersion: CALCULATION_VERSION,
        sourceMeta: {
            timezone: TIMEZONE,
            notes,
            sessionDate: scored.date,
            priorDays: scored.date ? 14 : 0,
            minuteCount: Array.isArray(minuteBars) ? minuteBars.length : 0,
            quoteDelayed: delayed,
            entryMs: Number.isFinite(entryMs) ? entryMs : null,
        },
    };
}

export function formatGrouped(value) {
    if (value == null || !Number.isFinite(Number(value))) return '';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value));
}

export function formatPrice(value) {
    if (value == null || !Number.isFinite(Number(value))) return '';
    const number = Number(value);
    return number >= 1 ? number.toFixed(2) : number.toFixed(4);
}

export function presentSnapshot(row = {}) {
    const atr14 = finite(row.atr14 ?? row.atr_14);
    const avgVol14 = finite(row.avgVol14 ?? row.avg_vol14);
    const dayVolume = finite(row.dayVolume ?? row.day_volume);
    const volPlay14 = finite(row.volPlay14 ?? row.vol_play14);
    const atrPlay14 = finite(row.atrPlay14 ?? row.atr_play14);
    const high = finite(row.high ?? row.session_high);
    const low = finite(row.low ?? row.session_low);
    const fetchStatus = row.fetchStatus || row.fetch_status || 'unavailable';
    const completeness = row.completeness || 'unavailable';
    const lastCandleAt = row.lastCandleAt || row.last_candle_at || null;
    const sourceMeta = row.sourceMeta || row.source_meta || {};
    return {
        tradeId: row.tradeId || row.trade_id || '',
        tradeDate: row.tradeDate || row.trade_date || '',
        ticker: row.ticker || '',
        entryAt: row.entryAt || row.entry_at || '',
        atr14,
        avgVol14,
        dayVolume,
        volPlay14,
        atrPlay14,
        high,
        low,
        lastCandleAt,
        highLowSessionStart: row.highLowSessionStart || row.high_low_session_start || DEFAULT_HIGH_LOW_SESSION,
        volumeSessionStart: row.volumeSessionStart || row.volume_session_start || DEFAULT_VOLUME_SESSION,
        provider: row.provider || PROVIDER,
        adjusted: row.adjusted === true || row.adjusted === 'true',
        completeness,
        fetchStatus,
        statusDetail: row.statusDetail || row.status_detail || '',
        calculationVersion: Number(row.calculationVersion || row.calculation_version) || CALCULATION_VERSION,
        calculatedAt: row.calculatedAt || row.calculated_at || '',
        sourceMeta,
        display: {
            atr14: atr14 == null ? '' : atr14.toFixed(2),
            avgVol14: formatGrouped(avgVol14),
            dayVolume: formatGrouped(dayVolume),
            volPlay14: volPlay14 == null ? '' : volPlay14.toFixed(1),
            atrPlay14: atrPlay14 == null ? '' : atrPlay14.toFixed(1),
            high: formatPrice(high),
            low: formatPrice(low),
            lastCandle: lastCandleAt ? formatNy(Date.parse(lastCandleAt)) : '',
            fetchStatus: FETCH_STATUS_LABELS[fetchStatus] || fetchStatus,
            completeness: COMPLETENESS_LABELS[completeness] || completeness,
        },
    };
}
