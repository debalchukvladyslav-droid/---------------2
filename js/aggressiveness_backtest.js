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
        percent(item.winRate),
        number(item.avgWinner, 3),
        number(item.avgLoser, 3),
        percent(item.positiveDayPct),
    ];
}

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
    lead.textContent = 'Рахунок дня використовує лише попереднє закриття. Ціль — mechanical R на угоду, не денний PnL журналу.';
    host.append(title, lead);
    try {
        const response = await fetchWithSession('/api/aggressiveness?view=backtest');
        const report = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(report.message || `Backtest ${response.status}`);
        const headers = ['Бакет', 'Дні', 'Угоди', 'Total R', 'R / trade', 'Win rate', 'Avg winner', 'Avg loser', 'Positive days'];
        host.append(table(headers, (report.buckets || []).map(summaryRow)));
        const tails = document.createElement('p');
        const top = report.tails?.top?.rPerTrade;
        const bottom = report.tails?.bottom?.rPerTrade;
        tails.textContent = `Top 20% R/trade: ${number(top, 3)} · Bottom 20% R/trade: ${number(bottom, 3)} · spread ${number(report.tails?.rPerTradeSpread, 3)}`;
        host.append(tails);
        const walkTitle = document.createElement('h4');
        walkTitle.textContent = 'Expanding walk-forward (out of sample)';
        host.append(walkTitle, table(
            ['Місяць', 'Дні', 'Угоди', 'Total R', 'R / trade', 'Win rate', '—', '—', 'Positive days'],
            (report.walkForward?.folds || []).map(summaryRow),
        ));
        const looTitle = document.createElement('h4');
        looTitle.textContent = 'Leave-one-month-out';
        host.append(looTitle, table(
            ['Місяць', 'Дні', 'Угоди', 'Total R', 'R / trade', 'Win rate', '—', '—', 'Positive days'],
            (report.leaveOneMonthOut?.folds || []).slice(-8).map(summaryRow),
        ));
        const reviews = document.createElement('p');
        reviews.textContent = (report.featureReviews || []).map((item) => (
            `${item.label}: ${item.stable ? 'стабільна' : 'нестабільна'}, вага не змінюється`
        )).join(' · ') || 'Немає достатньої механічної вибірки для перегляду ваг.';
        const note = document.createElement('p');
        note.textContent = report.note || 'System Health не входить у Aggressiveness.';
        host.append(reviews, note);
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
