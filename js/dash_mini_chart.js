// === Міні-крива кумулятивного PnL на дашборді (поточний місяць) ===
import { state } from './state.js';

let _miniChart = null;

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
    const seriesDays = [];
    let cum = 0;
    days.forEach((d) => {
        const pnl = parseFloat(journal[d]?.pnl);
        if (!Number.isFinite(pnl)) return;
        cum += pnl;
        labels.push(d.slice(8));
        seriesDays.push(d);
        cumSeries.push(parseFloat(cum.toFixed(2)));
    });

    const ctx = canvas.getContext('2d');
    if (_miniChart) {
        try {
            _miniChart.destroy();
        } catch (_) {}
        _miniChart = null;
    }

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00e5a0';
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#64748b';

    _miniChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Σ PnL',
                    data: cumSeries,
                    borderColor: accent,
                    backgroundColor: 'rgba(0, 229, 160, 0.08)',
                    fill: true,
                    tension: 0.25,
                    pointRadius: labels.length > 20 ? 0 : 3,
                    pointHoverRadius: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => {
                            const i = items[0]?.dataIndex;
                            if (i == null || !seriesDays[i]) return '';
                            return seriesDays[i];
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: { maxRotation: 0, color: muted, font: { size: 10 } },
                    grid: { display: false },
                    border: { display: false },
                },
                y: {
                    ticks: { color: muted, font: { size: 10 } },
                    grid: { display: false },
                    border: { display: false },
                },
            },
        },
    });
}
