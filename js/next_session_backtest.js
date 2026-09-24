import { fetchWithSession } from './authenticated_fetch.js';
import { NEXT_SESSION_UI_ENABLED } from './next_session_aggressiveness.js';

function cell(text, tag = 'td') {
    const node = document.createElement(tag);
    node.textContent = text == null || text === '' ? '—' : String(text);
    return node;
}

function number(value, digits = 2) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
}

function percent(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '—';
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

function bucketRow(item) {
    return [
        item.id,
        item.days ?? '—',
        item.uniqueTickers ?? '—',
        percent(item.dumpBreadth),
        number(item.medianTickerR),
        number(item.meanTickerR),
        percent(item.rate1),
        percent(item.rate2),
        percent(item.rate3),
        percent(item.positiveDayPct),
    ];
}

export async function renderNextSessionBacktest() {
    if (!NEXT_SESSION_UI_ENABLED) return;
    const host = document.getElementById('next-session-backtest');
    if (!host) return;
    host.hidden = false;
    host.replaceChildren();
    const title = document.createElement('h4');
    title.textContent = 'Прогноз наступної сесії';
    const lead = document.createElement('p');
    lead.textContent = 'Кожен рядок — це прогноз, зроблений на закритті дня D, проти механічного short edge дня D+1. Ваги не підганяються щодня.';
    host.append(title, lead);
    try {
        const response = await fetchWithSession('/api/aggressiveness?view=next-backtest');
        const report = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = document.createElement('p');
            error.textContent = report.message || 'Не вдалося порахувати перевірку.';
            host.append(error);
            return;
        }
        if (!report.days) {
            const empty = document.createElement('p');
            empty.textContent = 'Ще немає пар «прогноз D → механічний результат D+1». Ринок сам по собі цю таблицю не заповнює.';
            host.append(empty);
            return;
        }
        host.append(table(
            ['Бакет', 'Дні', 'Тікери', 'Breadth', 'Median R', 'Mean R', '≥1R', '≥2R', '≥3R', 'Плюсові дні'],
            [...(report.buckets || []), report.tails?.bottom20, report.tails?.top20].filter(Boolean).map(bucketRow),
        ));
        const walkTitle = document.createElement('h4');
        walkTitle.textContent = 'Walk-forward по місяцях';
        host.append(walkTitle, table(
            ['Місяць', 'Дні', 'Середній прогноз', 'Середній edge D+1', 'Out of sample'],
            (report.walkForward || []).map((row) => [
                row.month,
                row.days,
                number(row.meanPrediction, 1),
                number(row.meanActual, 1),
                row.outOfSample ? 'так' : 'ні',
            ]),
        ));
        const lagTitle = document.createElement('h4');
        lagTitle.textContent = 'Лаги ознак';
        host.append(lagTitle, table(
            ['Ознака', 'N', 'D+1', 'D+2', 'D+3', 'D+5', 'Низ 20% edge', 'Верх 20% edge'],
            (report.lags || []).map((row) => [
                row.feature,
                row.sample ?? '—',
                number(row.spearmanD1, 2),
                number(row.spearmanD2, 2),
                number(row.spearmanD3, 2),
                number(row.spearmanD5, 2),
                number(row.bottomQuintileD1, 1),
                number(row.topQuintileD1, 1),
            ]),
        ));
    } catch {
        const error = document.createElement('p');
        error.textContent = 'Не вдалося порахувати перевірку.';
        host.append(error);
    }
}
