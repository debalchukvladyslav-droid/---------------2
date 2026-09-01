import { parseSheetGridToTrades } from './sheet_sync_core.js';

const get = (host, id) => host.querySelector(`[data-test-sheet="${id}"]`);

function columnLetter(index) {
    let value = index + 1;
    let result = '';
    while (value > 0) {
        value -= 1;
        result = String.fromCharCode(65 + (value % 26)) + result;
        value = Math.floor(value / 26);
    }
    return result;
}

function fillColumnSelects(host, rows) {
    const width = Math.max(0, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
    host.querySelectorAll('[data-test-sheet-column]').forEach((select) => {
        const previous = select.value;
        select.replaceChildren(new Option('Оберіть колонку', ''));
        for (let index = 0; index < width; index += 1) {
            const samples = rows.slice(0, 8).map((row) => String(row?.[index] ?? '').trim()).filter(Boolean).slice(0, 2);
            const letter = columnLetter(index);
            select.append(new Option(`${letter}${samples.length ? ` — ${samples.join(' / ')}` : ''}`, letter));
        }
        if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    });
}

function flatten(outByDay = {}) {
    return Object.keys(outByDay).sort().flatMap((date) => (outByDay[date] || []).map((trade) => ({
        date,
        row: trade?.sheet?.sheetRow ?? '',
        ticker: trade?.symbol || '',
        consolidation: trade?.sheet?.consolidateCents || '',
        entry: trade?.sheet?.entryPrice ?? trade?.entry ?? '',
    })));
}

function render(host, rows) {
    const output = get(host, 'output');
    output.replaceChildren();
    get(host, 'summary').textContent = rows.length
        ? `Знайдено угод: ${rows.length}. Дані лише показані — нічого не імпортовано.`
        : 'Угод не знайдено. Перевірте колонки та стартовий рядок.';
    if (!rows.length) return;
    const table = document.createElement('table');
    table.className = 'sheet-rows-table';
    const head = table.createTHead().insertRow();
    ['ДАТА', 'Рядок', 'ТІКЕР', 'Консолідація в цц', 'Точка входу'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        head.append(th);
    });
    const body = table.createTBody();
    rows.forEach((item) => {
        const row = body.insertRow();
        [item.date, item.row, item.ticker, item.consolidation, item.entry].forEach((value) => {
            const cell = row.insertCell();
            cell.textContent = value === '' || value == null ? '—' : String(value);
        });
    });
    output.append(table);
}

export function initIsolatedSheetTest(host) {
    if (!host || host.dataset.ready === 'true') return;
    host.dataset.ready = 'true';
    let spreadsheetId = '';
    let values = [];
    host.innerHTML = `
        <div class="admin-service-bots-head"><div><span class="admin-section-subtitle">Ізольований інструмент</span><h4 class="admin-section-title">Тест імпорту таблиці</h4></div><span class="admin-polygon-state is-active">Без збереження</span></div>
        <p class="admin-section-subtitle">Вставте Google Sheets link або spreadsheet ID. Таблиця читається лише після натискання кнопки й не змінює дані сайту.</p>
        <div class="testing-sheet-source">
            <input class="sheet-service-input" type="text" data-test-sheet="source" placeholder="Google Sheets link або spreadsheet ID">
            <button type="button" class="btn-admin-action" data-test-sheet="load">Завантажити таблицю</button>
            <label><span>Лист</span><select data-test-sheet="tab" disabled><option value="">Спочатку завантажте таблицю</option></select></label>
        </div>
        <p class="admin-polygon-result" data-test-sheet="status">Таблиця ще не завантажена.</p>
        <div class="testing-sheet-mapping">
            <label><span>ДАТА</span><select data-test-sheet-column data-test-sheet="date" disabled></select></label>
            <label><span>ТІКЕР</span><select data-test-sheet-column data-test-sheet="ticker" disabled></select></label>
            <label><span>Консолідація в цц</span><select data-test-sheet-column data-test-sheet="consolidation" disabled></select></label>
            <label><span>Точка входу</span><select data-test-sheet-column data-test-sheet="entry" disabled></select></label>
            <label><span>Стартовий рядок</span><input type="number" min="1" value="6" data-test-sheet="start-row"></label>
            <button type="button" class="btn-admin-action" data-test-sheet="run" disabled>Запустити тест</button>
        </div>
        <p class="admin-polygon-result" data-test-sheet="summary">Результат з’явиться нижче.</p>
        <div class="sheet-rows-list testing-sheet-output" data-test-sheet="output"></div>`;

    const status = get(host, 'status');
    const tab = get(host, 'tab');
    const loadValues = async () => {
        const connector = await import('./google_sheet_connector.js');
        status.textContent = 'Читаємо вибраний лист…';
        values = await connector.fetchSpreadsheetValuesRange(spreadsheetId, 'A1:ZZ', tab.value);
        fillColumnSelects(host, values);
        host.querySelectorAll('[data-test-sheet-column]').forEach((select) => { select.disabled = false; });
        get(host, 'run').disabled = false;
        status.textContent = `Лист «${tab.value}» завантажено: ${values.length} рядків. Оберіть колонки.`;
    };
    get(host, 'load').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const connector = await import('./google_sheet_connector.js');
            spreadsheetId = connector.extractSpreadsheetId(get(host, 'source').value);
            if (!spreadsheetId) throw new Error('Введіть коректний Google Sheets link або spreadsheet ID.');
            status.textContent = 'Завантажуємо список листів…';
            const metadata = await connector.fetchSpreadsheetMetadata(spreadsheetId);
            tab.replaceChildren();
            (metadata.sheets || []).forEach((sheet) => tab.append(new Option(sheet.title, sheet.title)));
            if (!tab.options.length) throw new Error('У таблиці не знайдено листів.');
            tab.disabled = false;
            await loadValues();
        } catch (error) {
            status.textContent = `Помилка: ${error?.message || error}`;
        } finally {
            button.disabled = false;
        }
    });
    tab.addEventListener('change', () => loadValues().catch((error) => { status.textContent = `Помилка: ${error?.message || error}`; }));
    get(host, 'run').addEventListener('click', () => {
        const date = get(host, 'date').value;
        const symbol = get(host, 'ticker').value;
        if (!date || !symbol) {
            status.textContent = 'Оберіть обов’язкові колонки ДАТА і ТІКЕР.';
            return;
        }
        const startRow = Math.max(1, Number(get(host, 'start-row').value) || 6);
        const sliced = values.slice(startRow - 1);
        if (Array.isArray(values.hyperlinks)) sliced.hyperlinks = values.hyperlinks.slice(startRow - 1);
        const parsed = parseSheetGridToTrades(sliced, {
            date,
            symbol,
            consolidateCents: get(host, 'consolidation').value,
            entryPrice: get(host, 'entry').value,
        }, spreadsheetId, startRow);
        render(host, flatten(parsed.outByDay));
    });
}
