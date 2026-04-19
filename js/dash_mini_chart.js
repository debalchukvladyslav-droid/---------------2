// === Міні-крива кумулятивного PnL на дашборді (поточний місяць) ===
import { state } from './state.js';

let _miniChart = null;

const equityLastPointPlugin = {
    id: 'equityLastPoint',
    afterDatasetsDraw(chart) {
        const mainIndex = chart.data.datasets.findIndex(ds => ds.role === 'equity-main');
        if (mainIndex < 0) return;
        const meta = chart.getDatasetMeta(mainIndex);
        const points = meta?.data || [];
        if (!points.length) return;

        const point = points[points.length - 1];
        const theme = chart.canvas?.$equityChartTheme || {};
        const color = theme.orange || '#f97316';
        const { ctx } = chart;

        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = theme.isLight ? 12 : 20;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = colorWithAlpha(theme.isLight ? theme.bgPanel || '#ffffff' : '#ffffff', 0.86);
        ctx.shadowColor = colorWithAlpha(color, theme.isLight ? 0.45 : 0.9);
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.restore();
    },
};

const equityValueLabelsPlugin = {
    id: 'equityValueLabels',
    afterDatasetsDraw(chart) {
        const mainIndex = chart.data.datasets.findIndex(ds => ds.role === 'equity-main');
        if (mainIndex < 0) return;

        const dataset = chart.data.datasets[mainIndex];
        const values = dataset?.data || [];
        const meta = chart.getDatasetMeta(mainIndex);
        const points = meta?.data || [];
        if (!values.length || !points.length) return;

        const peakValue = Math.max(...values);
        const peakIndex = values.lastIndexOf(peakValue);
        const lastIndex = values.length - 1;
        const theme = chart.canvas?.$equityChartTheme || {};
        const labels = [
            { index: peakIndex, text: `$${Math.round(peakValue)}`, color: theme.profit || '#10b981', dy: -16 },
            { index: lastIndex, text: `$${Math.round(values[lastIndex] || 0)}`, color: theme.orange || '#f97316', dy: -18 },
        ].filter((label, index, all) => all.findIndex(item => item.index === label.index) === index);

        const { ctx } = chart;
        ctx.save();
        ctx.font = "700 11px 'DM Mono', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        labels.forEach(({ index, text, color, dy }) => {
            const point = points[index];
            if (!point) return;

            ctx.fillStyle = theme.labelBg || colorWithAlpha('#0b0f14', 0.78);
            const width = ctx.measureText(text).width + 12;
            const x = Math.max(chart.chartArea.left + width / 2, Math.min(chart.chartArea.right - width / 2, point.x));
            const y = Math.max(chart.chartArea.top + 10, point.y + dy);
            roundRect(ctx, x - width / 2, y - 9, width, 18, 6);
            ctx.fill();
            ctx.strokeStyle = theme.labelBorder || colorWithAlpha(color, 0.35);
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = color;
            ctx.shadowColor = colorWithAlpha(color, theme.isLight ? 0.24 : 0.45);
            ctx.shadowBlur = 8;
            ctx.fillText(text, x, y);
            ctx.shadowBlur = 0;
        });

        ctx.restore();
    },
};

const equityZeroLinePlugin = {
    id: 'equityZeroLine',
    beforeDatasetsDraw(chart) {
        const yScale = chart.scales?.y;
        const area = chart.chartArea;
        if (!yScale || !area || yScale.min > 0 || yScale.max < 0) return;

        const y = yScale.getPixelForValue(0);
        const { ctx } = chart;
        const color = chart.canvas?.$equityBaseColor || getCssVar('--profit', '#10b981');

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = colorWithAlpha(color, 0.9);
        ctx.shadowColor = colorWithAlpha(color, 0.35);
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
    },
};

function getCssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function getEquityChartTheme() {
    const bgPanel = getCssVar('--bg-panel', '#111827');
    const border = getCssVar('--border', '#263241');
    const bgRgb = parseColorToRgb(bgPanel, '#111827');
    const luminance = (0.2126 * bgRgb[0] + 0.7152 * bgRgb[1] + 0.0722 * bgRgb[2]) / 255;
    const isLight = luminance > 0.72 || document.body?.getAttribute('data-theme') === 'light';
    return {
        isLight,
        bgPanel,
        profit: getCssVar('--profit', '#10b981'),
        loss: getCssVar('--loss', '#ef4444'),
        orange: '#f97316',
        muted: getCssVar('--text-muted', '#9ca3af'),
        text: getCssVar('--text-main', '#f8fafc'),
        grid: colorWithAlpha(border, isLight ? 0.72 : 0.62),
        labelBg: colorWithAlpha(bgPanel, isLight ? 0.94 : 0.86),
        labelBorder: colorWithAlpha(border, isLight ? 0.9 : 0.75),
    };
}

function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}

function formatMoney(value) {
    const n = Number(value) || 0;
    return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function colorWithAlpha(color, alpha) {
    const c = String(color || '').trim();
    if (c.startsWith('#')) {
        const hex = c.length === 4
            ? c.slice(1).split('').map(ch => ch + ch).join('')
            : c.slice(1, 7);
        const n = parseInt(hex, 16);
        if (Number.isFinite(n)) {
            const r = (n >> 16) & 255;
            const g = (n >> 8) & 255;
            const b = n & 255;
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
    }
    if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
    if (c.startsWith('rgba(')) return c.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
    return c;
}

function setMetric(id, value, mode = 'signed') {
    const el = document.getElementById(id);
    if (!el) return;
    const n = Number(value) || 0;
    el.textContent = mode === 'abs' ? `$${Math.abs(n).toFixed(2)}` : formatMoney(n);
    el.classList.toggle('is-pos', n >= 0);
    el.classList.toggle('is-neg', n < 0);
}

function interpolateSeries(series, t) {
    if (!series.length) return 0;
    if (series.length === 1) return series[0] || 0;
    const pos = Math.max(0, Math.min(1, t)) * (series.length - 1);
    const left = Math.floor(pos);
    const right = Math.min(series.length - 1, left + 1);
    const local = pos - left;
    return (series[left] || 0) + ((series[right] || 0) - (series[left] || 0)) * local;
}

function valueGradientColor(value, minValue, maxValue, theme = {}) {
    const red = theme.loss || getCssVar('--loss', '#dc2626');
    const orange = theme.orange || '#f97316';
    const green = theme.profit || getCssVar('--profit', '#10b981');
    const n = Number(value) || 0;

    if (n <= 0) {
        const span = Math.max(1, Math.abs(Math.min(0, minValue)));
        return mixColor(red, orange, 1 - Math.min(1, Math.abs(n) / span));
    }

    const span = Math.max(1, Math.max(0, maxValue));
    return mixColor(orange, green, Math.min(1, n / span));
}

function buildValueGradient(ctx, chartArea, values, alpha = 1, theme = {}) {
    const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
    if (!values.length) {
        gradient.addColorStop(0, colorWithAlpha(theme.orange || '#f97316', alpha));
        gradient.addColorStop(1, colorWithAlpha(theme.profit || '#10b981', alpha));
        return gradient;
    }

    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const samples = Math.max(16, Math.min(56, values.length * 5));

    for (let i = 0; i < samples; i++) {
        const stop = samples === 1 ? 0 : i / (samples - 1);
        const value = interpolateSeries(values, stop);
        gradient.addColorStop(stop, colorWithAlpha(valueGradientColor(value, minValue, maxValue, theme), alpha));
    }

    return gradient;
}

function getMonthDayloss(year, monthIndex) {
    const mk = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const monthly = state.appData?.settings?.monthlyDayloss || {};
    const value = monthly[mk] !== undefined
        ? Number(monthly[mk])
        : Number(state.appData?.settings?.defaultDayloss ?? -100);
    return Number.isFinite(value) && value !== 0 ? value : -100;
}

function buildAllTimeEquityMap(journal) {
    const rows = Object.keys(journal || {})
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
    const map = {};
    let equity = 0;
    let peak = 0;

    rows.forEach((dateStr) => {
        const pnl = parseFloat(journal[dateStr]?.pnl);
        if (!Number.isFinite(pnl)) return;
        equity += pnl;
        peak = Math.max(peak, equity);
        map[dateStr] = {
            equity: parseFloat(equity.toFixed(2)),
            peak: parseFloat(peak.toFixed(2)),
            pullback: parseFloat((equity - peak).toFixed(2)),
        };
    });

    return map;
}

function lerp(a, b, t) {
    return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

function parseColorToRgb(color, fallback = '#10b981') {
    const c = String(color || fallback).trim();
    if (c.startsWith('#')) {
        const hex = c.length === 4
            ? c.slice(1).split('').map(ch => ch + ch).join('')
            : c.slice(1, 7);
        const n = parseInt(hex, 16);
        if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return parseColorToRgb(fallback, '#10b981');
}

function mixColor(a, b, t) {
    const ca = parseColorToRgb(a);
    const cb = parseColorToRgb(b);
    return `rgb(${lerp(ca[0], cb[0], t)}, ${lerp(ca[1], cb[1], t)}, ${lerp(ca[2], cb[2], t)})`;
}

export function updateDashMiniEquityChart(year, monthIndex) {
    const canvas = document.getElementById('dash-mini-equity-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const mk = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const prefix = `${mk}-`;
    const journal = state.appData?.journal || {};

    const days = Object.keys(journal)
        .filter((d) => d.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();

    const labels = [];
    const cumSeries = [];
    const dailySeries = [];
    const pullbackSeries = [];
    const seriesDays = [];
    const allTimeEquity = buildAllTimeEquityMap(journal);
    let cum = 0;
    let currentPullback = 0;

    days.forEach((d) => {
        const pnl = parseFloat(journal[d]?.pnl);
        if (!Number.isFinite(pnl)) return;
        cum += pnl;
        const pullback = allTimeEquity[d]?.pullback ?? 0;
        currentPullback = pullback;
        labels.push(d.slice(8));
        seriesDays.push(d);
        dailySeries.push(parseFloat(pnl.toFixed(2)));
        pullbackSeries.push(pullback);
        cumSeries.push(parseFloat(cum.toFixed(2)));
    });

    setMetric('dash-equity-drawdown', currentPullback, 'abs');

    const ctx = canvas.getContext('2d');
    if (_miniChart) {
        try {
            _miniChart.destroy();
        } catch (_) {}
        _miniChart = null;
    }

    const chartTheme = getEquityChartTheme();
    const profit = chartTheme.profit;
    const muted = chartTheme.muted;
    const grid = chartTheme.grid;
    const lineColor = profit;
    const dayloss = getMonthDayloss(year, monthIndex);
    const minCurve = Math.min(...cumSeries, 0);
    const maxCurve = Math.max(...cumSeries, 0);
    const pointColors = cumSeries.map((value) => valueGradientColor(value, minCurve, maxCurve, chartTheme));
    canvas.$equityPointColors = pointColors;
    canvas.$equityPullbacks = pullbackSeries;
    canvas.$equityDayloss = dayloss;
    canvas.$equityBaseColor = lineColor;
    canvas.$equityChartTheme = chartTheme;

    if (!cumSeries.length) {
        canvas.parentElement?.classList.add('dash-mini-equity-empty');
    } else {
        canvas.parentElement?.classList.remove('dash-mini-equity-empty');
    }

    const drawdownMetric = document.getElementById('dash-equity-drawdown');
    if (drawdownMetric) {
        const daylossAbs = Math.abs(dayloss);
        drawdownMetric.classList.toggle('is-warn', currentPullback <= -(daylossAbs / 2) && currentPullback > -daylossAbs);
        drawdownMetric.classList.toggle('is-danger', currentPullback <= -daylossAbs);
    }

    _miniChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Glow',
                    role: 'equity-glow',
                    data: cumSeries,
                    borderColor: (context) => {
                        const area = context.chart.chartArea;
                        if (!area) return colorWithAlpha(lineColor, 0.18);
                        return buildValueGradient(context.chart.ctx, area, cumSeries, chartTheme.isLight ? 0.14 : 0.18, chartTheme);
                    },
                    fill: false,
                    tension: 0.4,
                    borderWidth: 6,
                    cubicInterpolationMode: 'monotone',
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    pointHitRadius: 0,
                    borderCapStyle: 'round',
                    borderJoinStyle: 'round',
                    order: 2,
                },
                {
                    label: 'Σ PnL',
                    role: 'equity-main',
                    data: cumSeries,
                    borderColor: (context) => {
                        const area = context.chart.chartArea;
                        if (!area) return lineColor;
                        return buildValueGradient(context.chart.ctx, area, cumSeries, 1, chartTheme);
                    },
                    backgroundColor: (context) => {
                        const area = context.chart.chartArea;
                        if (!area) return colorWithAlpha(lineColor, 0.12);
                        return buildValueGradient(context.chart.ctx, area, cumSeries, chartTheme.isLight ? 0.1 : 0.18, chartTheme);
                    },
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    cubicInterpolationMode: 'monotone',
                    pointRadius: 0,
                    pointHoverRadius: 7,
                    pointHitRadius: 16,
                    pointBorderWidth: 2,
                    pointBorderColor: getCssVar('--bg-panel', '#111827'),
                    pointBackgroundColor: (context) => pointColors[context.dataIndex] || lineColor,
                    borderCapStyle: 'round',
                    borderJoinStyle: 'round',
                    order: 1,
                },
            ],
        },
        plugins: [equityZeroLinePlugin, equityLastPointPlugin, equityValueLabelsPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 950,
                easing: 'easeOutQuart',
            },
            layout: {
                padding: { top: 24, right: 18, bottom: 4, left: 8 },
            },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    displayColors: false,
                    padding: 12,
                    backgroundColor: getCssVar('--bg-panel', '#111827'),
                    borderColor: grid,
                    borderWidth: 1,
                    titleColor: getCssVar('--text-main', '#f8fafc'),
                    bodyColor: muted,
                    filter: (item) => item.dataset.role === 'equity-main',
                    callbacks: {
                        title: (items) => {
                            const i = items[0]?.dataIndex;
                            if (i == null || !seriesDays[i]) return '';
                            return seriesDays[i];
                        },
                        label: (item) => {
                            const i = item.dataIndex;
                            return `Крива: ${formatMoney(cumSeries[i])}`;
                        },
                        afterLabel: (item) => {
                            const i = item.dataIndex;
                            return [
                                `День: ${formatMoney(dailySeries[i])}`,
                                `Відкат: $${Math.abs(pullbackSeries[i] || 0).toFixed(2)} / $${Math.abs(dayloss).toFixed(2)}`,
                            ];
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: {
                        maxRotation: 0,
                        color: muted,
                        font: { size: 10, family: "'DM Mono', monospace" },
                        padding: 8,
                    },
                    grid: { display: false },
                    border: { display: false },
                },
                y: {
                    beginAtZero: false,
                    ticks: {
                        color: muted,
                        font: { size: 10, family: "'DM Mono', monospace" },
                        padding: 8,
                        callback: (value) => `$${value}`,
                    },
                    grid: {
                        color: (context) => Number(context.tick.value) === 0
                            ? colorWithAlpha(lineColor, 0.75)
                            : grid,
                        lineWidth: (context) => Number(context.tick.value) === 0 ? 1.6 : 1,
                        drawTicks: false,
                    },
                    border: { display: false },
                },
            },
        },
    });
}
