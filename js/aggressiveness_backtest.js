import { fetchWithSession } from './authenticated_fetch.js';

function cell(text, tag = 'td') {
    const node = document.createElement(tag);
    node.textContent = text == null || text === '' ? '—' : String(text);
    return node;
}

function number(value, digits = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    return numeric.toFixed(digits);
}

function percent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    return `${(numeric * 100).toFixed(1)}%`;
}

function table(headers, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'aggressiveness-backtest-scroll';
    const grid = document.createElement('table');
    const head = document.createElement('tr');
    headers.forEach((header) => head.append(cell(header, 'th')));
    grid.append(head);
    rows.forEach((row) => {
        const line = document.createElement('tr');
        row.forEach((value) => line.append(cell(value)));
        grid.append(line);
    });
    wrap.append(grid);
    return wrap;
}

function summaryRow(item) {
    return [
        item.id || item.label,
        item.days ?? '—',
        item.trades ?? '—',
        number(item.totalR),
        number(item.rPerTrade, 3),
        number(item.medianRPerTrade, 3),
        percent(item.positiveDayPct),
        percent(item.winRate),
        number(item.avgWinner, 3),
        number(item.avgLoser, 3),
    ];
}

const SUMMARY_HEADERS = ['Бакет', 'Дні', 'Угоди', 'Total R', 'R / trade', 'Median R', 'Positive days', 'Win rate', 'Avg winner', 'Avg loser'];

export async function renderAggressivenessBacktest() {
    const host = document.getElementById('aggressiveness-backtest');
    if (!host || host.dataset.loading === '1') return;
    host.hidden = false;
    host.dataset.loading = '1';
    host.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'Aggressiveness backtest';
    const lead = document.createElement('p');
    lead.className = 'admin-lead';
    lead.textContent = 'Score сесії D рахується тільки зі стану ринку на close D-1. Mechanical R цього дня є ціллю перевірки, не входом. Walk-forward тримає місяць поза калібруванням.';
    host.append(title, lead);
    try {
        const response = await fetchWithSession('/api/aggressiveness?view=backtest&from=2026-01-02');
        const report = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(report.message || `Backtest ${response.status}`);
        const version = document.createElement('p');
        version.textContent = `score_version ${report.scoreVersion ?? '—'} · днів ${report.days ?? 0}${report.breadthUnavailable ? ' · breadth data incomplete' : ''}`;
        host.append(version);
        host.append(table(SUMMARY_HEADERS, (report.buckets || []).map(summaryRow)));
        const tails = document.createElement('p');
        const top = report.tails?.top || {};
        const bottom = report.tails?.bottom || {};
        tails.textContent = `Top 20% (${report.tails?.count ?? '—'} днів): R/trade ${number(top.rPerTrade, 3)}, median ${number(top.medianRPerTrade, 3)}, positive ${percent(top.positiveDayPct)}, n=${top.trades ?? '—'}. Bottom 20%: R/trade ${number(bottom.rPerTrade, 3)}, median ${number(bottom.medianRPerTrade, 3)}, positive ${percent(bottom.positiveDayPct)}, n=${bottom.trades ?? '—'}.`;
        host.append(tails);
        const walkTitle = document.createElement('h4');
        walkTitle.textContent = 'Expanding walk-forward, місяць заморожений до тесту';
        host.append(walkTitle, table(
            ['Місяць', 'Дні', 'Угоди', 'Total R', 'R / trade', 'Median R', 'Positive days', 'Win rate', '—', '—'],
            (report.walkForward?.folds || []).map(summaryRow),
        ));
        const looTitle = document.createElement('h4');
        looTitle.textContent = 'Leave-one-month-out, без майбутніх місяців';
        host.append(looTitle, table(
            ['Місяць', 'Дні', 'Угоди', 'Total R', 'R / trade', 'Median R', 'Positive days', 'Win rate', '—', '—'],
            (report.leaveOneMonthOut?.folds || []).map(summaryRow),
        ));
        const featureTitle = document.createElement('h4');
        featureTitle.textContent = 'Feature diagnostics';
        const featureRows = (report.featureDiagnostics || []).map((feature) => {
            const quintileText = (feature.quintiles || []).map((bucket) => (
                `${bucket.id} n=${bucket.sample} ${number(bucket.avgR, 2)}`
            )).join(' | ');
            return [
                feature.label,
                number(feature.correlation, 2),
                number(feature.spearman, 2),
                quintileText,
            ];
        });
        host.append(featureTitle, table(['Feature', 'Corr', 'Spearman', 'Quintile avg R/trade'], featureRows));
        const dayTitle = document.createElement('h4');
        dayTitle.textContent = 'Сесії';
        host.append(dayTitle, table(
            ['Дата', 'Close', 'Score', 'Rule', 'Analog', 'Small', 'Breadth', 'Spec', 'Broad', 'Macro', 'Entries', 'Total R', 'R/trade'],
            (report.sessions || []).map((day) => [
                day.date,
                day.previousMarketDate,
                day.aggressivenessScore,
                number(day.ruleScore, 0),
                number(day.analogScore, 0),
                number(day.smallMicroScore, 0),
                number(day.breadthScore, 0),
                number(day.speculativeScore, 0),
                number(day.broadMarketScore, 0),
                number(day.macroScore, 0),
                day.mechanicalEntries ?? '—',
                number(day.mechanicalTotalR, 2),
                number(day.mechanicalRPerTrade, 3),
            ]),
        ));
        const note = document.createElement('p');
        note.textContent = report.note || '';
        host.append(note);
        if (location.pathname.toLowerCase().includes('aggressiveness-backtest')) {
            host.scrollIntoView({ block: 'start' });
        }
    } catch (error) {
        const message = document.createElement('p');
        message.className = 'admin-error';
        message.textContent = error.message || 'Data incomplete';
        host.append(message);
    } finally {
        host.dataset.loading = '';
    }
}
