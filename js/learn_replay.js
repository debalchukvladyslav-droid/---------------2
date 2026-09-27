import { state } from './state.js';
import { supabase, SUPABASE_URL } from './supabase.js';
import { getOrLoadPolygonDay } from './polygon_intraday_cache.js';
import { ensureLightweightCharts } from './vendor_loader.js';
import { loadTeams } from './teams.js';
import {
    advanceReplay,
    beginEntry,
    cancelSetup,
    collectReplaySessions,
    createReplay,
    cursorAtSessionOpen,
    enterAtMarket,
    formatReplayPrice,
    formatReplayR,
    jumpToSessionOpen,
    pickReplaySession,
    setEntryPrice,
    setReplaySpeed,
    setReplayStatus,
    setStopPrice,
    summarizeAttempts,
    visibleBars,
} from './learn_replay_core.js';

const TICK_MS = 200;

let replay = null;
let sessionMeta = null;
let lastKey = '';
let loadToken = 0;
let timer = 0;
let chart = null;
let series = null;
let priceLines = [];
let resizeObserver = null;

function localOwner() {
    const nick = String(state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '').replace(/_stats$/, '').trim();
    return nick || 'журнал';
}

function sessionKey(session) {
    return `${session?.owner || ''}|${session?.date || ''}|${session?.symbol || ''}`;
}

function nyOffset(dateStr) {
    const label = new Date(`${dateStr}T12:00:00`).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        timeZoneName: 'short',
    });
    return label.includes('EDT') ? '-04:00' : '-05:00';
}

function formatNy(unix) {
    if (!unix) return '—';
    return new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(unix * 1000));
}

function setStatus(text) {
    const status = document.getElementById('learn-replay-status');
    if (status) status.textContent = text;
}

function clearTimer() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
}

function statusText() {
    if (!replay || !sessionMeta) return 'Натисніть «Нова сесія»';
    if (replay.status === 'done') return 'Сесію закінчено. Нижче ваші входи і входи з журналу.';
    if (replay.phase === 'stop') return 'Клікніть ціну стопа на графіку. Тейк стане на 1:3.7.';
    if (replay.active) {
        const side = replay.active.side === 'long' ? 'лонг' : 'шорт';
        return `У позиції · ${side} · тейк ${formatReplayPrice(replay.active.take)}`;
    }
    if (replay.status === 'playing') return 'Стрічка йде. Клік по графіку ставить вхід на поточній свічці.';
    return 'Пауза. Клік по графіку обирає ціну входу на поточній свічці.';
}

async function loadCandles(symbol, dateStr) {
    const offset = nyOffset(dateStr);
    const fromMs = new Date(`${dateStr}T04:00:00${offset}`).getTime();
    const toMs = new Date(`${dateStr}T20:00:00${offset}`).getTime();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Увійдіть у акаунт, щоб завантажити хвилинні свічки.');
    const edgeUrl = `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/polygon-aggs`;
    const loaded = await getOrLoadPolygonDay(symbol, dateStr, async () => {
        const response = await fetch(edgeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ symbol, fromMs, toMs }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || `Polygon: ${response.status}`);
        return Array.isArray(payload?.results) ? payload.results : [];
    });
    return loaded.bars.map((bar) => ({
        time: Math.floor(Number(bar.t) / 1000),
        open: Number(bar.o),
        high: Number(bar.h),
        low: Number(bar.l),
        close: Number(bar.c),
    }));
}

async function loadRandomForeignSession() {
    if (!Object.keys(state._teamProfiles || {}).length) {
        try { await loadTeams(); } catch { return null; }
    }
    const profiles = Object.values(state._teamProfiles || {}).filter((profile) => profile?.id && profile.id !== state.myUserId);
    const order = profiles.sort(() => Math.random() - 0.5).slice(0, 4);
    for (const profile of order) {
        const { data, error } = await supabase.rpc('get_stats_comparison_journal', { target_user_id: profile.id });
        if (error || !Array.isArray(data)) continue;
        const journal = {};
        data.forEach((row) => {
            const date = String(row.trade_date || '').slice(0, 10);
            const trades = row.daily_metrics?.trades;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(trades)) return;
            journal[date] = { trades };
        });
        const session = pickReplaySession(collectReplaySessions(journal, profile.nick || 'кущ'));
        if (session && sessionKey(session) !== lastKey) return session;
    }
    return null;
}

async function chooseSession() {
    const owner = localOwner();
    const local = collectReplaySessions(state.appData?.journal || {}, owner);
    const freshLocal = local.filter((session) => sessionKey(session) !== lastKey);
    if (!freshLocal.length || Math.random() < 0.5) {
        const foreign = await loadRandomForeignSession().catch((error) => {
            console.warn('[Learn replay]', error);
            return null;
        });
        if (foreign) return foreign;
    }
    return pickReplaySession(freshLocal.length ? freshLocal : local);
}

function clearLines() {
    priceLines.forEach((line) => {
        try { series?.removePriceLine(line); } catch { /* series already reset */ }
    });
    priceLines = [];
}

function addLine(price, color, title, dashed = false) {
    if (!series || !(price > 0)) return;
    const options = { price, color, title, lineWidth: 2, axisLabelVisible: true };
    const style = window.LightweightCharts?.LineStyle;
    if (dashed && style) options.lineStyle = style.Dashed;
    priceLines.push(series.createPriceLine(options));
}

function syncLines() {
    clearLines();
    if (!series || !replay) return;
    if (replay.pending) addLine(replay.pending.entry, '#38bdf8', 'Вхід');
    const active = replay.active ? [replay.active] : [];
    replay.trades.slice(-4).concat(active).forEach((trade) => {
        const live = trade === replay.active;
        addLine(trade.entry, '#38bdf8', live ? 'Вхід' : 'Вхід');
        addLine(trade.stop, '#ef4444', 'Стоп', true);
        addLine(trade.take, '#10b981', 'Тейк 1:3.7', true);
    });
    if (replay.status === 'done') {
        (sessionMeta?.originals || []).slice(0, 8).forEach((trade) => {
            const stamp = trade.opened ? ` ${trade.opened}` : '';
            addLine(trade.entry, '#f59e0b', `Журнал${stamp}`, true);
        });
    }
}

async function ensureChart() {
    const host = document.getElementById('learn-replay-chart');
    if (!host) return;
    const LightweightCharts = await ensureLightweightCharts();
    if (chart) return;
    const dark = document.body.getAttribute('data-theme') !== 'light';
    chart = LightweightCharts.createChart(host, {
        width: host.clientWidth,
        height: host.clientHeight || 460,
        layout: {
            background: { color: dark ? '#0f172a' : '#ffffff' },
            textColor: dark ? '#94a3b8' : '#334155',
        },
        grid: {
            vertLines: { color: dark ? '#1e293b' : '#e2e8f0' },
            horzLines: { color: dark ? '#1e293b' : '#e2e8f0' },
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: dark ? '#334155' : '#cbd5e1' },
        handleScroll: true,
        handleScale: true,
        timeScale: {
            borderColor: dark ? '#334155' : '#cbd5e1',
            timeVisible: true,
            secondsVisible: false,
            rightOffset: 8,
        },
    });
    series = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        borderUpColor: '#10b981',
        borderDownColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
    });
    chart.subscribeClick(onChartClick);
    resizeObserver = new ResizeObserver(() => {
        chart?.applyOptions({ width: host.clientWidth, height: host.clientHeight || 460 });
    });
    resizeObserver.observe(host);
}

function onChartClick(param) {
    if (!replay || !series || !param?.point || replay.status === 'done' || replay.active) return;
    const price = series.coordinateToPrice(param.point.y);
    if (!(price > 0)) return;
    clearTimer();
    if (replay.status === 'playing') replay = setReplayStatus(replay, 'paused');
    if (replay.phase === 'stop') replay = setStopPrice(replay, price);
    else {
        replay = beginEntry(replay);
        replay = setEntryPrice(replay, price);
    }
    paint();
}

function paintControls() {
    const play = document.getElementById('learn-replay-play');
    if (play) {
        play.disabled = !replay || replay.status === 'done';
        play.textContent = replay?.status === 'playing' ? 'Пауза' : 'Старт';
    }
    document.querySelectorAll('[data-action="learn-replay-speed"]').forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === (replay?.speed || 1)));
    });
    const canEnter = Boolean(replay && replay.status !== 'done' && !replay.active && replay.cursor < replay.bars.length);
    const entry = document.getElementById('learn-replay-entry');
    const stop = document.getElementById('learn-replay-stop');
    const cancel = document.getElementById('learn-replay-cancel');
    const open = document.getElementById('learn-replay-open');
    if (entry) entry.disabled = !canEnter;
    if (stop) stop.disabled = replay?.phase !== 'stop';
    if (cancel) cancel.disabled = replay?.phase !== 'stop';
    if (open) {
        const target = replay ? cursorAtSessionOpen(replay.bars) : null;
        open.disabled = !replay || replay.status === 'done' || target == null || target <= replay.cursor;
    }
    const take = document.getElementById('learn-replay-take');
    if (take) take.textContent = replay?.active ? `Тейк 1:3.7 · ${formatReplayPrice(replay.active.take)}` : 'Тейк 1:3.7';
    document.getElementById('learn-replay-chart')?.classList.toggle('is-aiming', Boolean(canEnter || replay?.phase === 'stop'));
}

function cellRow(values, tag) {
    const row = document.createElement('tr');
    values.forEach((value) => {
        const cell = document.createElement(tag);
        cell.textContent = value;
        row.appendChild(cell);
    });
    return row;
}

function buildTable(headers, rows) {
    const table = document.createElement('table');
    table.className = 'learn-replay-table';
    const head = document.createElement('thead');
    head.appendChild(cellRow(headers, 'th'));
    const body = document.createElement('tbody');
    rows.forEach((row) => body.appendChild(cellRow(row, 'td')));
    table.appendChild(head);
    table.appendChild(body);
    return table;
}

function sideLabel(side) {
    if (side === 'long') return 'Лонг';
    if (side === 'short') return 'Шорт';
    return '—';
}

function resultLabel(result) {
    if (result === 'take') return 'Тейк';
    if (result === 'stop') return 'Стоп';
    if (result === 'open') return 'До кінця сесії';
    return '—';
}

function formatNet(value) {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${Math.round(value)}$`;
}

function renderResults() {
    const host = document.getElementById('learn-replay-results');
    if (!host) return;
    if (replay?.status !== 'done' || !sessionMeta) {
        if (!host.hidden) {
            host.hidden = true;
            host.replaceChildren();
        }
        return;
    }
    host.hidden = false;
    host.replaceChildren();
    const summary = summarizeAttempts(replay.trades);
    const heading = document.createElement('h4');
    heading.textContent = 'Підсумок';
    const stats = document.createElement('p');
    stats.className = 'learn-replay-summary';
    stats.textContent = summary.attempts
        ? `${summary.attempts} входів · тейків ${summary.wins} · стопів ${summary.losses} · до кінця ${summary.opens} · разом ${formatReplayR(summary.totalR)} · середнє ${formatReplayR(summary.avgR)}`
        : 'Входів не було.';
    const note = document.createElement('p');
    note.className = 'learn-replay-note';
    note.textContent = `День взято в ${sessionMeta.owner}. Якщо свічка зачепила і стоп, і тейк, зараховано стоп.`;

    const grid = document.createElement('div');
    grid.className = 'learn-replay-results-grid';
    const yours = document.createElement('section');
    const yoursTitle = document.createElement('h4');
    yoursTitle.textContent = 'Ваші входи';
    yours.appendChild(yoursTitle);
    yours.appendChild(summary.attempts ? buildTable(
        ['Час', 'Сторона', 'Вхід', 'Стоп', 'Тейк', 'Результат', 'R'],
        replay.trades.map((trade) => [
            formatNy(trade.time),
            sideLabel(trade.side),
            formatReplayPrice(trade.entry),
            formatReplayPrice(trade.stop),
            formatReplayPrice(trade.take),
            resultLabel(trade.result),
            formatReplayR(trade.r),
        ]),
    ) : document.createElement('p'));
    if (!summary.attempts) yours.lastChild.textContent = 'Позицій не відкрито.';

    const source = document.createElement('section');
    const sourceTitle = document.createElement('h4');
    sourceTitle.textContent = `Входи ${sessionMeta.owner}`;
    source.appendChild(sourceTitle);
    const originals = sessionMeta.originals || [];
    source.appendChild(originals.length ? buildTable(
        ['Час', 'Сторона', 'Вхід', 'Вихід', 'Результат'],
        originals.map((trade) => [
            trade.opened || '—',
            sideLabel(trade.type),
            formatReplayPrice(trade.entry),
            formatReplayPrice(trade.exit),
            formatNet(trade.net),
        ]),
    ) : document.createElement('p'));
    if (!originals.length) source.lastChild.textContent = 'У цьому дні немає збережених цін входу.';
    grid.appendChild(yours);
    grid.appendChild(source);
    host.append(heading, stats, note, grid);
}

function paint(resetScale = false) {
    const title = document.getElementById('learn-replay-title');
    if (title) title.textContent = sessionMeta ? `${sessionMeta.symbol} · ${sessionMeta.date}` : 'Сесію ще не вибрано';
    const clock = document.getElementById('learn-replay-clock');
    const last = replay?.bars?.[replay.cursor - 1];
    if (clock) clock.textContent = last ? `${formatNy(last.time)} NY · ${replay.cursor}/${replay.bars.length}` : '';
    setStatus(statusText());
    if (series && replay) {
        series.setData(visibleBars(replay));
        if (resetScale) chart?.timeScale().fitContent();
        else if (replay.status === 'playing') chart?.timeScale().scrollToRealTime();
        syncLines();
    }
    paintControls();
    renderResults();
}

function schedule() {
    clearTimer();
    if (replay?.status !== 'playing') return;
    timer = window.setTimeout(() => {
        replay = advanceReplay(replay);
        paint();
        if (replay?.status === 'playing') schedule();
    }, TICK_MS);
}

export function showLearnMode(mode) {
    const next = mode === 'replay' ? 'replay' : 'videos';
    const replayPane = document.getElementById('learn-replay-pane');
    const videoPane = document.getElementById('learn-videos-pane');
    if (replayPane) replayPane.hidden = next !== 'replay';
    if (videoPane) videoPane.hidden = next !== 'videos';
    document.querySelectorAll('[data-action="learn-mode"]').forEach((button) => {
        const selected = button.dataset.learnMode === next;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
    });
    if (next !== 'replay') pauseLearnReplay();
    else requestAnimationFrame(() => syncLearnReplayLayout());
}

export function pauseLearnReplay() {
    clearTimer();
    if (replay?.status === 'playing') {
        replay = setReplayStatus(replay, 'paused');
        paint();
    }
}

export function syncLearnReplayLayout() {
    const host = document.getElementById('learn-replay-chart');
    if (!chart || !host || host.closest('[hidden]')) return;
    chart.applyOptions({ width: host.clientWidth, height: host.clientHeight || 460 });
}

export function toggleLearnReplay() {
    if (!replay || replay.status === 'done') return;
    clearTimer();
    replay = setReplayStatus(replay, replay.status === 'playing' ? 'paused' : 'playing');
    paint();
    if (replay.status === 'playing') schedule();
}

export function setLearnReplaySpeed(trigger) {
    if (!replay) return;
    replay = setReplaySpeed(replay, Number(trigger?.dataset?.speed));
    paint();
}

export function jumpLearnReplayToOpen() {
    if (!replay || replay.status === 'done') return;
    const wasPlaying = replay.status === 'playing';
    clearTimer();
    replay = jumpToSessionOpen(replay);
    paint();
    if (wasPlaying && replay.status === 'playing') schedule();
}

export function enterLearnReplay() {
    if (!replay) return;
    clearTimer();
    if (replay.status === 'playing') replay = setReplayStatus(replay, 'paused');
    replay = enterAtMarket(replay);
    paint();
}

export function focusLearnReplayStop() {
    if (replay?.phase !== 'stop') return;
    setStatus('Клікніть ціну стопа на графіку. Тейк стане на 1:3.7.');
}

export function cancelLearnReplaySetup() {
    if (!replay) return;
    replay = cancelSetup(replay);
    paint();
}

export async function startLearnReplay() {
    const token = ++loadToken;
    showLearnMode('replay');
    clearTimer();
    replay = null;
    sessionMeta = null;
    clearLines();
    if (series) series.setData([]);
    paint();
    const { data: { session: authSession } } = await supabase.auth.getSession();
    if (token !== loadToken) return;
    if (!authSession) {
        setStatus('Увійдіть у акаунт, щоб зібрати сесію з журналу і завантажити свічки.');
        return;
    }
    setStatus('Шукаємо сесію…');
    const session = await chooseSession();
    if (token !== loadToken) return;
    if (!session) {
        setStatus('У журналі ще немає угод з тікером і ціною входу.');
        return;
    }
    setStatus(`Завантажуємо ${session.symbol} · ${session.date}…`);
    let candles = [];
    try {
        candles = await loadCandles(session.symbol, session.date);
    } catch (error) {
        if (token !== loadToken) return;
        console.warn('[Learn replay]', error);
        setStatus(error?.message || 'Не вдалося завантажити свічки.');
        return;
    }
    if (token !== loadToken) return;
    const next = createReplay(candles, { warmup: 20 });
    if (next.bars.length < 30) {
        setStatus('Замало хвилинних свічок для відтворення.');
        return;
    }
    try {
        await ensureChart();
    } catch (error) {
        if (token !== loadToken) return;
        setStatus(error?.message || 'Графік не завантажився.');
        return;
    }
    if (token !== loadToken) return;
    replay = next;
    sessionMeta = session;
    lastKey = sessionKey(session);
    paint(true);
}
