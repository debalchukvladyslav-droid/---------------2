// === js/settings.js ===
import { state } from './state.js';
import { markJournalDayDirty, saveToLocal } from './storage.js';
import { showToast, showConfirm } from './utils.js';

function clearNode(node) {
    if (node) node.textContent = '';
}

function createDeleteButton(onClick, title = 'Видалити') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn delete';
    btn.title = title;
    btn.textContent = '×';
    btn.addEventListener('click', onClick);
    return btn;
}

function createParamSetupRow({ inputId, value, onDelete, flex = false, title = 'Видалити' }) {
    const row = document.createElement('div');
    row.className = 'param-setup-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'param-name';
    input.id = inputId;
    input.value = value ?? '';
    if (flex) input.style.flex = '1';

    row.appendChild(input);
    row.appendChild(createDeleteButton(onDelete, title));
    return row;
}

function ensureSettingsCollections() {
    if (!state.appData) state.appData = {};
    if (!state.appData.settings) state.appData.settings = {};
    if (!Array.isArray(state.appData.settings.checklist)) state.appData.settings.checklist = [];
    if (!Array.isArray(state.appData.settings.sliders)) state.appData.settings.sliders = [];
    if (!Array.isArray(state.appData.tradeTypes)) state.appData.tradeTypes = [];
}

function parseOptionalNumber(value) {
    return value && !isNaN(value) ? parseFloat(value) : null;
}

function commitVisibleDayFormInputs() {
    if (!state.selectedDateStr || state.dayDetailsLoading) return;
    const pnlEl = document.getElementById('trade-pnl');
    const notesEl = document.getElementById('trade-notes');
    if (!pnlEl || !notesEl) return;

    const checklist = [];
    document.querySelectorAll('.checklist-checkbox:checked').forEach((el) => {
        if (el.value) checklist.push(el.value);
    });

    const sliders = Object.create(null);
    document.querySelectorAll('.slider-input').forEach((el) => {
        const key = el.dataset.id || (el.id ? el.id.replace('slider-', '') : '');
        if (key && !Object.prototype.hasOwnProperty.call(Object.prototype, key)) sliders[key] = el.value;
    });

    const tradeTypesData = Object.create(null);
    document.querySelectorAll('.tt-input-pnl').forEach((el) => {
        const name = el.getAttribute('data-name');
        if (!name || Object.prototype.hasOwnProperty.call(Object.prototype, name)) return;
        const kfInput = document.querySelector(`.tt-input-kf[data-name="${CSS.escape(name)}"]`);
        tradeTypesData[name] = { pnl: el.value, kf: kfInput ? kfInput.value : '' };
    });

    const oldData = state.appData.journal[state.selectedDateStr] || {};
    state.appData.journal[state.selectedDateStr] = {
        ...oldData,
        pnl: parseOptionalNumber(pnlEl.value),
        gross_pnl: parseOptionalNumber(document.getElementById('trade-gross')?.value),
        commissions: parseOptionalNumber(document.getElementById('trade-comm')?.value),
        locates: parseOptionalNumber(document.getElementById('trade-locates')?.value),
        kf: parseOptionalNumber(document.getElementById('trade-kf')?.value),
        notes: notesEl.value || '',
        errors: [...document.querySelectorAll('.error-checkbox:checked')].map((el) => el.value),
        checkedParams: checklist,
        sliders,
        tradeTypesData,
        sessionGoal: document.getElementById('session-goal')?.value ?? oldData.sessionGoal,
        sessionPlan: document.getElementById('session-plan')?.value ?? oldData.sessionPlan,
        sessionReadiness: document.getElementById('session-readiness')?.value ?? oldData.sessionReadiness,
        __detailsLoaded: true,
    };
    markJournalDayDirty(state.selectedDateStr);
}

function markJournalDateDirtyIfLoaded(dateStr, day) {
    if (day?.__detailsLoaded !== false) markJournalDayDirty(dateStr);
}

function renameTradeTypeData(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    Object.entries(state.appData.journal || {}).forEach(([dateStr, day]) => {
        if (!day?.tradeTypesData || typeof day.tradeTypesData !== 'object') return;
        if (!Object.prototype.hasOwnProperty.call(day.tradeTypesData, oldName)) return;
        if (!Object.prototype.hasOwnProperty.call(day.tradeTypesData, newName)) {
            day.tradeTypesData[newName] = day.tradeTypesData[oldName];
        }
        delete day.tradeTypesData[oldName];
        markJournalDateDirtyIfLoaded(dateStr, day);
    });
}

function commitVisibleChecklistInputs() {
    ensureSettingsCollections();
    state.appData.settings.checklist.forEach((p, idx) => {
        const inputEl = document.getElementById(`check-name-${idx}`);
        if (inputEl) p.name = inputEl.value.trim() || p.name || `Пункт ${idx + 1}`;
    });
}

function commitVisibleSliderInputs() {
    ensureSettingsCollections();
    state.appData.settings.sliders.forEach((p, idx) => {
        const inputEl = document.getElementById(`slider-name-${idx}`);
        if (inputEl) p.name = inputEl.value.trim() || p.name || `Шкала ${idx + 1}`;
    });
}

function commitVisibleTradeTypeInputs() {
    ensureSettingsCollections();
    state.appData.tradeTypes.forEach((t, idx) => {
        const inputEl = document.getElementById(`my-tt-name-${idx}`) || document.getElementById(`tt-name-${idx}`);
        if (inputEl) {
            const nextName = inputEl.value.trim() || t || `Тип ${idx + 1}`;
            renameTradeTypeData(t, nextName);
            state.appData.tradeTypes[idx] = nextName;
        }
    });
}

function pruneRemovedFieldData() {
    ensureSettingsCollections();
    const checklistIds = new Set(state.appData.settings.checklist.map((p) => p.id).filter(Boolean));
    const sliderIds = new Set(state.appData.settings.sliders.map((p) => p.id).filter(Boolean));
    const tradeTypes = new Set(state.appData.tradeTypes.filter(Boolean));
    Object.entries(state.appData.journal || {}).forEach(([dateStr, day]) => {
        if (!day || typeof day !== 'object') return;
        let changed = false;
        if (Array.isArray(day.checkedParams)) {
            const nextCheckedParams = day.checkedParams.filter((id) => checklistIds.has(id));
            if (nextCheckedParams.length !== day.checkedParams.length) {
                day.checkedParams = nextCheckedParams;
                changed = true;
            }
        }
        if (day.sliders && typeof day.sliders === 'object') {
            Object.keys(day.sliders).forEach((id) => {
                if (!sliderIds.has(id)) {
                    delete day.sliders[id];
                    changed = true;
                }
            });
        }
        if (day.tradeTypesData && typeof day.tradeTypesData === 'object') {
            Object.keys(day.tradeTypesData).forEach((name) => {
                if (!tradeTypes.has(name)) {
                    delete day.tradeTypesData[name];
                    changed = true;
                }
            });
        }
        if (changed) markJournalDateDirtyIfLoaded(dateStr, day);
    });
}

function refreshFieldEditorsAndDayForm() {
    renderSettingsChecklist();
    renderSettingsSliders();
    renderSettingsTradeTypes();
    renderMyTradeTypes();
    renderChecklistDisplay();
    renderSidebarSliders();
    if (window.selectDate && state.selectedDateStr) window.selectDate(state.selectedDateStr, true);
    if (window.renderTradeTypeSelector) window.renderTradeTypeSelector();
    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
}

function persistFieldChanges(message) {
    commitVisibleDayFormInputs();
    pruneRemovedFieldData();
    refreshFieldEditorsAndDayForm();
    return saveToLocal().then(() => {
        if (message) showToast(message);
    });
}

// --- ПОМИЛКИ ---
export function renderErrorsList() {
    const container = document.getElementById('errors-list-container');
    if (!container) return;
    clearNode(container);
    (state.appData?.errorTypes ?? []).forEach((err, index) => {
        const item = document.createElement('div');
        item.className = 'error-item';

        const label = document.createElement('label');
        label.className = 'error-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'error-checkbox';
        checkbox.id = `err-${index}`;
        checkbox.value = err;

        const span = document.createElement('span');
        span.textContent = err;

        label.appendChild(checkbox);
        label.appendChild(span);

        const actions = document.createElement('div');
        actions.className = 'error-actions';

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn delete';
        delBtn.textContent = '❌';
        delBtn.onclick = () => deleteErrorType(index);

        actions.appendChild(delBtn);
        item.appendChild(label);
        item.appendChild(actions);
        container.appendChild(item);
    });
    if (window.selectDate) window.selectDate(state.selectedDateStr, true);
}

export function addNewErrorType() { 
    const input = document.getElementById('new-error-input'); const val = input.value.trim(); 
    if (val && !state.appData.errorTypes.includes(val)) { 
        state.appData.errorTypes.push(val); 
        input.value = ''; 
        renderErrorsList(); 
        saveToLocal(); 
    } 
}

export function deleteErrorType(index) { 
    showConfirm(`Видалити "${state.appData.errorTypes[index]}"?`).then(ok => { if (!ok) return;
        state.appData.errorTypes.splice(index, 1); 
        saveToLocal(); 
        renderErrorsList(); 
    }); 
}

// --- ЧЕКЛІСТИ ---
export function renderChecklistDisplay() {
    const safeContainer = document.getElementById('sidebar-checklist-container');
    if (!safeContainer) return;
    clearNode(safeContainer);
    const safeDayData = state.appData?.journal?.[state.selectedDateStr] ?? {};
    const safeCheckedItems = safeDayData.checkedParams || [];
    (state.appData?.settings?.checklist ?? []).forEach((p) => {
        const item = document.createElement('div');
        item.className = 'error-item';
        item.style.cssText = 'padding: 6px 12px; margin-bottom: 0; background: transparent; border-color: var(--border);';

        const label = document.createElement('label');
        label.className = 'error-label';
        label.style.fontSize = '0.9rem';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'daily-param-check checklist-checkbox';
        checkbox.value = p.id ?? '';
        checkbox.checked = safeCheckedItems.includes(p.id);

        const span = document.createElement('span');
        span.textContent = p.name ?? '';

        label.appendChild(checkbox);
        label.appendChild(span);
        item.appendChild(label);
        safeContainer.appendChild(item);
    });
}

export function renderSettingsChecklist() {
    ensureSettingsCollections();
    const safeContainer = document.getElementById('settings-checklist-list');
    if (!safeContainer) return;
    clearNode(safeContainer);
    (state.appData?.settings?.checklist ?? []).forEach((p, idx) => {
        safeContainer.appendChild(createParamSetupRow({
            inputId: `check-name-${idx}`,
            value: p.name,
            flex: true,
            onDelete: () => deleteChecklistItem(idx),
        }));
    });
}


export function addNewChecklistItem() {
    commitVisibleChecklistInputs();
    state.appData.settings.checklist.push({ id: 'chk_' + Date.now(), name: 'Новий пункт' });
    persistFieldChanges('Поле додано');
}


export function deleteChecklistItem(idx) {
    showConfirm('Видалити цей пункт?').then(ok => {
        if (!ok) return;
        commitVisibleChecklistInputs();
        state.appData.settings.checklist.splice(idx, 1);
        persistFieldChanges('Поле видалено');
    });
}


export function saveChecklist() {
    commitVisibleChecklistInputs();
    persistFieldChanges('Чекліст збережено');
}

export function renderSidebarSliders() {
    const safeContainer = document.getElementById('sliders-container');
    if (!safeContainer) return;
    clearNode(safeContainer);
    const safeDayData = state.appData?.journal?.[state.selectedDateStr] ?? {};
    const safeVals = safeDayData.sliders || {};
    (state.appData?.settings?.sliders ?? []).forEach((s) => {
        const val = safeVals[s.id] || 5;
        const row = document.createElement('div');
        row.className = 'slider-row';

        const label = document.createElement('label');
        label.title = s.name ?? '';
        label.textContent = s.name ?? '';

        const input = document.createElement('input');
        input.type = 'range';
        input.id = `slider-${s.id}`;
        input.className = 'slider-input';
        input.dataset.id = s.id ?? '';
        input.min = '1';
        input.max = '10';
        input.step = '1';
        input.value = val;

        const value = document.createElement('div');
        value.className = 'slider-val';
        value.id = `val-${s.id}`;
        value.textContent = val;

        input.addEventListener('input', () => {
            value.textContent = input.value;
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(value);
        safeContainer.appendChild(row);
    });
}

export function renderSettingsSliders() {
    ensureSettingsCollections();
    const safeContainer = document.getElementById('settings-sliders-list');
    if (!safeContainer) return;
    clearNode(safeContainer);
    (state.appData?.settings?.sliders ?? []).forEach((p, idx) => {
        safeContainer.appendChild(createParamSetupRow({
            inputId: `slider-name-${idx}`,
            value: p.name,
            onDelete: () => deleteSliderItem(idx),
        }));
    });
}


export function addNewSliderItem() {
    commitVisibleSliderInputs();
    state.appData.settings.sliders.push({ id: 'sld_' + Date.now(), name: 'Новий параметр' });
    persistFieldChanges('Шкалу додано');
}


export function deleteSliderItem(idx) {
    showConfirm('Видалити цю шкалу?').then(ok => {
        if (!ok) return;
        commitVisibleSliderInputs();
        state.appData.settings.sliders.splice(idx, 1);
        persistFieldChanges('Шкалу видалено');
    });
}


export function saveSlidersSettings() {
    commitVisibleSliderInputs();
    persistFieldChanges('Шкали збережено');
}

export function renderSettingsTradeTypes() {
    ensureSettingsCollections();
    const safeContainer = document.getElementById('settings-trade-types-list');
    if (!safeContainer) return;
    clearNode(safeContainer);
    (state.appData.tradeTypes || []).forEach((t, idx) => {
        safeContainer.appendChild(createParamSetupRow({
            inputId: `tt-name-${idx}`,
            value: t,
            flex: true,
            onDelete: () => deleteTradeType(idx),
        }));
    });
}

export function addNewTradeType() {
    commitVisibleTradeTypeInputs();
    state.appData.tradeTypes.push('Новий тип');
    persistFieldChanges('Тип додано');
}


export function deleteTradeType(idx) {
    showConfirm('Видалити?').then(ok => {
        if (!ok) return;
        commitVisibleTradeTypeInputs();
        state.appData.tradeTypes.splice(idx, 1);
        persistFieldChanges('Тип видалено');
    });
}


export function saveTradeTypes() {
    commitVisibleTradeTypeInputs();
    persistFieldChanges('Типи трейдів збережено');
}

export function renderMyTradeTypes() {
    const safeContainer = document.getElementById('my-trade-types-list');
    if (!safeContainer) return;
    clearNode(safeContainer);
    (state.appData.tradeTypes || []).forEach((t, idx) => {
        safeContainer.appendChild(createParamSetupRow({
            inputId: `my-tt-name-${idx}`,
            value: t,
            flex: true,
            onDelete: () => deleteMyTradeType(idx),
        }));
    });
}

export function addMyTradeType() {
    commitVisibleTradeTypeInputs();
    state.appData.tradeTypes.push('Новий тип');
    persistFieldChanges('Тип додано');
}


export function deleteMyTradeType(idx) {
    showConfirm('Видалити?').then(ok => {
        if (!ok) return;
        commitVisibleTradeTypeInputs();
        state.appData.tradeTypes.splice(idx, 1);
        persistFieldChanges('Тип видалено');
    });
}


export function saveMyTradeTypes() {
    commitVisibleTradeTypeInputs();
    persistFieldChanges('Типи трейдів збережено');
}

export function renderSettingsSituations() {
    const safeContainer = document.getElementById('settings-situations-list');
    if (!safeContainer) return;
    clearNode(safeContainer);
    const safeSituations = state.appData?.settings?.playbookSituations || [];
    safeSituations.forEach((s, idx) => {
        safeContainer.appendChild(createParamSetupRow({
            inputId: `sit-name-${idx}`,
            value: s.name,
            flex: true,
            onDelete: () => deletePlaybookSituation(idx),
        }));
    });
}

export function addPlaybookSituation() {
    if (!state.appData.settings.playbookSituations) state.appData.settings.playbookSituations = [];
    state.appData.settings.playbookSituations.push({ id: 'sit_' + Date.now(), name: 'Нова ситуація' });
    renderSettingsSituations();
}

export function deletePlaybookSituation(idx) {
    showConfirm('Видалити цю ситуацію?').then(ok => {
        if (!ok) return;
        state.appData.settings.playbookSituations.splice(idx, 1);
        renderSettingsSituations();
    });
}

export function savePlaybookSituations() {
    (state.appData.settings.playbookSituations || []).forEach((s, idx) => {
        const el = document.getElementById(`sit-name-${idx}`);
        if (el) s.name = el.value;
    });
    saveToLocal().then(() => showToast('Ситуації збережено!'));
}
