import { state } from './state.js';
import { supabase } from './supabase.js';
import { getStorageUrl } from './gallery.js';
import { showToast } from './utils.js';

const PATTERNS = {
    late_entry: 'Пізній вхід', chase_extension: 'Погоня за рухом', weak_breakout: 'Слабкий пробій',
    countertrend: 'Проти тренду', no_structure: 'Без структури', early_entry: 'Ранній вхід',
    poor_rr: 'Слабкий R/R', stop_violation: 'Порушення стопа', repeated_entry: 'Повторний вхід',
    failed_follow_through: 'Немає продовження', parabolic_extension: 'Параболічне розтягнення',
    breakout_retest: 'Пробій і ретест', pullback_entry: 'Вхід на відкаті', liquidity_sweep: 'Збір ліквідності',
    range_entry: 'Вхід у діапазоні', trend_continuation: 'Продовження тренду', confirmed_reversal: 'Підтверджений розворот',
    volume_mismatch: 'Об’єм не підтверджує',
    valid_entry: 'Правильний вхід', unclear: 'Неоднозначно', insufficient_data: 'Недостатньо даних',
};

let loaded = false;
let busy = false;
let trainingCampaign = null;
let trainingTimer = null;
let trainingStepRunning = false;
let trainingRetryMs = 15000;

function el(id) { return document.getElementById(id); }
function formatPercent(value) { return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'; }
function formatDate(value, withTime = false) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('uk-UA', withTime ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' });
}
function formatNumber(value) { return Number(value || 0).toLocaleString('uk-UA'); }
function formatMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number > 0 ? '+' : ''}${number.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} $` : '—';
}

async function api(path = '', options = {}) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Сесію завершено. Увійдіть знову.');
    const suffix = path ? `&${String(path).replace(/^\?/, '')}` : '';
    const response = await fetch(`/api/admin/service-bots?resource=ai-learning${suffix}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `API ${response.status}`);
    return payload;
}

function setStatus(message, tone = '') {
    const node = el('ai-learning-status');
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone;
}

function campaignIsRunning(campaign = trainingCampaign) {
    return campaign?.status === 'running' && Date.parse(campaign.endsAt || 0) > Date.now();
}

function syncCampaignUI(campaign = trainingCampaign) {
    trainingCampaign = campaign || null;
    const button = el('ai-learning-day');
    const running = campaignIsRunning();
    if (button) {
        button.textContent = running ? 'Зупинити навчання' : 'Навчати 24 години';
        button.classList.toggle('btn-primary', !running);
        button.classList.toggle('btn-secondary', running);
        button.setAttribute('aria-pressed', running ? 'true' : 'false');
    }
    if (running) {
        const leftMs = Math.max(0, Date.parse(campaign.endsAt) - Date.now());
        const hours = Math.floor(leftMs / 3600000);
        const minutes = Math.floor((leftMs % 3600000) / 60000);
        setStatus(`Автономне навчання активне · залишилось ${hours} год ${minutes} хв · оброблено ${campaign.processed || 0} · повтори автоматичні`);
        scheduleTrainingStep(0);
    }
}

function scheduleTrainingStep(delay = 0) {
    if (!campaignIsRunning() || trainingStepRunning) return;
    clearTimeout(trainingTimer);
    trainingTimer = window.setTimeout(() => { void runTrainingStep(); }, delay);
}

async function runTrainingStep() {
    if (!campaignIsRunning() || trainingStepRunning) return;
    if (busy) { scheduleTrainingStep(5000); return; }
    trainingStepRunning = true;
    let nextDelay = 0;
    try {
        const payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'run' }) });
        trainingRetryMs = 15000;
        syncCampaignUI(payload.campaign);
        loaded = false;
        if (Number(payload.run?.processed_count || 0) === 0) await renderAILearningCenter(true);
    } catch (error) {
        setStatus(`Навчання тимчасово зупинилося: ${error.message || error}. Повтор через ${Math.round(trainingRetryMs / 1000)} с`, 'error');
        nextDelay = trainingRetryMs;
        trainingRetryMs = Math.min(300000, Math.round(trainingRetryMs * 1.8));
    } finally {
        trainingStepRunning = false;
        if (campaignIsRunning()) scheduleTrainingStep(nextDelay);
    }
}

function makeKpi(label, value, note = '') {
    const card = document.createElement('article');
    card.className = 'ai-learning-kpi';
    const name = document.createElement('span'); name.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    card.append(name, strong);
    if (note) { const small = document.createElement('small'); small.textContent = note; card.append(small); }
    return card;
}

function renderKpis(summary = {}) {
    const host = el('ai-learning-kpis');
    if (!host) return;
    host.replaceChildren(
        makeKpi('Знайдено угод', formatNumber(summary.candidateTrades), 'у журналі'),
        makeKpi('Оброблено', formatNumber(summary.processed), 'актуальних версій'),
        makeKpi('Автоаналіз', formatNumber(summary.processed), 'без ручного рев’ю'),
        makeKpi('У пам’яті', formatNumber(summary.approved), 'впевнені закономірності'),
        makeKpi('Покриття скрінами', formatPercent(summary.screenshotCoverage), 'журнал + графік'),
        makeKpi('Якість пам’яті', formatPercent(summary.agreement), 'ручна перевірка, якщо була'),
    );
}

function renderQuality(data) {
    const agreement = el('ai-learning-agreement');
    if (agreement) agreement.textContent = formatPercent(data.summary?.agreement);
    const history = data.qualityHistory || [];
    const chart = el('ai-learning-quality-chart');
    if (chart) {
        if (!history.length) chart.textContent = 'Графік з’явиться після перших підтверджених прикладів.';
        else {
            const width = 600; const height = 120;
            const points = history.map((item, index) => `${history.length === 1 ? width : (index / (history.length - 1)) * width},${height - Number(item.accuracy || 0) * (height - 12)}`).join(' ');
            chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Динаміка точності AI"><line x1="0" y1="${height}" x2="${width}" y2="${height}"/><polyline points="${points}"/><circle cx="${points.split(' ').at(-1).split(',')[0]}" cy="${points.split(' ').at(-1).split(',')[1]}" r="5"/></svg>`;
        }
    }
    const patterns = el('ai-learning-patterns');
    if (patterns) {
        patterns.replaceChildren();
        const patternTotal = (data.patterns || []).reduce((sum, item) => sum + (Number(item.total) || 0), 0);
        (data.patterns || []).slice(0, 8).forEach((item) => {
            const share = patternTotal ? (Number(item.total) || 0) / patternTotal : 0;
            const row = document.createElement('div'); row.className = 'ai-learning-pattern-row';
            const title = document.createElement('span'); title.textContent = PATTERNS[item.key] || item.key;
            const meter = document.createElement('i'); meter.style.setProperty('--value', `${Math.max(4, share * 100)}%`);
            const value = document.createElement('b'); value.textContent = `${formatPercent(item.accuracy)} · ${item.total}`;
            value.textContent = `${formatPercent(share)} · ${item.total}`;
            row.append(title, meter, value); patterns.append(row);
        });
        if (!patterns.childElementCount) patterns.textContent = 'Категорії заповняться після рев’ю.';
    }
    const personal = el('ai-learning-personal-patterns');
    if (personal) {
        personal.replaceChildren();
        (data.personalPatterns || []).slice(0, 12).forEach((item) => {
            const row = document.createElement('div'); row.className = 'ai-learning-pattern-row';
            const title = document.createElement('span');
            title.textContent = PATTERNS[item.pattern_key] || item.pattern_key;
            const meter = document.createElement('i');
            meter.style.setProperty('--value', `${Math.max(4, Math.min(100, Number(item.win_rate || 0) * 100))}%`);
            const value = document.createElement('b');
            const lift = item.lift == null ? '—' : `${Number(item.lift) >= 0 ? '+' : ''}${Math.round(Number(item.lift) * 100)} п.п.`;
            value.textContent = `${formatPercent(item.win_rate)} · n=${item.outcome_sample_size} · ${lift} · ${item.reliability}`;
            row.append(title, meter, value); personal.append(row);
        });
        if (!personal.childElementCount) personal.textContent = 'Потрібно щонайменше 8 ручно перевірених прикладів однієї структури.';
    }
}

function renderMeta(data) {
    const host = el('ai-learning-version');
    if (host) {
        const version = data.version || {};
        const job = data.currentJob || {};
        host.replaceChildren();
        [['Базова модель', version.model_name || 'gemini-2.5-flash'], ['Промпт', version.prompt_version || 'entry-mistake-v1'], ['Пам’ять', `v${version.memory_version || 0}`], ['Job', job.id ? `${job.status} · ${job.prompt_version}` : 'немає'], ['Прогрес job', job.id ? `${formatNumber(job.processed_count)} оброблено · ${formatNumber(job.failed_count)} помилок · ${formatNumber(job.batch_count)} кроків` : '—'], ['Heartbeat', formatDate(job.heartbeat_at, true)], ['Останній запуск', formatDate(data.lastRun?.started_at, true)], ['Наступний запуск', formatDate(data.nextRunAt, true)], ['Останні помилки', formatNumber(data.lastRun?.failed_count)]].forEach(([key, value]) => {
            const row = document.createElement('div'); const k = document.createElement('span'); const v = document.createElement('strong');
            k.textContent = key; v.textContent = value; row.append(k, v); host.append(row);
        });
    }
    const traders = el('ai-learning-traders');
    if (traders) {
        traders.replaceChildren();
        const max = Math.max(1, ...(data.traders || []).map((item) => item.count));
        (data.traders || []).forEach((item) => {
            const row = document.createElement('div'); row.className = 'ai-learning-trader-row';
            const label = document.createElement('span'); label.textContent = item.name;
            const bar = document.createElement('i'); bar.style.setProperty('--value', `${item.count / max * 100}%`);
            const count = document.createElement('b'); count.textContent = item.count;
            row.append(label, bar, count); traders.append(row);
        });
        if (!traders.childElementCount) traders.textContent = 'Ще немає оброблених угод.';
    }
}

function reviewButton(label, action, id, patternKey = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = action === 'approve' ? 'btn-primary' : 'btn-secondary';
    button.textContent = label; button.dataset.action = 'ai-learning-review'; button.dataset.reviewAction = action; button.dataset.exampleId = id;
    if (patternKey) button.dataset.patternKey = patternKey;
    return button;
}

async function renderExample(example) {
    const card = document.createElement('article'); card.className = 'ai-learning-example'; card.dataset.example = example.id;
    const visual = document.createElement('div'); visual.className = 'ai-learning-example__visual';
    if (example.screenshot_path) {
        const image = document.createElement('img'); image.alt = `Графік ${example.source_snapshot?.ticker || ''}`; image.loading = 'lazy';
        getStorageUrl(example.screenshot_path).then((url) => { if (url && image.isConnected) image.src = url; });
        visual.append(image);
    } else { visual.textContent = 'Скріншот відсутній'; visual.classList.add('is-empty'); }
    const body = document.createElement('div'); body.className = 'ai-learning-example__body';
    const header = document.createElement('div'); header.className = 'ai-learning-example__head';
    const title = document.createElement('strong'); title.textContent = `${example.source_snapshot?.ticker || 'Угода'} · ${example.trader?.display_name || 'Трейдер'}`;
    const result = document.createElement('span'); result.textContent = `${formatDate(example.trade_date)} · ${formatMoney(example.outcome?.pnl)} · ${example.outcome?.kf ?? '—'} КФ`;
    header.append(title, result);
    const prediction = document.createElement('div'); prediction.className = 'ai-learning-example__prediction';
    const badge = document.createElement('b'); badge.textContent = PATTERNS[example.ai_pattern_key] || example.ai_label || 'Не визначено';
    const confidence = document.createElement('span'); confidence.textContent = `Впевненість ${formatPercent(Number(example.ai_confidence))}`;
    prediction.append(badge, confidence);
    const explanation = document.createElement('p'); explanation.textContent = example.ai_explanation || 'AI не залишив пояснення.';
    const evidence = document.createElement('div'); evidence.className = 'ai-learning-example__evidence';
    const visualText = document.createElement('span'); visualText.textContent = `Скрін: ${example.visual_evidence || 'немає доказу'}`;
    const journalText = document.createElement('span'); journalText.textContent = `Журнал: ${example.journal_evidence || 'немає доказу'}`;
    evidence.append(visualText, journalText);
    const featureHost = document.createElement('div'); featureHost.className = 'ai-learning-example__features';
    const features = example.source_snapshot?.aiFeatures || {};
    const chartSummary = document.createElement('p');
    chartSummary.textContent = `Короткий опис графіка: ${features.chartSummary || 'ще не сформовано'}`;
    const featureItems = [
        ['Критерії', example.source_snapshot?.criteria], ['Винятки', example.source_snapshot?.exceptions],
        ['Фаза', features.movement?.phase], ['Рух', features.movement?.direction],
        ['Сила', Number(features.movement?.strength) ? `${Math.round(Number(features.movement.strength) * 100)}%` : ''],
        ['Розтягнення', features.movement?.extension], ['Структура', features.movement?.structure],
        ['Місце входу', features.movement?.entryLocation], ['Таймінг', features.execution?.timing],
        ['Підтвердження', features.execution?.confirmation], ['За трендом', features.execution?.trendAlignment],
        ['R/R', features.execution?.riskReward], ['Стоп', features.execution?.stopQuality],
        ['Рівень', features.context?.levelInteraction], ['Об’єм', features.context?.volumeSignal],
        ['Волатильність', features.context?.volatility],
        ['Процес/результат', ({
            skill_confirmed: 'якісний процес + результат',
            good_process_bad_outcome: 'якісний процес, негативний результат',
            bad_process_good_outcome: 'слабкий процес, позитивний результат',
            process_risk_confirmed: 'слабкий процес + негативний результат',
        })[features.processOutcome?.quadrant]],
    ].filter(([, value]) => value);
    featureItems.forEach(([label, value]) => {
        const chip = document.createElement('span');
        const key = document.createElement('b'); key.textContent = `${label}: `;
        chip.append(key, document.createTextNode(value)); featureHost.append(chip);
    });
    (features.signals || []).slice(0, 6).forEach((signal) => {
        const chip = document.createElement('span'); chip.className = 'is-signal'; chip.textContent = signal; featureHost.append(chip);
    });
    Object.entries(features.taxonomy || {}).forEach(([group, labels]) => {
        (Array.isArray(labels) ? labels : []).slice(0, 4).forEach((label) => {
            const chip = document.createElement('span'); chip.className = 'is-signal';
            chip.textContent = `${group}: ${label}`; featureHost.append(chip);
        });
    });
    const context = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Дані журналу';
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(example.source_snapshot || {}, null, 2); context.append(summary, pre);
    const autoStatus = document.createElement('div'); autoStatus.className = 'ai-learning-example__auto';
    autoStatus.textContent = example.review_status === 'pending'
        ? 'Чернетка AI · потрібна ручна перевірка перед додаванням у пам’ять'
        : 'Перевірено людиною · приклад доступний для пам’яті';
    const reviewControls = document.createElement('div'); reviewControls.className = 'ai-learning-example__controls';
    const patternSelect = document.createElement('select'); patternSelect.className = 'ai-learning-pattern-select';
    patternSelect.setAttribute('aria-label', 'Правильна структура угоди');
    Object.entries(PATTERNS).forEach(([key, label]) => {
        const option = document.createElement('option'); option.value = key; option.textContent = label;
        option.selected = key === example.ai_pattern_key; patternSelect.append(option);
    });
    const reviewNote = document.createElement('textarea'); reviewNote.className = 'ai-learning-review-note';
    reviewNote.rows = 2; reviewNote.maxLength = 1000; reviewNote.placeholder = 'Що AI побачив правильно або пропустив?';
    reviewControls.append(
        patternSelect,
        reviewButton('Підтвердити прогноз', 'approve', example.id),
        reviewButton('Зберегти виправлення', 'correct', example.id),
        reviewButton('Відхилити', 'reject', example.id),
    );
    body.append(header, prediction, chartSummary, explanation, evidence);
    if (featureHost.childElementCount) body.append(featureHost);
    body.append(context, autoStatus);
    if (example.review_status === 'pending') body.append(reviewNote, reviewControls);
    card.append(visual, body);
    return card;
}

async function renderQueue(examples = []) {
    const host = el('ai-learning-queue'); if (!host) return;
    host.replaceChildren();
    for (const example of examples) host.append(await renderExample(example));
    if (!examples.length) { const empty = document.createElement('div'); empty.className = 'ai-learning-empty'; empty.textContent = 'Черга порожня. Запустіть аналіз або дочекайтеся щоденної синхронізації.'; host.append(empty); }
}

function renderRuns(runs = []) {
    const host = el('ai-learning-runs'); if (!host) return; host.replaceChildren();
    runs.slice(0, 8).forEach((run) => {
        const row = document.createElement('div'); row.className = 'ai-learning-run-row'; row.dataset.status = run.status;
        const mark = document.createElement('i'); const title = document.createElement('strong'); title.textContent = run.trigger_type === 'cron' ? 'Автоматично' : 'Вручну';
        const stats = document.createElement('span'); stats.textContent = `${formatDate(run.started_at, true)} · ${run.processed_count || 0} оброблено · ${run.failed_count || 0} помилок · ≈ $${Number(run.estimated_cost_usd || 0).toFixed(3)}`;
        row.append(mark, title, stats); host.append(row);
    });
    if (!runs.length) host.textContent = 'Запусків ще не було.';
}

export async function renderAILearningCenter(force = false) {
    initAILearningCenter();
    if (state.myRole !== 'admin' || (loaded && !force) || busy) return;
    busy = true; setStatus('Оновлюємо метрики й чергу…');
    try {
        const [overview, queue] = await Promise.all([api('?section=overview'), api('?section=queue&status=pending&limit=12')]);
        renderKpis(overview.summary); renderQuality(overview); renderMeta(overview); renderRuns(overview.runs); await renderQueue(queue.examples || []);
        syncCampaignUI(overview.campaign);
        const count = el('ai-learning-queue-count'); if (count) count.textContent = overview.summary?.pending || 0;
        setStatus(overview.lastRun ? `Останнє оновлення: ${formatDate(overview.lastRun.finished_at || overview.lastRun.started_at, true)}` : 'AI ще не запускав аналіз.');
        loaded = true;
    } catch (error) { setStatus(error.message || String(error), 'error'); }
    finally { busy = false; }
}

export function initAILearningCenter() {
    const button = el('btn-ai-learning');
    if (button) button.classList.toggle('initially-hidden', state.myRole !== 'admin');
    if (state.myRole !== 'admin' && !el('ai-learning-section')?.classList.contains('initially-hidden')) window.switchAITab?.('chat');
}

export async function runAILearning() {
    if (busy || state.myRole !== 'admin') return;
    const button = el('ai-learning-run'); busy = true; if (button) { button.disabled = true; button.textContent = 'AI аналізує…'; }
    setStatus('Збираємо нові угоди та аналізуємо їх зі скрінами й журналом…');
    try { const payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'run' }) }); showToast(`Оброблено: ${payload.run?.processed_count || 0}`); loaded = false; busy = false; await renderAILearningCenter(true); }
    catch (error) { setStatus(error.message || String(error), 'error'); showToast(error.message || String(error)); }
    finally { busy = false; if (button) { button.disabled = false; button.textContent = 'Один пакет'; } }
}

export async function startNewAILearning() {
    if (busy || state.myRole !== 'admin') return;
    const button = el('ai-learning-new');
    busy = true;
    if (button) { button.disabled = true; button.textContent = 'Новий прогін…'; }
    setStatus('Створюємо нову версію та повторно аналізуємо всі угоди…');
    try {
        let payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'new-training' }) });
        let processed = Number(payload.run?.processed_count || 0);
        let batchNumber = 1;
        console.info(`[AI new training] Пакет ${batchNumber}`, payload.run);
        if (!processed && Number(payload.run?.failed_count || 0) && payload.job?.status === 'failed') {
            console.error('[AI new training] Перший пакет завершився помилками', payload.run?.errors || []);
            throw new Error(payload.run?.errors?.[0]?.message || 'Новий прогін не зміг обробити перший пакет');
        }
        if (!processed && !Number(payload.run?.scanned_count || 0)) {
            throw new Error('Не знайдено угод ані в журналі, ані серед попередніх AI-аналізів');
        }
        while (payload.job?.status === 'running') {
            batchNumber += 1;
            setStatus(`Нова версія: пакет ${batchNumber}, уже оброблено ${processed} угод…`);
            payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'continue-training' }) });
            const batchProcessed = Number(payload.run?.processed_count || 0);
            processed += batchProcessed;
            console.info(`[AI new training] Пакет ${batchNumber}: оброблено ${batchProcessed}, разом ${processed}`, payload.run);
            if (!batchProcessed && Number(payload.run?.failed_count || 0) && payload.job?.status === 'failed') {
                throw new Error(payload.run?.errors?.[0]?.message || `Пакет ${batchNumber} завершився помилкою`);
            }
            if (!batchProcessed && payload.job?.status === 'running') await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        showToast(`Нова версія: повторно оброблено ${processed} угод`);
        loaded = false;
        await renderAILearningCenter(true);
    } catch (error) {
        setStatus(error.message || String(error), 'error');
        showToast(error.message || String(error));
    } finally {
        busy = false;
        if (button) { button.disabled = false; button.textContent = 'Нове навчання'; }
    }
}

export async function continueAILearning() {
    if (busy || state.myRole !== 'admin') return;
    const button = el('ai-learning-continue'); busy = true;
    if (button) { button.disabled = true; button.textContent = 'Обробляємо…'; }
    setStatus('Продовжуємо останнє навчання з наступної необробленої угоди…');
    try {
        const overview = await api('?section=overview');
        const action = ['failed', 'stopped'].includes(overview.currentJob?.status) ? 'resume-training' : 'continue-training';
        const payload = await api('', { method: 'POST', body: JSON.stringify({ action }) });
        const processed = Number(payload.run?.processed_count || 0);
        const remaining = Number(payload.run?.remaining_count || 0);
        console.info('[AI training continue]', payload.job, payload.run);
        showToast(`Крок завершено: ${processed}; залишилось ≈ ${remaining}`);
        loaded = false; busy = false; await renderAILearningCenter(true);
    } catch (error) {
        setStatus(error.message || String(error), 'error'); showToast(error.message || String(error));
    } finally {
        busy = false;
        if (button) { button.disabled = false; button.textContent = 'Продовжити'; }
    }
}

export async function evaluateAILearning() {
    if (busy || state.myRole !== 'admin') return;
    const button = el('ai-learning-evaluate');
    busy = true;
    if (button) { button.disabled = true; button.textContent = 'Перевіряємо…'; }
    setStatus('Перевіряємо поточну версію на ручному контрольному наборі…');
    try {
        const payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'evaluate' }) });
        const result = payload.evaluation || {};
        console.info('[AI evaluation]', result);
        if (!result.total) {
            setStatus('Контрольний набір порожній. Спочатку перевірте й підтвердьте приклади вручну.');
            return;
        }
        setStatus(`Контрольний набір: ${result.total} · загальна точність ${formatPercent(result.exactAccuracy)} · точність відповідей ${formatPercent(result.selectiveAccuracy)} · покриття ${formatPercent(result.coverage)} · докази ${formatPercent(result.evidenceCoverage)} · калібрування ECE ${formatPercent(result.calibrationError)} · помилки ${result.failed || 0}`);
    } catch (error) {
        setStatus(error.message || String(error), 'error');
        showToast(error.message || String(error));
    } finally {
        busy = false;
        if (button) { button.disabled = false; button.textContent = 'Перевірити якість'; }
    }
}

export async function toggleAILearningDay() {
    if (state.myRole !== 'admin' || trainingStepRunning) return;
    const button = el('ai-learning-day');
    if (button) button.disabled = true;
    try {
        if (campaignIsRunning()) {
            clearTimeout(trainingTimer);
            const payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'stop-day' }) });
            syncCampaignUI(payload.campaign);
            setStatus('Автономне навчання зупинено. Уже створена пам’ять збережена.');
        } else {
            const payload = await api('', { method: 'POST', body: JSON.stringify({ action: 'start-day' }) });
            trainingRetryMs = 15000;
            syncCampaignUI(payload.campaign);
            showToast('Навчання на 24 години запущено');
        }
    } catch (error) {
        setStatus(error.message || String(error), 'error');
        showToast(error.message || String(error));
    } finally {
        if (button) button.disabled = false;
    }
}

export async function reviewAILearningExample(trigger) {
    if (busy || state.myRole !== 'admin') return;
    const card = trigger?.closest?.('[data-example]'); if (!card) return;
    const action = trigger.dataset.reviewAction; const id = trigger.dataset.exampleId;
    const patternKey = card.querySelector('.ai-learning-pattern-select')?.value || '';
    const note = card.querySelector('.ai-learning-review-note')?.value || '';
    trigger.disabled = true;
    try {
        await api(`?id=${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action, patternKey, note }) });
        card.remove(); loaded = false; showToast(action === 'reject' ? 'Приклад відхилено' : 'Пам’ять AI оновлено');
        await renderAILearningCenter(true);
    } catch (error) { trigger.disabled = false; showToast(error.message || String(error)); }
}
