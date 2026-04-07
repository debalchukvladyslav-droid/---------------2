// === js/settings.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { showToast, showConfirm } from './utils.js';

// --- ПОМИЛКИ ---
export function renderErrorsList() {
    const container = document.getElementById('errors-list-container');
    if (!container) return;
    container.innerHTML = '';
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
    const container = document.getElementById('sidebar-checklist-container'); if (!container) return; let html = ''; 
    let dayData = state.appData?.journal?.[state.selectedDateStr] ?? {}; 
    let checkedItems = dayData.checkedParams || []; 
    (state.appData?.settings?.checklist ?? []).forEach(p => {
        let isChecked = checkedItems.includes(p.id) ? 'checked' : '';
        html += `<div class="error-item" style="padding: 6px 12px; margin-bottom: 0; background: transparent; border-color: var(--border);"><label class="error-label" style="font-size: 0.9rem;"><input type="checkbox" class="daily-param-check checklist-checkbox" value="${p.id}" ${isChecked}><span>${p.name}</span></label></div>`;
    });
    container.innerHTML = html;
}

export function renderSettingsChecklist() {
    const container = document.getElementById('settings-checklist-list'); if (!container) return; let html = '';
    (state.appData?.settings?.checklist ?? []).forEach((p, idx) => { 
        html += `<div class="param-setup-row"><input type="text" class="param-name" id="check-name-${idx}" value="${p.name}" style="flex: 1;"><button class="icon-btn delete" onclick="deleteChecklistItem(${idx})" title="Видалити">❌</button></div>`; 
    });
    container.innerHTML = html;
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
    const container = document.getElementById('sliders-container'); if (!container) return; let html = ''; 
    let dayData = state.appData?.journal?.[state.selectedDateStr] ?? {}; 
    let vals = dayData.sliders || {};
    (state.appData?.settings?.sliders ?? []).forEach(s => {
        let val = vals[s.id] || 5; 
        html += `<div class="slider-row"><label title="${s.name}">${s.name}</label><input type="range" id="slider-${s.id}" class="slider-input" data-id="${s.id}" min="1" max="10" step="1" value="${val}" oninput="document.getElementById('val-${s.id}').innerText = this.value"><div class="slider-val" id="val-${s.id}">${val}</div></div>`;
    });
    container.innerHTML = html;
}

export function renderSettingsSliders() {
    const container = document.getElementById('settings-sliders-list'); if (!container) return; let html = '';
    (state.appData?.settings?.sliders ?? []).forEach((p, idx) => {
        html += `<div class="param-setup-row"><input type="text" class="param-name" id="slider-name-${idx}" value="${p.name}"><button class="icon-btn delete" onclick="deleteSliderItem(${idx})" title="Видалити">❌</button></div>`;
    });
    container.innerHTML = html;
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
    const container = document.getElementById('settings-trade-types-list'); if(!container) return;
    let html = '';
    (state.appData.tradeTypes || []).forEach((t, idx) => {
        html += `<div class="param-setup-row"><input type="text" class="param-name" id="tt-name-${idx}" value="${t}" style="flex: 1;"><button class="icon-btn delete" onclick="deleteTradeType(${idx})">❌</button></div>`;
    });
    container.innerHTML = html;
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
    const container = document.getElementById('my-trade-types-list'); if(!container) return;
    let html = '';
    (state.appData.tradeTypes || []).forEach((t, idx) => {
        html += `<div class="param-setup-row"><input type="text" class="param-name" id="my-tt-name-${idx}" value="${t}" style="flex: 1;"><button class="icon-btn delete" onclick="deleteMyTradeType(${idx})">❌</button></div>`;
    });
    container.innerHTML = html;
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
    const container = document.getElementById('settings-situations-list');
    if (!container) return;
    const situations = state.appData?.settings?.playbookSituations || [];
    let html = '';
    situations.forEach((s, idx) => {
        html += `<div class="param-setup-row"><input type="text" class="param-name" id="sit-name-${idx}" value="${s.name}" style="flex:1;"><button class="icon-btn delete" onclick="deletePlaybookSituation(${idx})">❌</button></div>`;
    });
    container.innerHTML = html;
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