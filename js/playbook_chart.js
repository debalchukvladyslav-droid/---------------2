// === js/playbook_chart.js ===
// Playbook Chart Constructor — вбудовується в редактор сетапу

import { ensureLightweightCharts } from './vendor_loader.js';

const instances = {}; // suffix -> { lwChart, candleSeries, ohlcData, selectedIdx, isDrawing, rawPath }

function getInstance(s) {
    if (!instances[s]) instances[s] = { lwChart: null, candleSeries: null, ohlcData: [], selectedIdx: null, isDrawing: false, rawPath: [] };
    return instances[s];
}

export function initPlaybookChart() {} // залишаємо для сумісності з main.js

export function getChartData(suffix) {
    const inst = instances[suffix];
    if (!inst) return null;
    return inst.ohlcData.length ? { rawPath: inst.rawPath, ohlcData: inst.ohlcData } : null;
}

export function initSetupChart(suffix, savedChartData) {
    const canvas = document.getElementById(`pbc-canvas-${suffix}`);
    if (!canvas) return;
    const inst = getInstance(suffix);
    // Відновлюємо збережені дані якщо є
    if (savedChartData) {
        inst.rawPath = savedChartData.rawPath || [];
        inst.ohlcData = savedChartData.ohlcData || [];
    } else {
        inst.rawPath = [];
    }
    const ctx = canvas.getContext('2d');
    resizeCanvas(canvas);

    canvas.onmousedown = e => { inst.isDrawing = true; addPoint(canvas, inst, e); drawPath(ctx, canvas, inst); };
    canvas.onmousemove = e => { if (!inst.isDrawing) return; addPoint(canvas, inst, e); drawPath(ctx, canvas, inst); };
    canvas.onmouseup = () => { inst.isDrawing = false; };
    canvas.onmouseleave = () => { inst.isDrawing = false; };

    canvas.addEventListener('touchstart', e => { e.preventDefault(); inst.isDrawing = true; addTouchPoint(canvas, inst, e); drawPath(ctx, canvas, inst); }, { passive: false });
    canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!inst.isDrawing) return; addTouchPoint(canvas, inst, e); drawPath(ctx, canvas, inst); }, { passive: false });
    canvas.addEventListener('touchend', () => { inst.isDrawing = false; });

    document.getElementById(`pbc-clear-btn-${suffix}`)?.addEventListener('click', () => {
        inst.rawPath = [];
        drawGrid(ctx, canvas);
    });
    document.getElementById(`pbc-generate-btn-${suffix}`)?.addEventListener('click', () => generateChart(suffix));
    document.getElementById(`pbc-save-candle-btn-${suffix}`)?.addEventListener('click', () => saveEditedCandle(suffix));
    document.getElementById(`pbc-hline-btn-${suffix}`)?.addEventListener('click', () => addHorizontalLine(suffix));
    document.getElementById(`pbc-tline-btn-${suffix}`)?.addEventListener('click', () => addTrendline(suffix));

    drawGrid(ctx, canvas);
    // Відновлюємо намальований шлях якщо є
    if (inst.rawPath.length) drawPath(ctx, canvas, inst);
    // Відновлюємо чарт якщо є збережені дані
    if (inst.ohlcData.length) {
        renderLWChart(suffix, inst.ohlcData);
        const sec = document.getElementById(`pbc-chart-section-${suffix}`);
        if (sec) sec.style.display = 'block';
    }
    window.addEventListener('resize', () => { resizeCanvas(canvas); drawGrid(ctx, canvas); if (inst.rawPath.length) drawPath(ctx, canvas, inst); });
}

function resizeCanvas(canvas) {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width || 600;
    canvas.height = 220;
}

function addPoint(canvas, inst, e) {
    const r = canvas.getBoundingClientRect();
    inst.rawPath.push({ x: e.clientX - r.left, y: e.clientY - r.top });
}

function addTouchPoint(canvas, inst, e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches[0];
    inst.rawPath.push({ x: t.clientX - r.left, y: t.clientY - r.top });
}

function drawGrid(ctx, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
    ctx.setLineDash([]);
}

function drawPath(ctx, canvas, inst) {
    drawGrid(ctx, canvas);
    if (inst.rawPath.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(inst.rawPath[0].x, inst.rawPath[0].y);
    for (let i = 1; i < inst.rawPath.length; i++) ctx.lineTo(inst.rawPath[i].x, inst.rawPath[i].y);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
}

function pathToOHLC(path, numCandles, volatility, canvasHeight) {
    if (path.length < 2) return [];
    const PRICE_MIN = 1, PRICE_MAX = 5;
    const yToPrice = y => PRICE_MAX - (y / canvasHeight) * (PRICE_MAX - PRICE_MIN);
    const xMin = Math.min(...path.map(p => p.x));
    const xMax = Math.max(...path.map(p => p.x));
    const xSpan = xMax - xMin || 1;
    const bucketWidth = xSpan / numCandles;
    const buckets = Array.from({ length: numCandles }, () => []);
    for (const pt of path) {
        const idx = Math.min(Math.floor((pt.x - xMin) / bucketWidth), numCandles - 1);
        buckets[idx].push(pt);
    }
    const PADDING = (volatility / 10) * 0.015;
    const CHAOS = (volatility / 10) * 0.018;
    const rand = () => (Math.random() - 0.5) * 2 * CHAOS;
    const baseTime = Math.floor(Date.now() / 1000) - numCandles * 86400;
    const result = [];
    let prevClose = yToPrice(path[0].y);
    for (let i = 0; i < numCandles; i++) {
        const pts = buckets[i];
        let open, close, high, low;
        if (pts.length === 0) {
            open = close = prevClose; high = prevClose + PADDING; low = prevClose - PADDING;
        } else {
            const sorted = pts.slice().sort((a, b) => a.x - b.x);
            open = yToPrice(sorted[0].y) + rand();
            close = yToPrice(sorted[sorted.length - 1].y) + rand();
            const priceHigh = yToPrice(Math.min(...pts.map(p => p.y)));
            const priceLow = yToPrice(Math.max(...pts.map(p => p.y)));
            high = Math.max(open, close, priceHigh) + PADDING * (0.5 + Math.random());
            low = Math.min(open, close, priceLow) - PADDING * (0.5 + Math.random());
        }
        open = Math.max(PRICE_MIN, Math.min(PRICE_MAX, open));
        close = Math.max(PRICE_MIN, Math.min(PRICE_MAX, close));
        high = Math.min(PRICE_MAX, Math.max(high, Math.max(open, close)));
        low = Math.max(PRICE_MIN, Math.min(low, Math.min(open, close)));
        prevClose = close;
        result.push({ time: baseTime + i * 86400, open: parseFloat(open.toFixed(4)), high: parseFloat(high.toFixed(4)), low: parseFloat(low.toFixed(4)), close: parseFloat(close.toFixed(4)) });
    }
    return result;
}

function generateChart(suffix) {
    const inst = getInstance(suffix);
    const canvas = document.getElementById(`pbc-canvas-${suffix}`);
    if (!inst.rawPath.length) { alert('Намалюйте лінію на полотні!'); return; }
    const numCandles = parseInt(document.getElementById(`pbc-candles-${suffix}`)?.value || 30);
    const volatility = parseFloat(document.getElementById(`pbc-volatility-${suffix}`)?.value || 3);
    inst.ohlcData = pathToOHLC(inst.rawPath, numCandles, volatility, canvas.height);
    renderLWChart(suffix, inst.ohlcData);
    const sec = document.getElementById(`pbc-chart-section-${suffix}`);
    if (sec) sec.style.display = 'block';
}

async function renderLWChart(suffix, data) {
    const inst = getInstance(suffix);
    const container = document.getElementById(`pbc-lw-container-${suffix}`);
    if (!container) return;
    await ensureLightweightCharts();
    if (inst.lwChart) { inst.lwChart.remove(); inst.lwChart = null; inst.candleSeries = null; }
    const isDark = document.body.getAttribute('data-theme') !== 'light';
    inst.lwChart = LightweightCharts.createChart(container, {
        width: container.clientWidth, height: 350,
        layout: { background: { color: isDark ? '#1e293b' : '#ffffff' }, textColor: isDark ? '#94a3b8' : '#334155' },
        grid: { vertLines: { color: isDark ? '#334155' : '#e2e8f0' }, horzLines: { color: isDark ? '#334155' : '#e2e8f0' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: isDark ? '#334155' : '#e2e8f0' },
        timeScale: { borderColor: isDark ? '#334155' : '#e2e8f0', timeVisible: false },
    });
    inst.candleSeries = inst.lwChart.addCandlestickSeries({
        upColor: '#10b981', downColor: '#ef4444',
        borderUpColor: '#10b981', borderDownColor: '#ef4444',
        wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });
    inst.candleSeries.setData(data);
    inst.lwChart.timeScale().fitContent();
    inst.lwChart.subscribeClick(param => {
        if (!param.time) return;
        const idx = inst.ohlcData.findIndex(c => c.time === param.time);
        if (idx === -1) return;
        inst.selectedIdx = idx;
        populateCandleEditor(suffix, inst.ohlcData[idx]);
    });
    new ResizeObserver(() => inst.lwChart?.applyOptions({ width: container.clientWidth })).observe(container);
}

function populateCandleEditor(suffix, candle) {
    const panel = document.getElementById(`pbc-editor-panel-${suffix}`);
    if (!panel) return;
    panel.style.display = 'flex';
    document.getElementById(`pbc-edit-o-${suffix}`).value = candle.open;
    document.getElementById(`pbc-edit-h-${suffix}`).value = candle.high;
    document.getElementById(`pbc-edit-l-${suffix}`).value = candle.low;
    document.getElementById(`pbc-edit-c-${suffix}`).value = candle.close;
}

function saveEditedCandle(suffix) {
    const inst = getInstance(suffix);
    if (inst.selectedIdx === null || !inst.candleSeries) return;
    const o = parseFloat(document.getElementById(`pbc-edit-o-${suffix}`).value);
    const h = parseFloat(document.getElementById(`pbc-edit-h-${suffix}`).value);
    const l = parseFloat(document.getElementById(`pbc-edit-l-${suffix}`).value);
    const c = parseFloat(document.getElementById(`pbc-edit-c-${suffix}`).value);
    if ([o, h, l, c].some(isNaN)) return;
    const updated = { ...inst.ohlcData[inst.selectedIdx], open: o, high: h, low: l, close: c };
    inst.ohlcData[inst.selectedIdx] = updated;
    inst.candleSeries.update(updated);
}

const DASHED = 2;

function addHorizontalLine(suffix) {
    const inst = getInstance(suffix);
    if (!inst.candleSeries) return;
    const mid = ((inst.ohlcData.reduce((s, c) => s + c.close, 0) / inst.ohlcData.length) || 3).toFixed(4);
    const price = parseFloat(prompt('Ціна рівня (Support/Resistance):', mid));
    if (isNaN(price)) return;
    inst.candleSeries.createPriceLine({ price, color: '#f59e0b', lineWidth: 2, lineStyle: DASHED, axisLabelVisible: true, title: 'S/R' });
}

const trendlineState = {}; // suffix -> { mode, anchor }

function addTrendline(suffix) {
    const inst = getInstance(suffix);
    if (!inst.lwChart || !inst.ohlcData.length) return;
    if (!trendlineState[suffix]) trendlineState[suffix] = { mode: false, anchor: null };
    const ts = trendlineState[suffix];
    if (ts.mode) { exitTrendlineMode(suffix); return; }
    ts.mode = true; ts.anchor = null;
    const btn = document.getElementById(`pbc-tline-btn-${suffix}`);
    if (btn) { btn.textContent = '📐 Клік 1ю точку...'; btn.style.borderColor = '#a78bfa'; btn.style.color = '#a78bfa'; }
    inst.lwChart.subscribeClick(param => onTrendlineClick(suffix, param));
}

function onTrendlineClick(suffix, param) {
    const inst = getInstance(suffix);
    const ts = trendlineState[suffix];
    if (!ts?.mode || !param.time || !param.point) return;
    const price = inst.candleSeries.coordinateToPrice(param.point.y);
    if (price === null) return;
    if (!ts.anchor) {
        ts.anchor = { time: param.time, value: parseFloat(price.toFixed(4)) };
        const btn = document.getElementById(`pbc-tline-btn-${suffix}`);
        if (btn) btn.textContent = '📐 Клік 2ю точку...';
    } else {
        const p2 = { time: param.time, value: parseFloat(price.toFixed(4)) };
        const [from, to] = ts.anchor.time <= p2.time ? [ts.anchor, p2] : [p2, ts.anchor];
        const trendSeries = inst.lwChart.addLineSeries({ color: '#a78bfa', lineWidth: 2, lineStyle: DASHED, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        trendSeries.setData([from, to]);
        exitTrendlineMode(suffix);
    }
}

function exitTrendlineMode(suffix) {
    const inst = getInstance(suffix);
    const ts = trendlineState[suffix];
    if (ts) { ts.mode = false; ts.anchor = null; }
    if (inst.lwChart) inst.lwChart.unsubscribeClick(param => onTrendlineClick(suffix, param));
    const btn = document.getElementById(`pbc-tline-btn-${suffix}`);
    if (btn) { btn.textContent = '📐 Trendline'; btn.style.borderColor = ''; btn.style.color = ''; }
}
