import { state } from './state.js';
import { supabase } from './supabase.js';
import { showToast } from './utils.js';
import { loadJournalRange } from './storage.js';
import { clampResearchPeriod, shiftIsoMonths } from './market_criteria_analysis.js';
import { loadJournalPolygonDay } from './journal_polygon.js';
import { ensureJsZip, ensureLightweightCharts, ensurePdfTools } from './vendor_loader.js';
import { analysisPrompt, buildExportDocument, collectExportTrades, exportFileBase } from './research_export_core.js';

let running = false;

function root() {
    return document.getElementById('view-research');
}

function field(name) {
    return root()?.querySelector(`[data-research-export-${name}]`);
}

function journalEndDate() {
    const dates = Object.keys(state.appData?.journal || {}).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    return dates.at(-1) || new Date().toISOString().slice(0, 10);
}

function presetMonths(from, to) {
    return [1, 3, 6].find((months) => shiftIsoMonths(to, -months) === from) || 0;
}

function markPreset(months) {
    root()?.querySelectorAll('[data-action="research-export-preset"]').forEach((button) => {
        button.classList.toggle('is-active', Number(button.dataset.months) === months);
    });
}

function applyClamp(edited) {
    const fromInput = field('from');
    const toInput = field('to');
    const next = clampResearchPeriod(fromInput?.value || '', toInput?.value || '', edited);
    if (next.invalid) return next;
    if (fromInput) fromInput.value = next.from;
    if (toInput) toInput.value = next.to;
    markPreset(presetMonths(next.from, next.to));
    if (next.limited && !running) {
        const status = field('status');
        if (status) status.textContent = 'Період скорочено до 6 місяців.';
    }
    return next;
}

export function prepareResearchExport() {
    const panel = root();
    if (!panel || state.myRole !== 'admin' || panel.dataset.exportBound === 'true') return;
    panel.dataset.exportBound = 'true';
    const fromInput = field('from');
    const toInput = field('to');
    if (fromInput && toInput && !fromInput.value) {
        const end = journalEndDate();
        const next = clampResearchPeriod(shiftIsoMonths(end, -1), end, 'from');
        fromInput.value = next.from;
        toInput.value = next.to;
        markPreset(1);
    }
    panel.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.matches('[data-research-export-from]')) applyClamp('from');
        if (target.matches('[data-research-export-to]')) applyClamp('to');
    });
}

export function applyResearchExportPreset(months) {
    if (state.myRole !== 'admin') return;
    const end = field('to')?.value || journalEndDate();
    const next = clampResearchPeriod(shiftIsoMonths(end, -Number(months)), end, 'from');
    const fromInput = field('from');
    const toInput = field('to');
    if (fromInput) fromInput.value = next.from;
    if (toInput) toInput.value = next.to;
    markPreset(Number(months));
}

function readPeriod() {
    const next = applyClamp('to');
    if (!next || next.invalid) throw new Error('Оберіть дату початку і дату кінця');
    return next;
}

function nyOffset(date) {
    const label = new Date(`${date}T12:00:00Z`).toLocaleString('en-US', {
        timeZone: 'America/New_York', timeZoneName: 'short', hour: '2-digit',
    });
    return label.includes('EDT') ? '-04:00' : '-05:00';
}

function prevTradingDate(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    const cursor = new Date(Date.UTC(year, month - 1, day));
    do { cursor.setUTCDate(cursor.getUTCDate() - 1); } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
    return cursor.toISOString().slice(0, 10);
}

function nyMinute(unix) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(unix * 1000));
    let hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (hour === 24) hour = 0;
    return hour * 60 + minute;
}

function toCandles(bars) {
    return (Array.isArray(bars) ? bars : []).map((bar) => ({
        time: Math.floor(Number(bar?.t) / 1000),
        open: Number(bar?.o),
        high: Number(bar?.h),
        low: Number(bar?.l),
        close: Number(bar?.c),
        volume: Number(bar?.v) || 0,
    })).filter((candle) => candle.time > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0);
}

function parseTradeTs(clock, date) {
    const match = String(clock || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return 0;
    const stamp = `${date}T${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}${nyOffset(date)}`;
    return Math.floor(new Date(stamp).getTime() / 1000);
}

function snapToCandle(candles, ts) {
    if (!candles.length || !(ts > 0)) return null;
    let best = candles[0];
    let bestDiff = Math.abs(candles[0].time - ts);
    for (let index = 1; index < candles.length; index += 1) {
        const diff = Math.abs(candles[index].time - ts);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = candles[index];
        } else break;
    }
    return bestDiff <= 600 ? best.time : null;
}

async function loadSessionCandles(symbol, date, token) {
    const current = await loadJournalPolygonDay(symbol, date, token, { from: '04:00:00', to: '23:59:00' });
    const currentCandles = toCandles(current.bars);
    if (!currentCandles.length) throw new Error('Polygon не повернув свічки');
    let previous = [];
    const prevDate = prevTradingDate(date);
    try {
        const loaded = await loadJournalPolygonDay(symbol, prevDate, token, { from: '04:00:00', to: '23:59:00' });
        previous = toCandles(loaded.bars).filter((candle) => nyMinute(candle.time) >= 16 * 60);
    } catch (error) {
        console.warn('[Research export] previous session skipped', symbol, prevDate, error);
    }
    const seen = new Set();
    return [...previous, ...currentCandles].filter((candle) => {
        if (seen.has(candle.time)) return false;
        seen.add(candle.time);
        return true;
    }).sort((left, right) => left.time - right.time);
}

function formatPrice(value) {
    return Number(value) > 0 ? String(Number(Number(value).toFixed(4))) : '—';
}

async function renderTradeChart(record, candles) {
    const LightweightCharts = await ensureLightweightCharts();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-1600px;top:0;width:1200px;height:640px;pointer-events:none;';
    document.body.appendChild(host);
    let chart = null;
    try {
        chart = LightweightCharts.createChart(host, {
            width: 1200,
            height: 640,
            layout: { background: { color: '#0f172a' }, textColor: '#e2e8f0', fontFamily: 'Segoe UI, Arial, sans-serif' },
            grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
            rightPriceScale: { borderColor: '#334155' },
            timeScale: {
                borderColor: '#334155',
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time) => new Date(time * 1000).toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: false,
                }),
            },
        });
        const series = chart.addCandlestickSeries({
            upColor: '#10b981', downColor: '#ef4444',
            borderUpColor: '#10b981', borderDownColor: '#ef4444',
            wickUpColor: '#10b981', wickDownColor: '#ef4444',
        });
        series.setData(candles);
        const entryColor = record.side === 'short' ? '#f97316' : '#3b82f6';
        const exitColor = Number(record.result) >= 0 ? '#10b981' : '#ef4444';
        const tEntry = snapToCandle(candles, parseTradeTs(record.entryTime, record.date));
        const tExit = snapToCandle(candles, parseTradeTs(record.exitTime, record.date));
        const markers = [];
        if (tEntry && tExit && tEntry === tExit) {
            markers.push({ time: tEntry, position: 'aboveBar', color: entryColor, shape: 'circle', text: 'Вхід · вихід' });
        } else {
            if (tEntry) markers.push({ time: tEntry, position: record.side === 'short' ? 'aboveBar' : 'belowBar', color: entryColor, shape: record.side === 'short' ? 'arrowDown' : 'arrowUp', text: 'Вхід' });
            if (tExit) markers.push({ time: tExit, position: record.side === 'short' ? 'belowBar' : 'aboveBar', color: exitColor, shape: 'circle', text: 'Вихід' });
        }
        if (markers.length) series.setMarkers(markers);
        if (record.entryPrice) series.createPriceLine({ price: record.entryPrice, color: entryColor, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'Вхід' });
        const stopPrice = record.stop?.price;
        const exitIsStop = stopPrice && record.exitPrice && Math.abs(stopPrice - record.exitPrice) < 0.0001;
        if (record.exitPrice) {
            series.createPriceLine({
                price: record.exitPrice, color: exitColor, lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true,
                title: exitIsStop ? 'Вихід · стоп' : 'Вихід',
            });
        }
        if (stopPrice && !exitIsStop) {
            series.createPriceLine({
                price: stopPrice, color: '#eab308', lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, title: 'Стоп',
            });
        }
        chart.timeScale().fitContent();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (typeof chart.takeScreenshot !== 'function') throw new Error('Графік не вміє зберегти картинку');
        return chart.takeScreenshot();
    } finally {
        try { chart?.remove(); } catch { /* chart already gone */ }
        host.remove();
    }
}

function composePage(record, shot) {
    const canvas = document.createElement('canvas');
    canvas.width = 1684;
    canvas.height = 1190;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (shot) {
        ctx.drawImage(shot, 42, 28, 1600, 853);
    } else {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '28px Segoe UI, Arial, sans-serif';
        ctx.fillText(record.chartNote || 'Немає свічок для цього дня.', 60, 440);
    }
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 32px Segoe UI, Arial, sans-serif';
    ctx.fillText(`${record.date}   ${record.symbol}   ${record.tradeType || record.side}`, 48, 960);
    ctx.font = '24px Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#cbd5e1';
    const stopText = record.stop?.price
        ? `стоп ${formatPrice(record.stop.price)} · ${record.stop.source === 'cover' ? 'покупка після шорта' : 'вхід + консолідація'}`
        : 'стоп не пораховано';
    ctx.fillText(`вхід ${formatPrice(record.entryPrice)} о ${record.entryTime || '—'}    вихід ${formatPrice(record.exitPrice)} о ${record.exitTime || '—'}    ${stopText}`, 48, 1020);
    const result = record.result == null ? '—' : `${record.result >= 0 ? '+' : ''}${Number(record.result).toFixed(2)}$`;
    ctx.fillText(`вихід: ${record.exitReason || '—'}    результат ${result}    шери ${record.shares ?? '—'}`, 48, 1072);
    return canvas;
}

function canvasBlob(canvas, type) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не вдалося зберегти картинку'))), type);
    });
}

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function buildPackets(onStatus) {
    const period = readPeriod();
    const nick = state.CURRENT_VIEWED_USER || state.USER_DOC_NAME;
    const userId = state.currentViewedUserId || state.myUserId;
    onStatus('Завантажую угоди вибраного періоду…', 0, 1);
    await loadJournalRange(nick, period.from, period.to, userId);
    const trades = collectExportTrades(state.appData?.journal || {}, {
        from: period.from,
        to: period.to,
        sheetRows: state.appData?.sheetRows || {},
        cumulativeSheetRows: state.appData?.cumulativeSheetRows || {},
        includeSheet: field('sheet')?.checked !== false,
        includePolygon: field('polygon')?.checked !== false,
    });
    if (!trades.length) throw new Error('У цьому періоді немає взятих угод.');
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Потрібно увійти в акаунт');
    const groups = [];
    const seen = new Set();
    trades.forEach((trade) => {
        const key = `${trade.symbol}|${trade.date}`;
        if (seen.has(key)) return;
        seen.add(key);
        groups.push({ key, symbol: trade.symbol, date: trade.date });
    });
    const total = groups.length + trades.length;
    const candlesByKey = new Map();
    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        onStatus(`Свічки ${group.symbol} ${group.date} (${index + 1} із ${groups.length})`, index, total);
        try {
            candlesByKey.set(group.key, await loadSessionCandles(group.symbol, group.date, session.access_token));
        } catch (error) {
            candlesByKey.set(group.key, error?.message || 'Немає свічок для цього дня.');
        }
    }
    const packets = [];
    for (let index = 0; index < trades.length; index += 1) {
        const trade = trades[index];
        onStatus(`Графік ${index + 1} із ${trades.length}: ${trade.symbol}`, groups.length + index + 1, total);
        const loaded = candlesByKey.get(`${trade.symbol}|${trade.date}`);
        let shot = null;
        if (Array.isArray(loaded) && loaded.length) {
            try {
                shot = await renderTradeChart(trade, loaded);
            } catch (error) {
                trade.chart = null;
                trade.chartNote = error?.message || 'Не вдалося намалювати графік.';
            }
        } else {
            trade.chart = null;
            trade.chartNote = typeof loaded === 'string' ? loaded : 'Немає свічок для цього дня.';
        }
        packets.push({ trade, shot });
    }
    onStatus('', total, total);
    return { period, packets };
}

function setBusy(busy) {
    root()?.querySelectorAll('[data-action="research-export-pdf"], [data-action="research-export-ai"], [data-action="research-export-preset"]').forEach((button) => {
        button.disabled = busy;
    });
    ['from', 'to', 'sheet', 'polygon'].forEach((name) => {
        const input = field(name);
        if (input) input.disabled = busy;
    });
    const progress = field('progress');
    if (progress) progress.hidden = !busy;
}

async function run(kind) {
    if (running || state.myRole !== 'admin') return;
    if (state.activeTradesImports > 0) {
        showToast('Trades імпортуються. Зачекайте і спробуйте експорт ще раз.');
        return;
    }
    running = true;
    setBusy(true);
    const status = field('status');
    const progress = field('progress');
    const paint = (message, value, max) => {
        if (status && message) status.textContent = message;
        if (progress) {
            progress.max = Math.max(1, max);
            progress.value = value;
        }
    };
    try {
        const { period, packets } = await buildPackets(paint);
        const base = exportFileBase(period.from, period.to);
        if (kind === 'pdf') {
            paint('Збираю PDF…', packets.length, packets.length);
            const { jsPDF } = await ensurePdfTools();
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
            packets.forEach((packet, index) => {
                if (index) pdf.addPage('a4', 'landscape');
                const page = composePage(packet.trade, packet.shot);
                pdf.addImage(page.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 297, 210, undefined, 'FAST');
            });
            pdf.save(`${base}.pdf`);
            if (status) status.textContent = `PDF готовий: ${packets.length} угод, ${period.from} — ${period.to}.`;
            showToast(`PDF: ${packets.length} угод`);
        } else {
            paint('Пакую zip для моделі…', packets.length, packets.length);
            const JSZip = await ensureJsZip();
            const zip = new JSZip();
            zip.file('prompt.md', analysisPrompt());
            for (const packet of packets) {
                if (!packet.shot) continue;
                zip.file(packet.trade.chart, await canvasBlob(packet.shot, 'image/png'));
            }
            zip.file('trades.json', JSON.stringify(buildExportDocument(packets.map((packet) => packet.trade), period), null, 2));
            saveBlob(await zip.generateAsync({ type: 'blob' }), `${base}.zip`);
            const missing = packets.filter((packet) => !packet.shot).length;
            if (status) status.textContent = `Пакет для моделі готовий: ${packets.length} угод${missing ? `, без графіка ${missing}` : ''}.`;
            showToast(`Пакет для моделі: ${packets.length} угод`);
        }
    } catch (error) {
        if (status) status.textContent = `Помилка: ${error?.message || error}`;
        showToast(error?.message || 'Не вдалося зібрати експорт');
    } finally {
        running = false;
        setBusy(false);
    }
}

export function exportResearchPdf() {
    return run('pdf');
}

export function exportResearchAi() {
    return run('ai');
}
