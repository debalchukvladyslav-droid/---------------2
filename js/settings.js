// === js/settings.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
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
    state.appData.settings.checklist.push({ id: 'chk_' + Date.now(), name: 'Новий пункт' }); 
    renderSettingsChecklist(); 
}

export function deleteChecklistItem(idx) { 
    showConfirm("Видалити цей пункт?").then(ok => { if (!ok) return;
        state.appData.settings.checklist.splice(idx, 1); 
        renderSettingsChecklist(); 
    }); 
}

export function saveChecklist() { 
    state.appData.settings.checklist.forEach((p, idx) => { 
        let inputEl = document.getElementById(`check-name-${idx}`);
        if (inputEl) { // Захист: зберігаємо тільки якщо інпут існує
            p.name = inputEl.value; 
        }
    }); 
    saveToLocal().then(() => { 
        renderChecklistDisplay(); 
        showToast('Чекліст збережено!'); 
    }); 
}

// --- ПОВЗУНКИ (ШКАЛИ СТАНУ) ---
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
    state.appData.settings.sliders.push({ id: 'sld_' + Date.now(), name: 'Новий параметр' }); 
    renderSettingsSliders(); 
}

export function deleteSliderItem(idx) { 
    showConfirm("Видалити цю шкалу?").then(ok => { if (!ok) return;
        state.appData.settings.sliders.splice(idx, 1); 
        renderSettingsSliders(); 
    }); 
}

export function saveSlidersSettings() { 
    state.appData.settings.sliders.forEach((p, idx) => { 
        let inputEl = document.getElementById(`slider-name-${idx}`);
        if (inputEl) { // Захист: зберігаємо тільки якщо інпут існує
            p.name = inputEl.value; 
        }
    }); 
    saveToLocal().then(() => { 
        renderSidebarSliders(); 
        showToast('Шкали збережено!'); 
    }); 
}

export function renderSettingsTradeTypes() {
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
    if(!state.appData.tradeTypes) state.appData.tradeTypes = [];
    state.appData.tradeTypes.push('Новий тип'); renderSettingsTradeTypes(); 
}
export function deleteTradeType(idx) { 
    showConfirm("Видалити?").then(ok => { if (!ok) return; state.appData.tradeTypes.splice(idx, 1); renderSettingsTradeTypes(); }); 
}
export function saveTradeTypes() { 
    (state.appData.tradeTypes || []).forEach((t, idx) => { 
        let inputEl = document.getElementById(`tt-name-${idx}`);
        if(inputEl) state.appData.tradeTypes[idx] = inputEl.value; 
    }); 
    saveToLocal().then(() => { showToast('Типи трейдів збережено!'); if(window.selectDate) window.selectDate(state.selectedDateStr); }); 
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
    if(!state.appData.tradeTypes) state.appData.tradeTypes = [];
    state.appData.tradeTypes.push('Новий тип'); renderMyTradeTypes();
}
export function deleteMyTradeType(idx) {
    showConfirm("Видалити?").then(ok => { if (!ok) return; state.appData.tradeTypes.splice(idx, 1); renderMyTradeTypes(); });
}
export function saveMyTradeTypes() {
    (state.appData.tradeTypes || []).forEach((t, idx) => {
        let inputEl = document.getElementById(`my-tt-name-${idx}`);
        if(inputEl) state.appData.tradeTypes[idx] = inputEl.value;
    });
    saveToLocal().then(() => { showToast('Типи трейдів збережено!'); if(window.selectDate) window.selectDate(state.selectedDateStr); });
}

// --- КОНСТРУКТОР СИТУАЦІЙ ПЛЕЙБУКУ ---
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
