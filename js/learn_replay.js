import { supabase, SUPABASE_URL } from './supabase.js';
import { getOrLoadPolygonDay } from './polygon_intraday_cache.js';
import { ensureLightweightCharts } from './vendor_loader.js';
import {
    advanceReplay,
    beginEntry,
    cancelSetup,
    createReplay,
    enterAtMarket,
    entriesAllowed,
    formatReplayPrice,
    formatReplayR,
    setEntryPrice,
    setReplaySpeed,
    setReplayStatus,
    setStopPrice,
    summarizeAttempts,
    visibleBars,
} from './learn_replay_core.js';

const TICK_MS = 200;
const NEXT_TICKER_MS = 6000;
const LESSON_KEY = 'tj:learn-replay-introduced';

let replay = null;
let sessionMeta = null;
let loadToken = 0;
let timer = 0;
let nextTimer = 0;
let chart = null;
let series = null;
let priceLines = [];
let resizeObserver = null;
let lessonRunning = false;
let coachStep = null;
let courseTrades = [];
let sessionQueue = [];
const seenSessions = new Set();

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

function lessonNeeded() {
    try { return localStorage.getItem(LESSON_KEY) !== '1'; } catch { return false; }
}

function markLesson() {
    try { localStorage.setItem(LESSON_KEY, '1'); } catch { /* private mode */ }
}

function clearNextTimer() {
    if (nextTimer) window.clearTimeout(nextTimer);
    nextTimer = 0;
}

function statusText() {
    if (coachStep === 'intro') return 'Натисни «Почати».';
    if (!replay || !sessionMeta) return lessonRunning ? 'Шукаємо тікер…' : 'Натисни «Почати».';
    if (replay.status === 'done') return lessonRunning ? 'Тікер закінчився. Зараз відкриється наступний.' : 'Тікер закінчився. Нижче звірка з реальними угодами.';
    if (coachStep === 'start') return 'Натисни «Старт». Стрічка піде з 9:30.';
    if (coachStep === 'entry') return 'Клікни на графіку ціну входу.';
    if (replay.phase === 'stop' || coachStep === 'stop') return 'Клікни ціну стопа. Тейк стане на 1:3.7.';
    if (replay.active) {
        const side = replay.active.side === 'long' ? 'лонг' : 'шорт';
        return `У позиції · ${side} · тейк ${formatReplayPrice(replay.active.take)}`;
    }
    if (replay.trades.length === 1 && replay.trades[0].result === 'stop') return 'Стоп. На цей тікер можна зробити ще один вхід.';
    if (replay.trades.length && !entriesAllowed(replay)) return 'Вхід на цей тікер уже є. Дивись, чим закриється позиція.';
    if (replay.status === 'playing') return 'Стрічка йде з 9:30. Клік по графіку ставить вхід на поточній свічці.';
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

function shuffle(items) {
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
}

async function refillQueue() {
    const { data, error } = await supabase
        .from('trades')
        .select('trade_date, ticker')
        .is('deleted_at', null)
        .gt('entry_price', 0)
        .order('trade_date', { ascending: false })
        .limit(500);
    if (error) throw new Error(error.message || 'Не вдалося прочитати угоди.');
    const keys = new Set();
    const sessions = [];
    (data || []).forEach((row) => {
        const symbol = String(row.ticker || '').trim().toUpperCase();
        const date = String(row.trade_date || '').slice(0, 10);
        const key = `${symbol}|${date}`;
        if (!/^[A-Z]{1,10}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || keys.has(key) || seenSessions.has(key)) return;
        keys.add(key);
        sessions.push({ symbol, date, key });
    });
    sessionQueue = shuffle(sessions);
}

async function takeNextSession() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!sessionQueue.length) await refillQueue();
        const next = sessionQueue.shift();
        if (!next) return null;
        seenSessions.add(next.key);
        const { data, error } = await supabase
            .from('trades')
            .select('user_id, side, entry_price, exit_price, pnl, payload')
            .eq('trade_date', next.date)
            .ilike('ticker', next.symbol)
            .is('deleted_at', null);
        if (error) throw new Error(error.message || 'Не вдалося прочитати угоди цього тікера.');
        const rows = data || [];
        const ids = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
        const nicks = new Map();
        if (ids.length) {
            const { data: people } = await supabase.from('profiles').select('id, nick').in('id', ids);
            (people || []).forEach((person) => nicks.set(person.id, person.nick || 'трейдер'));
        }
        const originals = rows.map((row) => {
            const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
            const sideText = String(row.side || payload.type || '');
            return {
                owner: nicks.get(row.user_id) || 'трейдер',
                type: /short/i.test(sideText) ? 'short' : /long/i.test(sideText) ? 'long' : '',
                entry: Number(row.entry_price),
                exit: Number(row.exit_price),
                opened: String(payload.opened || payload.entryTime || '').trim(),
                closed: String(payload.closed || payload.exitTime || '').trim(),
                net: Number(row.pnl),
            };
        }).filter((trade) => trade.entry > 0);
        if (!originals.length) continue;
        const owners = [...new Set(originals.map((trade) => trade.owner))];
        return { symbol: next.symbol, date: next.date, owner: owners.join(', '), originals };
    }
    return null;
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
    else if (entriesAllowed(replay)) {
        replay = beginEntry(replay);
        replay = setEntryPrice(replay, price);
    }
    noteSetup();
    paint();
    if (replay?.status === 'playing') schedule();
}

function noteSetup() {
    if (coachStep === 'entry' && replay?.phase === 'stop') coachStep = 'stop';
    if (coachStep === 'stop' && replay?.phase === 'position') {
        coachStep = null;
        markLesson();
        if (replay.status !== 'done') replay = setReplayStatus(replay, 'playing');
    }
}

function paintControls() {
    const run = document.getElementById('learn-replay-new');
    if (run) run.textContent = lessonRunning ? 'Зупинити' : 'Почати';
    const play = document.getElementById('learn-replay-play');
    if (play) {
        play.disabled = !replay || replay.status === 'done';
        play.textContent = replay?.status === 'playing' ? 'Пауза' : 'Старт';
        play.classList.toggle('is-lesson-target', coachStep === 'start');
    }
    document.querySelectorAll('[data-action="learn-replay-speed"]').forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === (replay?.speed || 1)));
    });
    const canEnter = entriesAllowed(replay);
    const entry = document.getElementById('learn-replay-entry');
    const stop = document.getElementById('learn-replay-stop');
    const cancel = document.getElementById('learn-replay-cancel');
    if (entry) entry.disabled = !canEnter;
    if (stop) stop.disabled = replay?.phase !== 'stop';
    if (cancel) cancel.disabled = replay?.phase !== 'stop' && replay?.phase !== 'entry';
    const take = document.getElementById('learn-replay-take');
    if (take) take.textContent = replay?.active ? `Тейк 1:3.7 · ${formatReplayPrice(replay.active.take)}` : 'Тейк 1:3.7';
    const chartHost = document.getElementById('learn-replay-chart');
    chartHost?.classList.toggle('is-aiming', Boolean(canEnter || replay?.phase === 'stop'));
    chartHost?.classList.toggle('is-lesson-target', coachStep === 'entry' || coachStep === 'stop');
    document.getElementById('learn-replay-new')?.classList.toggle('is-lesson-target', coachStep === 'intro');
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
    const course = summarizeAttempts(courseTrades);
    const heading = document.createElement('h4');
    heading.textContent = 'Звірка';
    const stats = document.createElement('p');
    stats.className = 'learn-replay-summary';
    stats.textContent = summary.attempts
        ? `Твій вхід: ${summary.wins} тейк · ${summary.losses} стоп · разом ${formatReplayR(summary.totalR)}. За урок ${course.attempts} входів, ${formatReplayR(course.totalR)}.`
        : 'На цьому тікері входу не було.';
    const note = document.createElement('p');
    note.className = 'learn-replay-note';
    note.textContent = lessonRunning
        ? `Реальні угоди: ${sessionMeta.owner}. Наступний тікер відкриється сам. «Зупинити» лишає цю звірку.`
        : `Реальні угоди: ${sessionMeta.owner}. Якщо свічка зачепила і стоп, і тейк, зараховано стоп.`;

    const grid = document.createElement('div');
    grid.className = 'learn-replay-results-grid';
    const yours = document.createElement('section');
    const yoursTitle = document.createElement('h4');
    yoursTitle.textContent = 'Твій вхід';
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
    sourceTitle.textContent = 'Реальні угоди';
    source.appendChild(sourceTitle);
    const originals = sessionMeta.originals || [];
    source.appendChild(originals.length ? buildTable(
        ['Трейдер', 'Час', 'Сторона', 'Вхід', 'Вихід', 'Результат'],
        originals.map((trade) => [
            trade.owner || sessionMeta.owner,
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
    paintCoach();
    renderResults();
}

function paintCoach() {
    const box = document.getElementById('learn-replay-coach');
    const text = document.getElementById('learn-replay-coach-text');
    if (!box || !text) return;
    const copy = {
        intro: ['Почати', 'Натисни «Почати». Візьмемо тікер, який хтось уже торгував, і підемо з першої хвилини сесії.'],
        start: ['Старт', 'Натисни «Старт». Свічки підуть з 9:30, з тієї хвилини, коли сесія відкривається.'],
        entry: ['Точка входу', 'Клікни на графіку ціну, де хочеш увійти. Вхід стане на поточній свічці.'],
        stop: ['Стоп', 'Одразу клікни ціну стопа. Тейк порахується сам: 1 до 3.7.'],
    }[coachStep];
    box.hidden = !copy;
    text.replaceChildren();
    if (!copy) return;
    const title = document.createElement('strong');
    title.textContent = copy[0];
    const body = document.createElement('span');
    body.textContent = copy[1];
    text.append(title, body);
}

function schedule() {
    clearTimer();
    if (replay?.status !== 'playing') return;
    timer = window.setTimeout(() => {
        const previous = replay?.status;
        replay = advanceReplay(replay);
        const finished = previous !== 'done' && replay?.status === 'done';
        if (finished) courseTrades = courseTrades.concat(replay.trades || []);
        paint();
        if (finished) queueNextTicker();
        else if (replay?.status === 'playing') schedule();
    }, TICK_MS);
}

function queueNextTicker() {
    clearNextTimer();
    if (!lessonRunning) return;
    nextTimer = window.setTimeout(() => {
        void startLearnReplay({ autoplay: true });
    }, NEXT_TICKER_MS);
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
    else {
        if (!replay && lessonNeeded()) coachStep = 'intro';
        paint();
        requestAnimationFrame(() => syncLearnReplayLayout());
    }
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
    const starting = replay.status !== 'playing';
    replay = setReplayStatus(replay, starting ? 'playing' : 'paused');
    if (starting && coachStep === 'start') coachStep = 'entry';
    paint();
    if (replay.status === 'playing') schedule();
}

export function setLearnReplaySpeed(trigger) {
    if (!replay) return;
    replay = setReplaySpeed(replay, Number(trigger?.dataset?.speed));
    paint();
}

export function enterLearnReplay() {
    if (!replay || !entriesAllowed(replay)) return;
    clearTimer();
    if (replay.status === 'playing') replay = setReplayStatus(replay, 'paused');
    replay = enterAtMarket(replay);
    noteSetup();
    paint();
    if (replay?.status === 'playing') schedule();
}

export function focusLearnReplayStop() {
    if (replay?.phase !== 'stop') return;
    coachStep = coachStep === 'start' ? 'stop' : coachStep;
    setStatus('Клікни ціну стопа на графіку. Тейк стане на 1:3.7.');
    paintCoach();
}

export function cancelLearnReplaySetup() {
    if (!replay) return;
    const wasStop = replay.phase === 'stop';
    replay = cancelSetup(replay);
    if (wasStop && coachStep === 'stop') coachStep = 'entry';
    paint();
}

export function onLearnRunButton() {
    if (lessonRunning) {
        stopLearnRun();
        return;
    }
    void startLearnReplay({ autoplay: false, fresh: true });
}

function stopLearnRun() {
    lessonRunning = false;
    clearTimer();
    clearNextTimer();
    if (replay?.status === 'playing') replay = setReplayStatus(replay, 'paused');
    paint();
    setStatus('Урок зупинено.');
}

export async function startLearnReplay({ autoplay = false, fresh = false } = {}) {
    const token = ++loadToken;
    if (fresh) {
        courseTrades = [];
        seenSessions.clear();
        sessionQueue = [];
        coachStep = lessonNeeded() ? 'start' : null;
    }
    lessonRunning = true;
    showLearnMode('replay');
    clearTimer();
    clearNextTimer();
    replay = null;
    sessionMeta = null;
    clearLines();
    if (series) series.setData([]);
    paint();
    const { data: { session: authSession } } = await supabase.auth.getSession();
    if (token !== loadToken) return;
    if (!authSession) {
        lessonRunning = false;
        coachStep = null;
        paint();
        setStatus('Увійдіть у акаунт, щоб узяти угоди з TRADES і завантажити свічки.');
        return;
    }
    setStatus('Шукаємо тікер у TRADES…');
    let session = null;
    let next = null;
    try {
        for (let attempt = 0; attempt < 4 && !next; attempt += 1) {
            session = await takeNextSession();
            if (token !== loadToken) return;
            if (!session) break;
            setStatus(`Завантажуємо ${session.symbol} · ${session.date}…`);
            const candles = await loadCandles(session.symbol, session.date);
            if (token !== loadToken) return;
            const candidate = createReplay(candles, { fromOpen: true });
            if (candidate.bars.length >= 30 && candidate.status !== 'done') next = candidate;
        }
    } catch (error) {
        if (token !== loadToken) return;
        lessonRunning = false;
        console.warn('[Learn replay]', error);
        paint();
        setStatus(error?.message || 'Не вдалося завантажити свічки.');
        return;
    }
    if (token !== loadToken) return;
    if (!session || !next) {
        lessonRunning = false;
        paint();
        setStatus('У TRADES ще немає тікера з ціною входу і хвилинними свічками.');
        return;
    }
    try {
        await ensureChart();
    } catch (error) {
        if (token !== loadToken) return;
        lessonRunning = false;
        paint();
        setStatus(error?.message || 'Графік не завантажився.');
        return;
    }
    if (token !== loadToken) return;
    replay = autoplay ? setReplayStatus(next, 'playing') : next;
    sessionMeta = session;
    if (!autoplay && lessonNeeded()) coachStep = 'start';
    else if (autoplay && (coachStep === 'start' || coachStep === 'intro')) coachStep = 'entry';
    paint(true);
    if (replay.status === 'playing') schedule();
}
