import { state } from './state.js';
import { ensurePdfTools } from './vendor_loader.js';
import {
    REPORT_SECTION_DEFAULTS, buildAnalyticsReportData as buildReportData,
    makeAnalyticsPdfFilename, normalizeReportPeriod, reportPeriodLabel,
    validateAnalyticsExportConfig,
} from './analytics_report_core.js';

const STORAGE_KEY = 'tj_analytics_export_settings_v1';
const PRESET_KEY = 'tj_analytics_export_presets_v1';
const STEPS = ['Джерела', 'Періоди', 'Фільтри', 'Склад', 'Стиль', 'Готово'];
const SECTION_LABELS = {
    cover: 'Титульна сторінка', kpis: 'Основні KPI', equity: 'Крива дохідності',
    weekdays: 'PnL за днями тижня', hourly: 'Результат за часом входу',
    entryPrice: 'Результат за ціною входу', winLoss: 'Співвідношення днів',
    drawdown: 'Максимальна просадка', costs: 'Комісії та локейти',
    insights: 'Помилки та автоінсайти', tradeTypes: 'Аналіз типів угод',
    bestExit: 'Найкращий вихід', comparison: 'Порівняльна таблиця', trades: 'Таблиця угод',
};

let exportStep = 0;
let reportPeriods = [];
let logoDataUrl = '';
let logoImage = null;

function el(id) { return document.getElementById(id); }
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function money(value) {
    const number = Number(value) || 0;
    return `${number < 0 ? '−' : ''}$${Math.abs(number).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function currentIdentity() {
    const settings = state.appData?.settings || {};
    const name = [settings.first_name, settings.last_name].filter(Boolean).join(' ') || state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '';
    return { name, nick: state.CURRENT_VIEWED_USER || state.USER_DOC_NAME || '', team: settings.team || settings.team_name || '' };
}
function availableContexts() {
    const main = {
        id: 'main',
        label: state.currentStatsContext?.label || 'Поточний профіль',
        journal: state.currentStatsContext?.journal || state.appData?.journal || {},
    };
    const contexts = [main];
    const compareJournal = state.statsCompareContext?.journal || {};
    if (Object.keys(compareJournal).length) contexts.push({
        id: 'compare', label: state.statsCompareContext?.label || 'Порівняння', journal: compareJournal,
    });
    return contexts;
}
function defaultConfig() {
    return {
        sourceIds: ['main'],
        periods: [{ id: 'all', type: 'all', value: '', label: 'За весь час' }],
        tradeTypes: [],
        comparison: true,
        analysisMode: false,
        sections: { ...REPORT_SECTION_DEFAULTS },
        trades: { limit: 100, sort: 'date-desc', newPage: true },
        appearance: { theme: 'light', accent: '#2563eb', density: 'comfortable', title: 'Trading Analytics Report', footer: true, pageNumbers: true },
        identity: { name: false, nick: false, team: false, source: false },
    };
}
function storedConfig() {
    try { return { ...defaultConfig(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
    catch { return defaultConfig(); }
}

function renderProgress() {
    const root = el('analytics-export-progress');
    if (!root) return;
    root.innerHTML = STEPS.map((label, index) => `<button type="button" data-export-step-jump="${index}" data-number="${index + 1}" class="${index === exportStep ? 'active' : index < exportStep ? 'done' : ''}"><span>${label}</span></button>`).join('');
    root.querySelectorAll('[data-export-step-jump]').forEach((button) => button.addEventListener('click', () => setStep(Number(button.dataset.exportStepJump))));
}
function setStep(step) {
    exportStep = Math.max(0, Math.min(5, step));
    document.querySelectorAll('.analytics-export-step').forEach((section) => {
        section.hidden = Number(section.dataset.exportStep) !== exportStep;
    });
    renderProgress();
    el('analytics-export-prev').hidden = exportStep === 0;
    el('analytics-export-next').hidden = exportStep === 5;
    el('analytics-export-generate').hidden = exportStep !== 5;
    if (exportStep === 5) renderSummary();
}
function renderSources(config) {
    el('analytics-export-sources').innerHTML = availableContexts().map((context) =>
        `<label class="analytics-export-check"><input type="checkbox" data-export-source="${escapeHtml(context.id)}" ${config.sourceIds.includes(context.id) ? 'checked' : ''}><span>${escapeHtml(context.label)}</span></label>`
    ).join('');
    el('analytics-import-comparison').checked = config.sourceIds.includes('compare');
}
function renderTradeTypes(config) {
    const types = state.currentStatsContext?.tradeTypes || state.appData?.tradeTypes || [];
    el('analytics-export-trade-types').innerHTML = [
        `<label class="analytics-export-check"><input type="checkbox" data-export-type="" ${config.tradeTypes.length ? '' : 'checked'}><span>Усі типи</span></label>`,
        ...types.map((type) => `<label class="analytics-export-check"><input type="checkbox" data-export-type="${escapeHtml(type)}" ${config.tradeTypes.includes(type) ? 'checked' : ''}><span>${escapeHtml(type)}</span></label>`),
    ].join('');
}
function renderSections(config) {
    el('analytics-export-sections').innerHTML = Object.entries(SECTION_LABELS).map(([key, label]) =>
        `<label class="analytics-export-check"><input type="checkbox" data-export-section="${key}" ${config.sections[key] ? 'checked' : ''}><span>${label}</span></label>`
    ).join('');
}
function renderPeriods() {
    const root = el('analytics-period-list');
    root.innerHTML = reportPeriods.map((period, index) =>
        `<div class="analytics-period-chip"><span>${escapeHtml(reportPeriodLabel(period))}</span><button type="button" data-remove-period="${index}">Видалити</button></div>`
    ).join('') || '<p class="stats-empty-note">Ще немає вибраних проміжків.</p>';
    root.querySelectorAll('[data-remove-period]').forEach((button) => button.addEventListener('click', () => {
        reportPeriods.splice(Number(button.dataset.removePeriod), 1);
        renderPeriods();
    }));
}
function applyConfig(config) {
    reportPeriods = (config.periods || []).map(normalizeReportPeriod);
    renderSources(config);
    renderTradeTypes(config);
    renderSections(config);
    renderPeriods();
    el('analytics-export-comparison').checked = config.comparison !== false;
    el('analytics-export-analysis-mode').checked = !!config.analysisMode;
    el('analytics-trade-limit').value = config.trades?.limit || 100;
    el('analytics-trade-sort').value = config.trades?.sort || 'date-desc';
    el('analytics-trades-new-page').checked = config.trades?.newPage !== false;
    el('analytics-report-title').value = config.appearance?.title || 'Trading Analytics Report';
    el('analytics-report-accent').value = config.appearance?.accent || '#2563eb';
    el('analytics-report-density').value = config.appearance?.density || 'comfortable';
    el('analytics-report-footer').checked = config.appearance?.footer !== false;
    el('analytics-report-page-numbers').checked = config.appearance?.pageNumbers !== false;
    const theme = document.querySelector(`input[name="analytics-report-theme"][value="${config.appearance?.theme || 'light'}"]`);
    if (theme) theme.checked = true;
    document.querySelectorAll('[data-identity]').forEach((input) => { input.checked = !!config.identity?.[input.dataset.identity]; });
    el('analytics-trade-options').hidden = !config.sections?.trades;
}
function collectConfig() {
    const sourceIds = [...document.querySelectorAll('[data-export-source]:checked')].map((input) => input.dataset.exportSource);
    const selectedTypes = [...document.querySelectorAll('[data-export-type]:checked')].map((input) => input.dataset.exportType).filter(Boolean);
    const sections = {};
    document.querySelectorAll('[data-export-section]').forEach((input) => { sections[input.dataset.exportSection] = input.checked; });
    const identity = {};
    document.querySelectorAll('[data-identity]').forEach((input) => { identity[input.dataset.identity] = input.checked; });
    return {
        sourceIds: sourceIds.length ? sourceIds : ['main'],
        periods: reportPeriods,
        tradeTypes: selectedTypes,
        comparison: el('analytics-export-comparison').checked,
        analysisMode: el('analytics-export-analysis-mode').checked,
        sections,
        trades: { limit: Math.max(10, Math.min(1000, Number(el('analytics-trade-limit').value) || 100)), sort: el('analytics-trade-sort').value, newPage: el('analytics-trades-new-page').checked },
        appearance: {
            theme: document.querySelector('input[name="analytics-report-theme"]:checked')?.value || 'light',
            accent: el('analytics-report-accent').value,
            density: el('analytics-report-density').value,
            title: el('analytics-report-title').value.trim() || 'Trading Analytics Report',
            footer: el('analytics-report-footer').checked,
            pageNumbers: el('analytics-report-page-numbers').checked,
            logo: logoDataUrl,
        },
        identity,
    };
}
function renderSummary() {
    const config = collectConfig();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...config, appearance: { ...config.appearance, logo: '' } }));
    const contexts = availableContexts().filter((context) => config.sourceIds.includes(context.id));
    const estimate = Math.max(1, (config.sections.cover ? 1 : 0) + contexts.length * config.periods.length * 2 + (config.comparison && config.periods.length > 1 ? 1 : 0) + (config.sections.trades ? 1 : 0));
    const validation = validateAnalyticsExportConfig(config);
    el('analytics-export-summary').innerHTML = `
        <div class="analytics-summary-card"><strong>Джерела</strong><span>${contexts.map((item) => escapeHtml(item.label)).join(', ') || 'Поточний профіль'}</span></div>
        <div class="analytics-summary-card"><strong>Періоди</strong><span>${config.periods.map(reportPeriodLabel).map(escapeHtml).join(', ') || 'Не вибрано'}</span></div>
        <div class="analytics-summary-card"><strong>Розділи</strong><span>${Object.entries(config.sections).filter(([, enabled]) => enabled).map(([key]) => SECTION_LABELS[key]).join(', ')}</span></div>
        <div class="analytics-summary-card"><strong>Обсяг</strong><span>Орієнтовно ${estimate} стор.; A4 landscape; ${config.appearance.theme}</span></div>`;
    const status = el('analytics-export-status');
    status.classList.toggle('error', !validation.valid);
    status.textContent = validation.valid ? 'Конфігурація готова. PDF буде сформовано локально у вашому браузері.' : validation.errors.join(' ');
    el('analytics-export-generate').disabled = !validation.valid;
}

export function addAnalyticsReportPeriod() {
    const type = el('analytics-period-type').value;
    const value = el('analytics-period-value').value.trim();
    const from = el('analytics-period-from').value;
    const to = el('analytics-period-to').value;
    reportPeriods.push(normalizeReportPeriod({ id: `${type}-${Date.now()}`, type, value, from, to }));
    renderPeriods();
}
export function updateAnalyticsPeriodInputs() {
    const type = el('analytics-period-type').value;
    const custom = type === 'custom';
    const dated = type === 'week';
    el('analytics-period-from').hidden = !custom && !dated;
    el('analytics-period-to').hidden = !custom;
    el('analytics-period-value').hidden = custom || dated || type === 'all';
    el('analytics-period-value').placeholder = type === 'month' ? '2026-07' : '2026';
}
export function openAnalyticsExport() {
    const modal = el('analytics-export-modal');
    if (!modal) return;
    applyConfig(storedConfig());
    exportStep = 0;
    setStep(0);
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}
export function closeAnalyticsExport() {
    el('analytics-export-modal')?.classList.remove('open');
    el('analytics-export-modal')?.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
}
export function analyticsExportNext() {
    if (exportStep === 1) {
        const validation = validateAnalyticsExportConfig({ ...collectConfig(), sections: { cover: true } });
        if (!validation.valid && !reportPeriods.length) {
            el('analytics-export-status').textContent = validation.errors[0];
            return;
        }
    }
    setStep(exportStep + 1);
}
export function analyticsExportPrev() { setStep(exportStep - 1); }
export function resetAnalyticsExport() { localStorage.removeItem(STORAGE_KEY); applyConfig(defaultConfig()); setStep(0); }
export function saveAnalyticsExportPreset() {
    const name = window.prompt('Назва пресету');
    if (!name?.trim()) return;
    const presets = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');
    presets[name.trim()] = collectConfig();
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
}
export function loadAnalyticsExportPreset() {
    const presets = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');
    const names = Object.keys(presets);
    if (!names.length) { window.alert('Збережених пресетів ще немає.'); return; }
    const name = window.prompt(`Введіть назву пресету:\n${names.join('\n')}`, names[0]);
    if (name && presets[name]) applyConfig(presets[name]);
}

function palette(appearance) {
    if (appearance.theme === 'dark') return { bg: '#0d1220', card: '#171e2e', text: '#f2f5fb', muted: '#9ba8bd', accent: appearance.accent, line: '#2b3549', profit: '#21c98b', loss: '#ff657a' };
    if (appearance.theme === 'brand') return { bg: '#0b1020', card: '#142044', text: '#f4f7ff', muted: '#aab8dc', accent: appearance.accent, line: '#2b4484', profit: '#35d6a0', loss: '#ff7185' };
    return { bg: '#f4f7fb', card: '#ffffff', text: '#172033', muted: '#667085', accent: appearance.accent, line: '#d9e0eb', profit: '#11845f', loss: '#d63f55' };
}
function makePage(appearance) {
    const canvas = document.createElement('canvas');
    canvas.width = 1400; canvas.height = 990;
    const ctx = canvas.getContext('2d');
    const colors = palette(appearance);
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = 'top';
    return { canvas, ctx, colors };
}
function text(ctx, value, x, y, size, color, weight = 500, align = 'left') {
    ctx.fillStyle = color; ctx.font = `${weight} ${size}px "Inter", "Arial", sans-serif`; ctx.textAlign = align;
    ctx.fillText(String(value), x, y);
}
function card(ctx, colors, x, y, w, h) {
    ctx.fillStyle = colors.card; ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 16); ctx.fill(); ctx.stroke();
}
function lineChart(ctx, colors, rows, x, y, w, h) {
    card(ctx, colors, x, y, w, h);
    if (!rows.length) { text(ctx, 'Немає даних', x + w / 2, y + h / 2, 20, colors.muted, 500, 'center'); return; }
    const values = rows.map((row) => row.equity);
    const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
    ctx.strokeStyle = colors.line; ctx.beginPath(); ctx.moveTo(x + 28, y + h - 35); ctx.lineTo(x + w - 22, y + h - 35); ctx.stroke();
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.beginPath();
    rows.forEach((row, index) => {
        const px = x + 30 + index / Math.max(1, rows.length - 1) * (w - 55);
        const py = y + 28 + (max - row.equity) / span * (h - 68);
        if (!index) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
}
function addHeader(page, config, subtitle) {
    text(page.ctx, config.appearance.title, 70, 45, 26, page.colors.text, 750);
    text(page.ctx, subtitle, 70, 82, 15, page.colors.muted, 500);
    page.ctx.fillStyle = page.colors.accent; page.ctx.fillRect(70, 116, 1260, 4);
}
function addFooter(page, config, number) {
    if (!config.appearance.footer && !config.appearance.pageNumbers) return;
    page.ctx.strokeStyle = page.colors.line; page.ctx.beginPath(); page.ctx.moveTo(70, 940); page.ctx.lineTo(1330, 940); page.ctx.stroke();
    if (config.appearance.footer) text(page.ctx, `Створено ${new Date().toLocaleString('uk-UA')} · Trading Journal Pro`, 70, 954, 12, page.colors.muted);
    if (config.appearance.pageNumbers) text(page.ctx, number, 1330, 954, 12, page.colors.muted, 600, 'right');
}
function coverPage(config, identity, sourceLabel) {
    const page = makePage(config.appearance);
    page.ctx.fillStyle = page.colors.accent; page.ctx.fillRect(0, 0, 24, 990);
    text(page.ctx, 'TRADING JOURNAL PRO', 105, 120, 17, page.colors.accent, 800);
    text(page.ctx, config.appearance.title, 105, 185, 52, page.colors.text, 750);
    if (logoImage?.complete) {
        const ratio = Math.min(180 / logoImage.naturalWidth, 72 / logoImage.naturalHeight);
        page.ctx.drawImage(logoImage, 1110, 112, logoImage.naturalWidth * ratio, logoImage.naturalHeight * ratio);
    }
    text(page.ctx, config.periods.map(reportPeriodLabel).join('  •  '), 105, 265, 22, page.colors.muted);
    let y = 380;
    const rows = [];
    if (config.identity.name && identity.name) rows.push(['Ім’я', identity.name]);
    if (config.identity.nick && identity.nick) rows.push(['Нік', identity.nick]);
    if (config.identity.team && identity.team) rows.push(['Команда', identity.team]);
    if (config.identity.source && sourceLabel) rows.push(['Джерело', sourceLabel]);
    rows.forEach(([label, value]) => { text(page.ctx, label.toUpperCase(), 105, y, 12, page.colors.muted, 700); text(page.ctx, value, 105, y + 22, 20, page.colors.text, 600); y += 75; });
    text(page.ctx, new Date().toLocaleDateString('uk-UA'), 105, 875, 16, page.colors.muted);
    return page;
}
function periodPages(config, group, period) {
    const pages = [];
    if (config.sections.kpis || config.sections.equity || config.sections.drawdown || config.sections.costs) {
        const page = makePage(config.appearance);
        addHeader(page, config, `${group.label} · ${period.label}`);
        const kpis = [
        ['Загальний PnL', money(period.kpis.totalPnl)], ['Winrate', `${period.kpis.winRate.toFixed(1)}%`],
        ['Profit Factor', Number.isFinite(period.kpis.profitFactor) ? period.kpis.profitFactor.toFixed(2) : '∞'],
        ['Торгових днів', period.kpis.tradeDays], ['Макс. просадка', money(period.kpis.maxDrawdown)],
        ['Комісії + локейти', money(period.kpis.commissions + period.kpis.locates)],
    ];
        kpis.forEach(([label, value], index) => {
        const x = 70 + index % 3 * 420, y = 150 + Math.floor(index / 3) * 130;
        card(page.ctx, page.colors, x, y, 390, 105);
        text(page.ctx, label, x + 20, y + 18, 14, page.colors.muted, 650);
        const color = label === 'Загальний PnL' ? (period.kpis.totalPnl >= 0 ? page.colors.profit : page.colors.loss) : page.colors.text;
        text(page.ctx, value, x + 20, y + 48, 29, color, 750);
        });
        if (config.sections.equity) {
            text(page.ctx, 'Крива дохідності', 70, 430, 20, page.colors.text, 700);
            lineChart(page.ctx, page.colors, period.equity, 70, 470, 1260, 395);
        }
        pages.push(page);
    }

    if (config.sections.weekdays || config.sections.insights || config.sections.tradeTypes || config.sections.hourly || config.sections.entryPrice || config.sections.winLoss) {
        const details = makePage(config.appearance);
        addHeader(details, config, `${group.label} · деталізація · ${period.label}`);
        let lowerTitleY = 560;
        if (config.sections.weekdays) {
            text(details.ctx, 'PnL за днями тижня', 70, 155, 20, details.colors.text, 700);
            const dayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
            period.weekdays.forEach((value, index) => {
        const x = 70 + index * 250, h = Math.min(220, Math.abs(value) / Math.max(1, ...period.weekdays.map(Math.abs)) * 220);
        card(details.ctx, details.colors, x, 200, 210, 300);
        details.ctx.fillStyle = value >= 0 ? details.colors.profit : details.colors.loss;
        details.ctx.fillRect(x + 65, 455 - h, 80, h);
        text(details.ctx, dayLabels[index], x + 105, 465, 16, details.colors.muted, 700, 'center');
        text(details.ctx, money(value), x + 105, 220, 17, details.colors.text, 700, 'center');
            });
        } else {
            lowerTitleY = 155;
        }
        const list = config.sections.insights
            ? (period.errors.slice(0, 6).length ? period.errors.slice(0, 6) : [{ label: 'Немає позначених помилок', count: 0 }])
            : config.sections.tradeTypes
                ? period.tradeTypes.slice(0, 6).map((item) => ({ label: item.label, count: money(item.pnl) }))
                : config.sections.hourly
                    ? period.hourly.slice(0, 6).map((item) => ({ label: item.label, count: money(item.value) }))
                    : period.entryPrice.slice(0, 6).map((item) => ({ label: item.label, count: money(item.value) }));
        const title = config.sections.insights ? 'Найчастіші помилки' : config.sections.tradeTypes ? 'Типи угод' : config.sections.hourly ? 'PnL за часом входу' : 'PnL за ціною входу';
        text(details.ctx, title, 70, lowerTitleY, 20, details.colors.text, 700);
        list.forEach((item, index) => {
            text(details.ctx, `${index + 1}. ${item.label}`, 85, lowerTitleY + 50 + index * 38, 16, details.colors.text);
            text(details.ctx, item.count, 1280, lowerTitleY + 50 + index * 38, 16, details.colors.accent, 750, 'right');
        });
        pages.push(details);
    }
    return pages;
}
function comparisonPage(config, group) {
    const page = makePage(config.appearance);
    addHeader(page, config, `${group.label} · порівняння періодів`);
    const headers = ['Період', 'PnL', 'Winrate', 'PF', 'Просадка', 'Днів'];
    headers.forEach((header, index) => text(page.ctx, header, [75, 500, 720, 900, 1050, 1250][index], 165, 14, page.colors.muted, 750, index ? 'right' : 'left'));
    group.periods.forEach((period, row) => {
        const y = 210 + row * 68;
        if (row % 2 === 0) { page.ctx.fillStyle = page.colors.card; page.ctx.fillRect(65, y - 14, 1270, 54); }
        text(page.ctx, period.label, 75, y, 16, page.colors.text, 650);
        [money(period.kpis.totalPnl), `${period.kpis.winRate.toFixed(1)}%`, Number.isFinite(period.kpis.profitFactor) ? period.kpis.profitFactor.toFixed(2) : '∞', money(period.kpis.maxDrawdown), period.kpis.tradeDays]
            .forEach((value, index) => text(page.ctx, value, [500, 720, 900, 1050, 1250][index], y, 16, page.colors.text, 650, 'right'));
    });
    return page;
}
function tradePages(config, group) {
    const all = group.periods.flatMap((period) => period.trades);
    const sort = config.trades.sort;
    all.sort((a, b) => sort === 'date-asc' ? a.date.localeCompare(b.date) : sort === 'pnl-desc' ? b.pnl - a.pnl : sort === 'pnl-asc' ? a.pnl - b.pnl : b.date.localeCompare(a.date));
    const rows = all.slice(0, config.trades.limit);
    const chunks = [];
    for (let i = 0; i < rows.length; i += 18) chunks.push(rows.slice(i, i + 18));
    return (chunks.length ? chunks : [[]]).map((chunk, pageIndex) => {
        const page = makePage(config.appearance);
        addHeader(page, config, `${group.label} · таблиця угод · ${pageIndex + 1}/${Math.max(1, chunks.length)}`);
        const xs = [70, 230, 410, 590, 770, 950, 1130, 1310];
        ['Дата', 'Тікер', 'Side', 'Тип', 'Вхід', 'Вихід', 'PnL', 'КФ'].forEach((header, index) => text(page.ctx, header, xs[index], 160, 13, page.colors.muted, 750, index > 5 ? 'right' : 'left'));
        chunk.forEach((trade, index) => {
            const y = 205 + index * 39;
            if (index % 2 === 0) { page.ctx.fillStyle = page.colors.card; page.ctx.fillRect(60, y - 9, 1280, 32); }
            [trade.date, trade.ticker, trade.side, trade.type, trade.entry, trade.exit].forEach((value, col) => text(page.ctx, value, xs[col], y, 13, page.colors.text));
            text(page.ctx, money(trade.pnl), xs[6], y, 13, trade.pnl >= 0 ? page.colors.profit : page.colors.loss, 650, 'right');
            text(page.ctx, trade.kf.toFixed(2), xs[7], y, 13, page.colors.text, 650, 'right');
        });
        return page;
    });
}

export { validateAnalyticsExportConfig };
export function buildAnalyticsReportData(config) {
    const contexts = availableContexts().filter((context) => config.sourceIds.includes(context.id));
    return buildReportData(config, contexts);
}
export async function generateAnalyticsPdf(reportData, appearance = reportData.config.appearance, onProgress = () => {}) {
    const config = { ...reportData.config, appearance };
    const identity = currentIdentity();
    const pages = [];
    if (config.sections.cover) pages.push(coverPage(config, identity, reportData.groups.map((group) => group.label).join(', ')));
    reportData.groups.forEach((group) => {
        group.periods.forEach((period) => pages.push(...periodPages(config, group, period)));
        if (config.comparison && config.sections.comparison && group.periods.length > 1) pages.push(comparisonPage(config, group));
        if (config.sections.trades) pages.push(...tradePages(config, group));
    });
    pages.forEach((page, index) => addFooter(page, config, index + 1));
    onProgress(18, 'Завантажую модуль PDF…');
    const { jsPDF } = await ensurePdfTools();
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    pages.forEach((page, index) => {
        if (index) pdf.addPage('a4', 'landscape');
        pdf.addImage(page.canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 297, 210, undefined, 'FAST');
        onProgress(20 + Math.round((index + 1) / pages.length * 75), `Формую сторінку ${index + 1} з ${pages.length}…`);
    });
    const filename = makeAnalyticsPdfFilename(config, identity);
    pdf.save(filename);
    onProgress(100, `PDF готовий: ${filename}`);
    return { filename, pages: pages.length };
}
export async function generateCurrentAnalyticsPdf() {
    const status = el('analytics-export-status');
    const bar = el('analytics-export-progressbar');
    const button = el('analytics-export-generate');
    try {
        button.disabled = true;
        const config = collectConfig();
        const reportData = buildAnalyticsReportData(config);
        await generateAnalyticsPdf(reportData, config.appearance, (percent, message) => {
            bar.style.width = `${percent}%`; status.textContent = message; status.classList.remove('error');
        });
    } catch (error) {
        status.textContent = error?.message || 'Не вдалося створити PDF.';
        status.classList.add('error');
        bar.style.width = '0';
    } finally {
        button.disabled = false;
    }
}

document.addEventListener('change', (event) => {
    if (event.target?.id === 'analytics-period-type') updateAnalyticsPeriodInputs();
    if (event.target?.dataset?.exportSection === 'trades') el('analytics-trade-options').hidden = !event.target.checked;
    if (event.target?.id === 'analytics-import-comparison') {
        const compare = document.querySelector('[data-export-source="compare"]');
        if (compare) compare.checked = event.target.checked;
    }
    if (event.target?.id === 'analytics-report-logo') {
        const file = event.target.files?.[0];
        if (!file) { logoDataUrl = ''; return; }
        const reader = new FileReader();
        reader.onload = () => {
            logoDataUrl = String(reader.result || '');
            logoImage = new Image();
            logoImage.src = logoDataUrl;
        };
        reader.readAsDataURL(file);
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el('analytics-export-modal')?.classList.contains('open')) closeAnalyticsExport();
});
