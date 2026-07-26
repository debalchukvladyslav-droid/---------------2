import { supabase } from './supabase.js';
import { state } from './state.js';
import { getSupabaseStorageUrl } from './supabase_storage.js';
import { showToast } from './utils.js';
import { markJournalDayDirty, saveToLocal } from './storage.js';
import { buildStopReviewCandidates, googleDriveFileId, isStopExitReason, normalizeStopExitReason } from './stop_review_core.js';

const STATUS_LABELS = {
    normal: 'Нормальний стоп',
    bad: 'Поганий стоп',
    uncertain: 'Нерозібраний',
};

const runtime = {
    ready: false,
    reviews: [],
    mistakes: [],
    links: [],
    candidates: [],
    queue: [],
    index: 0,
    statusFilter: 'pending',
    skippedReviewIds: new Set(),
    selectedMistakeId: '',
    lastPickedMistakeId: '',
    imageUrls: new Map(),
};

export function normalizeExitReason(value) {
    return normalizeStopExitReason(value);
}

export function isStopExit(value) {
    return isStopExitReason(value);
}

function normalizeSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function tradeRef(trade, index) {
    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
    return {
        sheetRow: Number.isInteger(Number(sheet.sheetRow)) ? Number(sheet.sheetRow) : index,
        spreadsheetId: String(sheet.spreadsheetId || ''),
        net: Number(trade?.net) || 0,
        type: String(trade?.type || sheet.tradeType || ''),
        stop: trade?.stop ?? sheet.stopPrice ?? null,
        exitReason: String(sheet.exit || ''),
    };
}

function dayScreenshotPaths(day, symbol, tickers = {}) {
    const screens = day?.screenshots && typeof day.screenshots === 'object' ? day.screenshots : {};
    const all = ['good', 'normal', 'bad', 'error'].flatMap(key => Array.isArray(screens[key]) ? screens[key] : []);
    return [...new Set(all.filter(path => normalizeSymbol(tickers[path]) === symbol))];
}

export function collectStopCandidates(appData = {}, from = '', to = '') {
    return buildStopReviewCandidates(appData, from, to);
}

function currentUserId() {
    return state.currentViewedUserId || state.myUserId;
}

function isOwner() {
    return !!state.myUserId && currentUserId() === state.myUserId;
}

function monthBounds() {
    const now = state.todayObj instanceof Date ? state.todayObj : new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const last = new Date(year, now.getMonth() + 1, 0).getDate();
    return { from: `${year}-${month}-01`, to: `${year}-${month}-${String(last).padStart(2, '0')}` };
}

function reviewKey(row) {
    return `${row.trade_date}|${normalizeSymbol(row.symbol)}`;
}

async function loadRemoteData() {
    const userId = currentUserId();
    if (!userId) return;
    const [reviewsResult, mistakesResult] = await Promise.all([
        supabase.from('stop_reviews').select('*').eq('user_id', userId).order('trade_date', { ascending: true }),
        supabase.from('stop_mistakes').select('*').eq('user_id', userId).order('sort_order').order('created_at'),
    ]);
    if (reviewsResult.error) throw reviewsResult.error;
    if (mistakesResult.error) throw mistakesResult.error;
    runtime.reviews = reviewsResult.data || [];
    runtime.mistakes = mistakesResult.data || [];
    const ids = runtime.reviews.map(row => row.id);
    if (!ids.length) {
        runtime.links = [];
        return;
    }
    const linksResult = await supabase.from('stop_review_mistakes').select('review_id,mistake_id').in('review_id', ids);
    if (linksResult.error) throw linksResult.error;
    runtime.links = linksResult.data || [];
}

async function syncSharedMistakeCatalog() {
    if (!isOwner()) return;
    const dayTitles = [...new Set((state.appData?.errorTypes || []).map(title => String(title).trim()).filter(Boolean))];
    const remoteTitles = new Set(runtime.mistakes.map(item => item.title));
    const missingRemote = dayTitles.filter(title => !remoteTitles.has(title));
    if (missingRemote.length) {
        const { error } = await supabase.from('stop_mistakes').insert(missingRemote.map((title, index) => ({
            user_id: currentUserId(),
            title,
            sort_order: dayTitles.indexOf(title),
        })));
        if (error) throw error;
        await loadRemoteData();
    }
    const canonicalOrder = new Map(dayTitles.map((title, index) => [title, index]));
    const updates = runtime.mistakes.map((item) => {
        const index = canonicalOrder.get(item.title);
        const archived = index == null;
        const sortOrder = index == null ? Number(item.sort_order) || dayTitles.length : index;
        if (item.archived === archived && Number(item.sort_order) === sortOrder) return null;
        return supabase.from('stop_mistakes').update({
            archived,
            sort_order: sortOrder,
            updated_at: new Date().toISOString(),
        }).eq('id', item.id);
    }).filter(Boolean);
    if (updates.length) {
        const results = await Promise.all(updates);
        const failed = results.find(result => result.error);
        if (failed?.error) throw failed.error;
        await loadRemoteData();
    }
}

function canonicalMistakes({ includeChosen = new Set() } = {}) {
    const titles = Array.isArray(state.appData?.errorTypes) ? state.appData.errorTypes : [];
    const order = new Map(titles.map((title, index) => [title, index]));
    return runtime.mistakes
        .filter(item => order.has(item.title) || includeChosen.has(item.id))
        .sort((a, b) => {
            const aOrder = order.has(a.title) ? order.get(a.title) : Number.MAX_SAFE_INTEGER;
            const bOrder = order.has(b.title) ? order.get(b.title) : Number.MAX_SAFE_INTEGER;
            return aOrder - bOrder || String(a.title).localeCompare(String(b.title), 'uk');
        });
}

async function applySharedMistakeChange(detail = {}) {
    if (!isOwner()) return;
    if (detail.action === 'add' && detail.title) {
        const exists = runtime.mistakes.some(item => item.title === detail.title && !item.archived);
        if (!exists) {
            const maxOrder = runtime.mistakes.reduce((max, item) => Math.max(max, Number(item.sort_order) || 0), -1);
            await supabase.from('stop_mistakes').insert({
                user_id: currentUserId(),
                title: detail.title,
                sort_order: maxOrder + 1,
            });
        }
    } else if (detail.action === 'rename' && detail.oldTitle && detail.title) {
        await supabase.from('stop_mistakes').update({
            title: detail.title,
            updated_at: new Date().toISOString(),
        }).eq('user_id', currentUserId()).eq('title', detail.oldTitle);
    } else if (detail.action === 'archive' && detail.oldTitle) {
        await supabase.from('stop_mistakes').update({
            archived: true,
            updated_at: new Date().toISOString(),
        }).eq('user_id', currentUserId()).eq('title', detail.oldTitle);
    }
    await loadRemoteData();
    renderMistakeCatalog();
    if (document.getElementById('stop-review-card')) await renderCurrentCard();
}

async function syncMistakeTitleToJournal(oldTitle, newTitle) {
    if (!oldTitle || !newTitle || oldTitle === newTitle) return;
    const types = Array.isArray(state.appData.errorTypes) ? state.appData.errorTypes : [];
    const oldIndex = types.indexOf(oldTitle);
    if (oldIndex >= 0) types[oldIndex] = newTitle;
    else if (!types.includes(newTitle)) types.push(newTitle);
    Object.entries(state.appData.journal || {}).forEach(([dateStr, day]) => {
        if (!Array.isArray(day?.errors) || !day.errors.includes(oldTitle)) return;
        day.errors = [...new Set(day.errors.map(title => title === oldTitle ? newTitle : title))];
        if (day.__detailsLoaded !== false) markJournalDayDirty(dateStr);
    });
    await saveToLocal();
    window.renderErrorsList?.();
}

async function syncCandidates(candidates) {
    if (!isOwner()) return;
    const userId = currentUserId();
    const activeKeys = new Set(candidates.map(reviewKey));
    const payload = candidates.map(item => ({
        user_id: userId,
        trade_date: item.trade_date,
        symbol: item.symbol,
        trade_refs: item.trade_refs,
        screenshot_paths: item.screenshot_paths,
        active: true,
    }));
    if (payload.length) {
        const { error } = await supabase.from('stop_reviews').upsert(payload, {
            onConflict: 'user_id,trade_date,symbol',
            ignoreDuplicates: false,
        });
        if (error) throw error;
    }
    const staleIds = runtime.reviews.filter(row => row.active && !activeKeys.has(reviewKey(row))).map(row => row.id);
    if (staleIds.length) {
        const { error } = await supabase.from('stop_reviews').update({ active: false, updated_at: new Date().toISOString() }).in('id', staleIds);
        if (error) throw error;
    }
}

function selectedRange() {
    const defaults = monthBounds();
    return {
        from: document.getElementById('stop-review-from')?.value || defaults.from,
        to: document.getElementById('stop-review-to')?.value || defaults.to,
    };
}

function hydrateCandidates() {
    const range = selectedRange();
    runtime.candidates = collectStopCandidates(state.appData, range.from, range.to);
}

async function refreshData({ sync = true } = {}) {
    hydrateCandidates();
    await loadRemoteData();
    await syncSharedMistakeCatalog();
    if (sync) {
        await syncCandidates(collectStopCandidates(state.appData));
        await loadRemoteData();
    }
}

function reviewStatus(review) {
    return review.final_status || review.initial_status || 'pending';
}

function rebuildQueue() {
    const { from, to } = selectedRange();
    const active = runtime.reviews.filter(row => row.active && (!from || row.trade_date >= from) && (!to || row.trade_date <= to));
    if (runtime.statusFilter === 'all') {
        runtime.queue = active;
    } else if (runtime.statusFilter === 'pending') {
        runtime.queue = active.filter(row => (!row.initial_status || row.initial_status === 'uncertain') && !runtime.skippedReviewIds.has(row.id));
    } else {
        runtime.queue = active.filter(row => reviewStatus(row) === runtime.statusFilter);
    }
    runtime.index = Math.min(runtime.index, Math.max(0, runtime.queue.length - 1));
}

async function urlFor(path) {
    if (runtime.imageUrls.has(path)) return runtime.imageUrls.get(path);
    try {
        const url = await getSupabaseStorageUrl(path);
        runtime.imageUrls.set(path, url);
        return url;
    } catch (_) {
        return '';
    }
}

async function drivePreviewUrl(fileId) {
    if (!fileId) return '';
    const cacheKey = `drive:${fileId}`;
    if (runtime.imageUrls.has(cacheKey)) return runtime.imageUrls.get(cacheKey);
    try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token || '';
        if (!token) return '';
        const url = new URL('/api/drive-service', window.location.origin);
        url.searchParams.set('action', 'media');
        url.searchParams.set('fileId', fileId);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) return '';
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) return '';
        const objectUrl = URL.createObjectURL(await response.blob());
        runtime.imageUrls.set(cacheKey, objectUrl);
        return objectUrl;
    } catch (_) {
        return '';
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function renderCurrentCard() {
    const host = document.getElementById('stop-review-card');
    const progress = document.getElementById('stop-review-progress');
    if (!host) return;
    const review = runtime.queue[runtime.index];
    if (progress) progress.textContent = runtime.queue.length ? `${runtime.index + 1} / ${runtime.queue.length}` : '0 / 0';
    if (!review) {
        const canContinue = runtime.statusFilter === 'pending';
        host.innerHTML = `<div class="stop-review-empty stop-review-complete">
            <span class="stop-complete-icon">✓</span>
            <h3>${canContinue ? 'Усі нові стопи переглянуто' : 'У цій черзі стопів немає'}</h3>
            <p>${canContinue ? 'Можна відкрити всі стопи або змінити період.' : 'Для вибраного періоду більше немає стопів.'}</p>
        </div>`;
        return;
    }
    const paths = Array.isArray(review.screenshot_paths) ? review.screenshot_paths : [];
    const refs = Array.isArray(review.trade_refs) ? review.trade_refs : [];
    let urls = (await Promise.all(paths.map(urlFor))).filter(Boolean);
    if (!urls.length) {
        const driveIds = [...new Set(refs.map(ref => googleDriveFileId(ref.screenshotUrl)).filter(Boolean))];
        urls = (await Promise.all(driveIds.map(drivePreviewUrl))).filter(Boolean);
    }
    const total = refs.reduce((sum, ref) => sum + (Number(ref.net) || 0), 0);
    const chosen = new Set(runtime.links.filter(link => link.review_id === review.id).map(link => link.mistake_id));
    const mistakeOptions = canonicalMistakes({ includeChosen: chosen });
    host.innerHTML = `
        <div class="stop-review-meta">
            <div><span class="stop-review-symbol">${escapeHtml(review.symbol)}</span><span>${escapeHtml(review.trade_date)}</span></div>
            <div class="${total < 0 ? 'loss' : 'profit'}">${total >= 0 ? '+' : ''}${total.toFixed(2)}$</div>
        </div>
        <div class="stop-review-trades">${refs.map(ref => `<span>${escapeHtml(ref.type || 'Угода')} · стоп ${escapeHtml(ref.stop ?? '—')} · ${Number(ref.net || 0).toFixed(2)}$</span>`).join('')}</div>
        <div class="stop-review-images">
            ${urls.length ? urls.map((url, index) => `<button class="stop-review-image" type="button" data-stop-image="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(review.symbol)} — скріншот ${index + 1}"></button>`).join('') : '<div class="stop-review-no-image">Не вдалося відкрити скріншот. Надайте service account доступ до файлу або папки Drive, потім оновіть імпорт таблиці.</div>'}
        </div>
        ${review.initial_status !== 'bad' ? `
            <div class="stop-review-actions">
                <button type="button" class="stop-choice normal ${review.initial_status === 'normal' ? 'selected' : ''}" data-stop-status="normal">Нормальний стоп</button>
                <button type="button" class="stop-choice bad ${review.initial_status === 'bad' ? 'selected' : ''}" data-stop-status="bad">Поганий стоп</button>
                <button type="button" class="stop-choice uncertain" data-stop-skip>Пропустити</button>
            </div>` : `
            <aside class="stop-stage2-mistakes">
                <div class="stop-stage2-head"><h4>Помилки</h4><small>Список із форми дня</small></div>
                <div class="stop-mistake-picker">${mistakeOptions.length ? mistakeOptions.map(item => `<div class="stop-stage2-mistake ${item.archived ? 'archived' : ''}" data-stop-mistake-row="${item.id}"><label><input type="checkbox" value="${item.id}" data-stop-mistake ${chosen.has(item.id) ? 'checked' : ''}><span>${escapeHtml(item.title)}</span></label></div>`).join('') : '<p>Додайте помилки у формі редагування дня.</p>'}</div>
            </aside>
            <div class="stop-finalize">
                <button type="button" class="btn-primary btn-auto" data-stop-complete ${chosen.size ? '' : 'disabled'}>Далі →</button>
            </div>`}
    `;
    host.querySelectorAll('[data-stop-image]').forEach(button => button.addEventListener('click', () => {
        const all = [...host.querySelectorAll('[data-stop-image]')].map(item => item.dataset.stopImage);
        window.openZoomGallery?.(button.dataset.stopImage, all);
    }));
    host.querySelectorAll('[data-stop-status]').forEach(button => button.addEventListener('click', () => classify(review, button.dataset.stopStatus)));
    host.querySelector('[data-stop-skip]')?.addEventListener('click', skipCurrent);
    host.querySelector('[data-stop-complete]')?.addEventListener('click', () => completeMistakes(review, host));
    host.querySelectorAll('[data-stop-mistake]').forEach(input => input.addEventListener('change', () => {
        if (input.checked) runtime.lastPickedMistakeId = input.value;
        const nextButton = host.querySelector('[data-stop-complete]');
        if (nextButton) nextButton.disabled = !host.querySelector('[data-stop-mistake]:checked');
    }));
    const focusId = runtime.lastPickedMistakeId || [...chosen][0] || '';
    if (focusId) {
        requestAnimationFrame(() => {
            host.querySelector(`[data-stop-mistake-row="${CSS.escape(focusId)}"]`)?.scrollIntoView({
                block: 'nearest',
                inline: 'nearest',
            });
        });
    }
}

async function classify(review, status) {
    if (!isOwner()) return showToast('Рев’ю може змінювати лише власник профілю.');
    if (status === 'bad') {
        review.initial_status = 'bad';
        review.final_status = 'bad';
        await renderCurrentCard();
        return;
    }
    const finalStatus = status === 'normal' ? 'normal' : (status === 'bad' ? 'bad' : null);
    const { error } = await supabase.from('stop_reviews').update({
        initial_status: status,
        final_status: finalStatus,
        updated_at: new Date().toISOString(),
    }).eq('id', review.id);
    if (error) return showToast(`Не вдалося зберегти: ${error.message}`);
    await loadRemoteData();
    rebuildQueue();
    if (runtime.statusFilter === 'all') runtime.index = Math.min(runtime.index + 1, runtime.queue.length - 1);
    await renderCurrentCard();
    renderSummary();
    closeReviewWhenFinished();
}

function skipCurrent() {
    const review = runtime.queue[runtime.index];
    if (!review) return;
    if (runtime.statusFilter === 'pending') {
        runtime.skippedReviewIds.add(review.id);
        rebuildQueue();
    } else {
        runtime.index = Math.min(runtime.queue.length - 1, runtime.index + 1);
    }
    void renderCurrentCard();
    closeReviewWhenFinished();
}

async function completeMistakes(review, host) {
    if (!isOwner()) return showToast('Рев’ю може змінювати лише власник профілю.');
    const ids = [...host.querySelectorAll('[data-stop-mistake]:checked')].map(input => input.value);
    if (!ids.length) return showToast('Для поганого стопа виберіть хоча б одну помилку.');
    const { error: deleteError } = await supabase.from('stop_review_mistakes').delete().eq('review_id', review.id);
    if (deleteError) return showToast(deleteError.message);
    const { error } = await supabase.from('stop_review_mistakes').insert(ids.map(mistakeId => ({ review_id: review.id, mistake_id: mistakeId })));
    if (error) return showToast(error.message);
    const { error: statusError } = await supabase.from('stop_reviews').update({
        initial_status: 'bad',
        final_status: 'bad',
        updated_at: new Date().toISOString(),
    }).eq('id', review.id);
    if (statusError) return showToast(statusError.message);
    const focusMistakeId = ids.includes(runtime.lastPickedMistakeId) ? runtime.lastPickedMistakeId : ids[0];
    runtime.lastPickedMistakeId = focusMistakeId;
    runtime.selectedMistakeId = focusMistakeId;
    await loadRemoteData();
    rebuildQueue();
    if (runtime.statusFilter === 'all') runtime.index = Math.min(runtime.index + 1, runtime.queue.length - 1);
    await renderCurrentCard();
    renderMistakeCatalog();
    showToast('Розбір стопа збережено.');
    window.dispatchEvent(new CustomEvent('journal:score-refresh'));
    closeReviewWhenFinished();
}

function renderSummary() {
    const el = document.getElementById('stop-review-summary');
    if (!el) return;
    const { from, to } = selectedRange();
    const rows = runtime.reviews.filter(row => row.active && row.trade_date >= from && row.trade_date <= to);
    const counts = { pending: 0, normal: 0, bad: 0 };
    rows.forEach(row => {
        const status = reviewStatus(row);
        counts[status === 'uncertain' ? 'pending' : status] = (counts[status === 'uncertain' ? 'pending' : status] || 0) + 1;
    });
    el.textContent = `Нерозібрані ${counts.pending} · Нормальні ${counts.normal} · Погані ${counts.bad}`;
}

function renderMistakeCatalog() {
    const list = document.getElementById('stop-mistakes-list');
    const detail = document.getElementById('stop-mistake-detail');
    if (!list || !detail) return;
    const linkedMistakeIds = new Set(runtime.links.map(link => link.mistake_id));
    const sorted = canonicalMistakes({ includeChosen: linkedMistakeIds });
    if (!runtime.selectedMistakeId || !runtime.mistakes.some(item => item.id === runtime.selectedMistakeId)) {
        runtime.selectedMistakeId = sorted.find(item => !item.archived)?.id || sorted[0]?.id || '';
    }
    list.innerHTML = sorted.length ? sorted.map((item, index) => `
        <div role="button" tabindex="0" class="stop-mistake-list-item ${item.id === runtime.selectedMistakeId ? 'active' : ''} ${item.archived ? 'archived' : ''}" data-mistake-select="${item.id}">
            <span>${escapeHtml(item.title)}</span><small>${runtime.links.filter(link => link.mistake_id === item.id).length}</small>
        </div>`).join('') : '<div class="stop-mistake-empty">Каталог порожній. Створіть першу помилку.</div>';
    const selected = runtime.mistakes.find(item => item.id === runtime.selectedMistakeId);
    if (!selected) {
        detail.innerHTML = '<div class="stop-mistake-empty">Оберіть або додайте помилку.</div>';
    } else {
        const linkedIds = runtime.links.filter(link => link.mistake_id === selected.id).map(link => link.review_id);
        const linked = runtime.reviews.filter(review => linkedIds.includes(review.id));
        detail.innerHTML = `
            <input class="stop-mistake-title-input" value="${escapeHtml(selected.title)}" aria-label="Назва помилки" readonly>
            <textarea class="stop-mistake-description" rows="5" placeholder="Опишіть детальніше, як розпізнати цю помилку та що робити інакше.">${escapeHtml(selected.description)}</textarea>
            <div class="stop-mistake-detail-actions"><button type="button" class="btn-primary btn-auto" data-mistake-save>Зберегти опис</button></div>
            <h4>Прив’язані стопи · ${linked.length}</h4>
            <div class="stop-mistake-linked">${linked.length ? linked.map(review => `<button type="button" data-open-review="${review.id}"><span class="stop-mistake-thumb" data-mistake-thumb="${review.id}"></span><strong>${escapeHtml(review.symbol)}</strong><span>${review.trade_date}</span><small>${STATUS_LABELS[reviewStatus(review)] || reviewStatus(review)}</small></button>`).join('') : '<p>До цієї помилки ще нічого не прив’язано.</p>'}</div>`;
        detail.querySelector('[data-mistake-save]')?.addEventListener('click', () => saveMistake(selected, detail));
        detail.querySelectorAll('[data-open-review]').forEach(button => button.addEventListener('click', () => openLinkedReview(button.dataset.openReview)));
        void hydrateMistakeThumbnails(detail, linked);
    }
    list.querySelectorAll('[data-mistake-select]').forEach(button => button.addEventListener('click', event => {
        runtime.selectedMistakeId = button.dataset.mistakeSelect;
        renderMistakeCatalog();
    }));
    requestAnimationFrame(() => {
        list.querySelector(`[data-mistake-select="${CSS.escape(runtime.selectedMistakeId)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
}

async function hydrateMistakeThumbnails(detail, reviews) {
    await Promise.all(reviews.map(async review => {
        const target = detail.querySelector(`[data-mistake-thumb="${review.id}"]`);
        if (!target) return;
        const paths = Array.isArray(review.screenshot_paths) ? review.screenshot_paths : [];
        let src = paths.length ? await urlFor(paths[0]) : '';
        if (!src) {
            const refs = Array.isArray(review.trade_refs) ? review.trade_refs : [];
            const driveId = refs.map(ref => googleDriveFileId(ref.screenshotUrl)).find(Boolean);
            if (driveId) src = await drivePreviewUrl(driveId);
        }
        if (src && target.isConnected) target.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(review.symbol)}">`;
    }));
}

async function addMistake() {
    if (!isOwner()) return showToast('Каталог може змінювати лише власник профілю.');
    const title = window.prompt('Назва нової помилки:')?.trim();
    if (!title) return;
    const maxOrder = runtime.mistakes.reduce((max, item) => Math.max(max, item.sort_order || 0), -1);
    const { data, error } = await supabase.from('stop_mistakes').insert({ user_id: currentUserId(), title, sort_order: maxOrder + 1 }).select().single();
    if (error) return showToast(error.message);
    runtime.selectedMistakeId = data.id;
    if (!Array.isArray(state.appData.errorTypes)) state.appData.errorTypes = [];
    if (!state.appData.errorTypes.includes(title)) {
        state.appData.errorTypes.push(title);
        await saveToLocal();
        window.renderErrorsList?.();
    }
    await loadRemoteData();
    renderMistakeCatalog();
    await renderCurrentCard();
}

async function quickEditMistake(id) {
    const mistake = runtime.mistakes.find(item => item.id === id);
    if (!mistake || !isOwner()) return;
    const title = window.prompt('Назва помилки:', mistake.title)?.trim();
    if (!title) return;
    const description = window.prompt('Опис помилки:', mistake.description || '')?.trim() || '';
    const { error } = await supabase.from('stop_mistakes').update({
        title,
        description,
        updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) return showToast(error.message);
    await syncMistakeTitleToJournal(mistake.title, title);
    await loadRemoteData();
    renderMistakeCatalog();
    await renderCurrentCard();
}

async function saveMistake(mistake, detail) {
    const description = detail.querySelector('.stop-mistake-description')?.value.trim() || '';
    const { error } = await supabase.from('stop_mistakes').update({ description, updated_at: new Date().toISOString() }).eq('id', mistake.id);
    if (error) return showToast(error.message);
    await loadRemoteData();
    renderMistakeCatalog();
    showToast('Помилку збережено.');
}

async function toggleArchive(mistake) {
    const { error } = await supabase.from('stop_mistakes').update({ archived: !mistake.archived, updated_at: new Date().toISOString() }).eq('id', mistake.id);
    if (error) return showToast(error.message);
    if (!mistake.archived) {
        state.appData.errorTypes = (state.appData.errorTypes || []).filter(title => title !== mistake.title);
        await saveToLocal();
        window.renderErrorsList?.();
    } else if (!state.appData.errorTypes.includes(mistake.title)) {
        state.appData.errorTypes.push(mistake.title);
        await saveToLocal();
        window.renderErrorsList?.();
    }
    await loadRemoteData();
    renderMistakeCatalog();
    await renderCurrentCard();
}

async function moveMistake(id, direction) {
    const sorted = [...runtime.mistakes].sort((a, b) => a.sort_order - b.sort_order);
    const index = sorted.findIndex(item => item.id === id);
    const other = sorted[index + direction];
    if (index < 0 || !other) return;
    const current = sorted[index];
    const [{ error: first }, { error: second }] = await Promise.all([
        supabase.from('stop_mistakes').update({ sort_order: other.sort_order }).eq('id', current.id),
        supabase.from('stop_mistakes').update({ sort_order: current.sort_order }).eq('id', other.id),
    ]);
    if (first || second) return showToast((first || second).message);
    await loadRemoteData();
    renderMistakeCatalog();
}

function openLinkedReview(id) {
    runtime.statusFilter = 'all';
    rebuildQueue();
    const index = runtime.queue.findIndex(item => item.id === id);
    if (index >= 0) runtime.index = index;
    const workspace = mountFullscreenWorkspace();
    document.getElementById('stop-review-setup')?.classList.add('initially-hidden');
    workspace?.classList.remove('initially-hidden');
    workspace?.classList.add('stop-review-fullscreen');
    document.body.classList.add('stop-review-open');
    void renderCurrentCard();
}

function mountFullscreenWorkspace() {
    const workspace = document.getElementById('stop-review-workspace');
    if (!workspace) return null;
    if (workspace.parentElement !== document.body) document.body.appendChild(workspace);
    return workspace;
}

function closeReviewWorkspace() {
    const workspace = document.getElementById('stop-review-workspace');
    workspace?.classList.add('initially-hidden');
    workspace?.classList.remove('stop-review-fullscreen', 'stop-ui-hidden');
    document.body.classList.remove('stop-review-open');
    document.getElementById('stop-review-setup')?.classList.remove('initially-hidden');
}

function closeReviewWhenFinished() {
    if (runtime.queue.length || runtime.statusFilter !== 'pending') return;
    closeReviewWorkspace();
    renderMistakeCatalog();
    showToast('Розбір завершено. Скріншоти додано до панелі помилок.');
}

async function renderAll(options = {}) {
    const workspace = mountFullscreenWorkspace();
    if (!workspace) return;
    workspace.classList.add('loading');
    try {
        await refreshData(options);
        rebuildQueue();
        renderSummary();
        renderMistakeCatalog();
        await renderCurrentCard();
    } catch (error) {
        console.error('[Stop review]', error);
        document.getElementById('stop-review-card').innerHTML = `<div class="stop-review-empty">Не вдалося завантажити рев’ю. Застосуйте нову Supabase-міграцію.<br>${escapeHtml(error.message)}</div>`;
    } finally {
        workspace.classList.remove('loading');
    }
}

function bindUI() {
    if (runtime.ready) return;
    const root = document.getElementById('view-stop-errors');
    if (!root) return;
    runtime.ready = true;
    const defaults = monthBounds();
    document.getElementById('stop-review-from').value = defaults.from;
    document.getElementById('stop-review-to').value = defaults.to;
    root.querySelector('[data-stop-review-open]')?.addEventListener('click', () => {
        document.getElementById('stop-review-setup')?.classList.toggle('initially-hidden');
        document.getElementById('stop-review-workspace')?.classList.add('initially-hidden');
    });
    root.querySelectorAll('[data-stop-queue]').forEach(button => button.addEventListener('click', () => {
        root.querySelectorAll('[data-stop-queue]').forEach(item => item.classList.toggle('selected', item === button));
    }));
    root.querySelector('[data-stop-review-start]')?.addEventListener('click', async () => {
        const selected = root.querySelector('[data-stop-queue].selected')?.dataset.stopQueue || 'pending';
        runtime.statusFilter = selected === 'all' ? 'all' : 'pending';
        runtime.skippedReviewIds.clear();
        runtime.index = 0;
        const labels = { pending: 'Нові стопи', all: 'Усі стопи' };
        const range = selectedRange();
        const selection = document.getElementById('stop-review-selection');
        if (selection) selection.textContent = `${labels[selected]} · ${range.from} — ${range.to}`;
        document.getElementById('stop-review-setup')?.classList.add('initially-hidden');
        const workspace = mountFullscreenWorkspace();
        workspace?.classList.remove('initially-hidden');
        workspace?.classList.add('stop-review-fullscreen');
        document.body.classList.add('stop-review-open');
        await renderAll();
    });
    root.querySelector('[data-stop-review-back]')?.addEventListener('click', () => {
        closeReviewWorkspace();
    });
    root.querySelector('[data-stop-ui-toggle]')?.addEventListener('click', event => {
        const workspace = document.getElementById('stop-review-workspace');
        const hidden = workspace?.classList.toggle('stop-ui-hidden') || false;
        event.currentTarget.textContent = hidden ? 'Показати панелі' : 'Сховати панелі';
    });
    root.querySelector('[data-stop-prev]')?.addEventListener('click', () => {
        runtime.index = Math.max(0, runtime.index - 1);
        void renderCurrentCard();
    });
    root.querySelector('[data-stop-next]')?.addEventListener('click', () => {
        runtime.index = Math.min(runtime.queue.length - 1, runtime.index + 1);
        void renderCurrentCard();
    });
}

export function initStopReview() {
    bindUI();
}

export function refreshStopReview() {
    bindUI();
    return renderAll();
}

document.addEventListener('app:shell-ready', initStopReview);
window.addEventListener('journal:error-type-changed', event => {
    void applySharedMistakeChange(event.detail).catch(error => {
        console.error('[Stop review catalog sync]', error);
        showToast(`Не вдалося синхронізувати помилки: ${error.message}`);
    });
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const workspace = document.getElementById('stop-review-workspace');
    if (!workspace?.classList.contains('stop-review-fullscreen')) return;
    closeReviewWorkspace();
    document.getElementById('stop-review-setup')?.classList.remove('initially-hidden');
});
