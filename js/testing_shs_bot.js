import { fetchWithSession } from './authenticated_fetch.js';
import { buildShsDayMap, newYorkStamp, normalizeShsTicker } from './shs_trades_core.js';

const MAX_DAYS = 31;
const CHUNK_DAYS = 7;
const get = (host, id) => host.querySelector(`[data-shs="${id}"]`);

function localIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDays(dateStr, delta) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, (d || 1) + delta);
    return localIso(dt);
}

function inclusiveDays(start, end) {
    const a = Date.parse(`${start}T00:00:00`);
    const b = Date.parse(`${end}T00:00:00`);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return Math.floor((b - a) / 86400000) + 1;
}

function chunks(start, end) {
    const ranges = [];
    let cursor = start;
    while (cursor <= end) {
        const chunkEnd = addDays(cursor, CHUNK_DAYS - 1);
        ranges.push({ start: cursor, end: chunkEnd < end ? chunkEnd : end });
        cursor = addDays(chunkEnd, 1);
    }
    return ranges;
}

function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount.toFixed(2) : '—';
}

function plainNumber(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? String(amount) : '—';
}

function effectLabel(value) {
    const effect = String(value || '').toLowerCase();
    if (/close|cover|flatten|exit/.test(effect)) return 'Вихід';
    if (/reduce/.test(effect)) return 'Частковий вихід';
    if (/open/.test(effect)) return 'Вхід';
    return value ? String(value) : '—';
}

function stampOf(row) {
    return newYorkStamp(row?.first_fill_at || row?.last_fill_at || row?.submitted_at || row?.created_at || row?.date);
}

function textCell(row, value) {
    const cell = row.insertCell();
    cell.textContent = value === '' || value == null ? '—' : String(value);
}

function keysOf(items) {
    const keys = [];
    const seen = new Set();
    items.slice(0, 40).forEach((row) => {
        if (!row || typeof row !== 'object') return;
        Object.keys(row).forEach((key) => {
            if (seen.has(key)) return;
            seen.add(key);
            keys.push(key);
        });
    });
    return keys;
}

function fillTable(host, id, headers, rows, cells) {
    const output = get(host, id);
    output.replaceChildren();
    if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'sheet-rows-list__empty';
        empty.textContent = 'Немає рядків за цей період.';
        output.append(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'sheet-rows-table';
    const head = table.createTHead().insertRow();
    headers.forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        head.append(th);
    });
    const body = table.createTBody();
    rows.forEach((item) => {
        const row = body.insertRow();
        cells(item).forEach((value) => textCell(row, value));
    });
    output.append(table);
}

function renderResult(host, nick, payload) {
    const orders = [...(payload.orders || [])].sort((a, b) => (stampOf(a)?.epoch || 0) - (stampOf(b)?.epoch || 0));
    const locates = [...(payload.locates || [])].sort((a, b) => String(a?.created_at || a?.date || '').localeCompare(String(b?.created_at || b?.date || '')));
    const anchor = orders.find((row) => row?.login_name)?.login_name || nick;
    const dayMap = buildShsDayMap(orders, locates, anchor);
    const dates = Object.keys(dayMap).sort();
    const trades = dates.flatMap((date) => (dayMap[date].trades || []).map((trade) => ({ date, ...trade })));
    const coverage = payload.coverage || {};
    const expectedOrders = Number(coverage.expectedOrders) || orders.length;
    const expectedLocates = Number(coverage.expectedLocates) || locates.length;
    const shortDays = Array.isArray(coverage.shortDays) ? coverage.shortDays : [];
    get(host, 'summary').textContent = [
        `Акаунт ${nick}.`,
        `Ордерів: ${orders.length}${expectedOrders > orders.length ? ` з ${expectedOrders} у боті` : ''}.`,
        `Локатів: ${locates.length}${expectedLocates > locates.length ? ` з ${expectedLocates} у боті` : ''}.`,
        `Зібраних позицій: ${trades.length}.`,
        shortDays.length
            ? `За ${shortDays.join(', ')} бот віддав лише останні 200 ордерів усього столу. Фільтр по акаунту і сторінки він не приймає, тож старіші ордери цього дня не приходять.`
            : 'За цей період ліміт стрічки вмістив усі ордери столу.',
        'Журнал не змінено.',
    ].filter(Boolean).join(' ');

    fillTable(
        host,
        'orders',
        ['Дата', 'Час NY', 'Тікер', 'Дія', 'Ефект', 'Сторона', 'Статус', 'Заявлено', 'Виконано', 'Ціна', 'Тип', 'Угода', 'Демо', 'Логін', 'Нік', 'Закрито NY'],
        orders,
        (order) => {
            const stamp = stampOf(order);
            const closed = newYorkStamp(order.closed_at);
            return [
                stamp?.date || '—',
                stamp?.time || '—',
                normalizeShsTicker(order.ticker) || order.ticker || '—',
                effectLabel(order.position_effect),
                order.position_effect || '—',
                order.side || '—',
                order.status || '—',
                plainNumber(order.size),
                plainNumber(order.filled_size),
                plainNumber(order.avg_filled_price),
                order.order_type || '—',
                order.trade_type || '—',
                order.is_demo ? 'так' : 'ні',
                order.login_name || '—',
                order.account_nickname || '—',
                closed?.time || '—',
            ];
        },
    );
    fillTable(
        host,
        'locates',
        ['Дата', 'Час', 'Тікер', 'Статус', 'Розмір', 'Ціна', 'Бот', 'Трейдер', 'Користувач'],
        locates,
        (row) => {
            const stamp = newYorkStamp(row.created_at);
            return [
                String(row.date || stamp?.date || '').slice(0, 10) || '—',
                stamp?.time || '—',
                normalizeShsTicker(row.ticker) || row.ticker || '—',
                row.status || '—',
                plainNumber(row.size),
                plainNumber(row.price),
                row.bot_nickname || '—',
                row.trader || '—',
                row.real_user || '—',
            ];
        },
    );
    fillTable(
        host,
        'days',
        ['Дата', 'Угод', 'Gross', 'Локати', 'Тікери'],
        dates.map((date) => dayMap[date] && { date, ...dayMap[date] }),
        (day) => [day.date, (day.trades || []).length, money(day.gross), money(day.locates), (day.tickers || []).join(', ')],
    );
    fillTable(
        host,
        'trades',
        ['Дата', 'Тікер', 'Сторона', 'Відкрито', 'Закрито', 'К-сть', 'Вхід', 'Вихід', 'Gross'],
        trades,
        (trade) => [trade.date, trade.symbol, trade.type, trade.opened, trade.closed, trade.qty, trade.entry, trade.exit, money(trade.gross)],
    );

    const orderKeys = keysOf(orders);
    const locateKeys = keysOf(locates);
    get(host, 'fields').textContent = [
        orderKeys.length ? `Поля ордера: ${orderKeys.join(', ')}.` : 'Ордерів у відповіді немає.',
        locateKeys.length ? `Поля локата: ${locateKeys.join(', ')}.` : 'Локатів у відповіді немає.',
    ].join(' ');
    const sample = {
        orders: orders.slice(0, 2),
        locates: locates.slice(0, 2),
    };
    get(host, 'raw').textContent = orders.length || locates.length
        ? JSON.stringify(sample, null, 2)
        : 'Бот не повернув рядків для цього акаунта і періоду.';
}

async function loadRange(nick, start, end) {
    const orders = [];
    const locates = [];
    const coverage = {
        expectedOrders: 0,
        receivedOrders: 0,
        expectedLocates: 0,
        receivedLocates: 0,
        shortDays: [],
    };
    let truncated = false;
    for (const range of chunks(start, end)) {
        const url = `/api/shs-trades?mode=data&trader=${encodeURIComponent(nick)}&start=${range.start}&end=${range.end}`;
        const response = await fetchWithSession(url);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || 'Не вдалося забрати угоди');
        orders.push(...(body.orders || []));
        locates.push(...(body.locates || []));
        const part = body.coverage || {};
        coverage.expectedOrders += Number(part.expectedOrders) || 0;
        coverage.receivedOrders += Number(part.receivedOrders) || 0;
        coverage.expectedLocates += Number(part.expectedLocates) || 0;
        coverage.receivedLocates += Number(part.receivedLocates) || 0;
        if (Array.isArray(part.shortDays)) coverage.shortDays.push(...part.shortDays);
        if (body.truncated) truncated = true;
    }
    return { orders, locates, truncated, coverage };
}

export function initShsBotTest(host) {
    if (!host || host.dataset.ready === 'true') return;
    host.dataset.ready = 'true';
    const end = localIso(new Date());
    const start = addDays(end, -6);
    host.innerHTML = `
        <div class="admin-service-bots-head">
            <div>
                <span class="admin-section-subtitle">Ізольований інструмент</span>
                <h4 class="admin-section-title">Бот угод</h4>
            </div>
            <span class="admin-polygon-state is-active">Без запису в журнал</span>
        </div>
        <p class="admin-section-subtitle">Оберіть акаунт і період. Нижче кожен ордер входу і виходу, час у Нью-Йорку, локати і зібрана позиція. Бот за один день віддає лише останні 200 ордерів усього столу.</p>
        <div class="testing-sheet-mapping">
            <label>
                <span>Акаунт</span>
                <select data-shs="account" aria-label="Акаунт у боті">
                    <option value="">Завантажую список…</option>
                </select>
            </label>
            <label>
                <span>Від</span>
                <input type="date" data-shs="start" value="${start}">
            </label>
            <label>
                <span>До</span>
                <input type="date" data-shs="end" value="${end}">
            </label>
            <button type="button" class="btn-admin-action" data-shs="load" disabled>Показати дані</button>
        </div>
        <p class="admin-polygon-result" data-shs="status">Завантажую список акаунтів…</p>
        <p class="admin-polygon-result" data-shs="summary">Результат з’явиться після вибору акаунта і періоду.</p>
        <h5 class="shs-bot-block-title">Ордери</h5>
        <div class="sheet-rows-list shs-bot-rows" data-shs="orders"></div>
        <h5 class="shs-bot-block-title">Локати</h5>
        <div class="sheet-rows-list shs-bot-rows" data-shs="locates"></div>
        <h5 class="shs-bot-block-title">Дні</h5>
        <div class="sheet-rows-list" data-shs="days"></div>
        <h5 class="shs-bot-block-title">Зібрані входи</h5>
        <div class="sheet-rows-list" data-shs="trades"></div>
        <h5 class="shs-bot-block-title">Що повернув бот</h5>
        <p class="shs-trader-status" data-shs="fields">Поля відповіді з’являться після завантаження.</p>
        <pre class="shs-bot-raw" data-shs="raw"></pre>`;

    const status = get(host, 'status');
    const account = get(host, 'account');
    const button = get(host, 'load');

    const fillAccounts = (names) => {
        const previous = account.value;
        account.replaceChildren(new Option('Оберіть акаунт', ''));
        names.forEach((name) => account.append(new Option(name, name)));
        if (previous && [...account.options].some((option) => option.value === previous)) account.value = previous;
        button.disabled = !account.value;
    };

    fetchWithSession('/api/shs-trades?mode=traders')
        .then(async (response) => {
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.message || 'Список акаунтів не відкрився');
            const names = Array.isArray(body.traders) ? body.traders.filter(Boolean) : [];
            if (!names.length) throw new Error('Стрічка бота не повернула імена');
            fillAccounts(names);
            status.textContent = `Акаунтів у стрічці: ${names.length}. Оберіть кого дивитись і період до місяця.`;
        })
        .catch((error) => {
            account.replaceChildren(new Option('Список не відкрився', ''));
            status.textContent = `Помилка: ${error?.message || error}`;
        });

    account.addEventListener('change', () => {
        button.disabled = !account.value;
    });

    button.addEventListener('click', async () => {
        const nick = account.value.trim();
        const from = get(host, 'start').value;
        const to = get(host, 'end').value;
        const span = inclusiveDays(from, to);
        if (!nick) {
            status.textContent = 'Оберіть акаунт.';
            return;
        }
        if (!span) {
            status.textContent = 'Дата «до» має бути не раніше за «від».';
            return;
        }
        if (span > MAX_DAYS) {
            status.textContent = 'За один перегляд можна взяти не більше місяця.';
            return;
        }
        button.disabled = true;
        status.textContent = `Читаю ${nick}: ${from} — ${to}…`;
        try {
            const payload = await loadRange(nick, from, to);
            renderResult(host, nick, payload);
            status.textContent = `Готово: ${from} — ${to}.`;
        } catch (error) {
            status.textContent = `Помилка: ${error?.message || error}`;
        } finally {
            button.disabled = !account.value;
        }
    });
}
