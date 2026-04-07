// === js/playbook.js ===
import { state } from './state.js';
import { saveToLocal } from './storage.js';
import { initSetupChart, getChartData } from './playbook_chart.js';
function getPlaybookStorageKey(nick) {
    return `pj:${nick}:playbook`;
}

// ── Playbook is stored in its own document: journal/{nick}_playbook ──
// This keeps it out of the main _stats document which is fetched on every load.

export async function loadPlaybook() {
    const nick = state.USER_DOC_NAME;
    if (!nick) return;
    try {
        const raw = localStorage.getItem(getPlaybookStorageKey(nick));
        state.appData.playbook = raw ? (JSON.parse(raw) || []) : [];
    } catch (e) {
        console.warn('loadPlaybook error:', e.message);
        state.appData.playbook = state.appData.playbook || [];
    }
}

async function savePlaybook() {
    const nick = state.USER_DOC_NAME;
    if (!nick) return;
    if (state.CURRENT_VIEWED_USER !== nick) return;
    localStorage.setItem(getPlaybookStorageKey(nick), JSON.stringify(state.appData.playbook || []));
}

function getPlaybook() {
    if (!state.appData.playbook) state.appData.playbook = [];
    return state.appData.playbook;
}

export function renderPlaybook() {
    const container = document.getElementById('playbook-list');
    if (!container) return;
    const playbook = getPlaybook();

    if (playbook.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:40px;">Плейбук порожній. Додайте перший сетап.</div>';
        return;
    }

    container.innerHTML = playbook.map((setup, idx) => `
        <div class="playbook-item" id="playbook-item-${idx}">
            <div class="playbook-header">
                <span class="playbook-name">${setup.name}</span>
                <div style="display:flex; gap:8px;">
                    <button class="btn-secondary" style="width:auto; padding:4px 10px; margin:0;" onclick="window.editPlaybookSetup?.(${idx})">✏️</button>
                    <button class="btn-secondary" style="width:auto; padding:4px 10px; margin:0; border-color:var(--loss); color:var(--loss);" onclick="window.deletePlaybookSetup?.(${idx})">🗑️</button>
                </div>
            </div>
            <div class="playbook-desc" id="playbook-desc-${idx}">${setup.description.replace(/\n/g, '<br>')}</div>
        </div>
    `).join('');
}

export function addPlaybookSetup() {
    const playbook = getPlaybook();
    playbook.push({ name: 'Новий сетап', description: '', situations: [] });
    savePlaybook().then(() => { renderPlaybook(); editPlaybookSetup(playbook.length - 1); });
}

export function editPlaybookSetup(idx) {
    const playbook = getPlaybook();
    const setup = playbook[idx];
    const item = document.getElementById(`playbook-item-${idx}`);
    if (!item) return;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; flex-direction:column; gap:10px;';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = `playbook-edit-name-${idx}`;
    nameInput.placeholder = 'Назва сетапу';
    nameInput.style.cssText = 'margin:0; font-weight:bold;';
    nameInput.value = setup.name;

    const descArea = document.createElement('textarea');
    descArea.id = `playbook-edit-desc-${idx}`;
    descArea.rows = 6;
    descArea.placeholder = 'Опишіть умови входу, ознаки сетапу, правила управління позицією...';
    descArea.style.cssText = 'margin:0;';
    descArea.value = setup.description;

    // Situations selector
    const situations = state.appData?.settings?.playbookSituations || [];
    const sitWrap = document.createElement('div');
    sitWrap.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    if (situations.length > 0) {
        const sitLabel = document.createElement('div');
        sitLabel.style.cssText = 'font-size:0.85rem; color:var(--text-muted);';
        sitLabel.textContent = 'Ситуації:';
        sitWrap.appendChild(sitLabel);
        const sitGrid = document.createElement('div');
        sitGrid.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
        situations.forEach(sit => {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex; align-items:center; gap:5px; padding:4px 10px; border-radius:6px; background:var(--bg-main); border:1px solid var(--border); cursor:pointer; font-size:0.85rem;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = sit.id;
            cb.className = `playbook-sit-check-${idx}`;
            cb.checked = (setup.situations || []).includes(sit.id);
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(sit.name));
            sitGrid.appendChild(lbl);
        });
        sitWrap.appendChild(sitGrid);
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:8px;';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary';
    saveBtn.style.cssText = 'width:auto; margin:0;';
    saveBtn.textContent = '💾 Зберегти';
    saveBtn.onclick = () => window.savePlaybookSetup?.(idx);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.style.cssText = 'width:auto; margin:0;';
    cancelBtn.textContent = 'Скасувати';
    cancelBtn.onclick = () => window.renderPlaybook?.();

    // Chart Constructor
    const chartSection = document.createElement('div');
    chartSection.style.cssText = 'border-top:1px solid var(--border); padding-top:10px; margin-top:4px;';
    chartSection.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
            <span style="font-size:0.85rem; color:var(--text-muted);">🎨 Chart Constructor</span>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn-secondary" id="pbc-hline-btn-${idx}" style="width:auto; margin:0; padding:4px 10px; font-size:0.8rem;">📏 H-Line</button>
                <button class="btn-secondary" id="pbc-tline-btn-${idx}" style="width:auto; margin:0; padding:4px 10px; font-size:0.8rem;">📐 Trendline</button>
            </div>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
            <label style="font-size:0.8rem; color:var(--text-muted);">Свічок: <strong id="pbc-candles-val-${idx}">30</strong></label>
            <input type="range" id="pbc-candles-${idx}" min="10" max="150" value="30" style="width:120px;" oninput="document.getElementById('pbc-candles-val-${idx}').textContent=this.value">
            <label style="font-size:0.8rem; color:var(--text-muted);">Волатильність: <strong id="pbc-vol-val-${idx}">3</strong></label>
            <input type="range" id="pbc-volatility-${idx}" min="1" max="10" value="3" style="width:100px;" oninput="document.getElementById('pbc-vol-val-${idx}').textContent=this.value">
            <button class="btn-secondary" id="pbc-clear-btn-${idx}" style="width:auto; margin:0; padding:4px 10px; font-size:0.8rem;">🗑 Очистити</button>
            <button class="btn-primary" id="pbc-generate-btn-${idx}" style="width:auto; margin:0; padding:4px 10px; font-size:0.8rem;">⚡ Генерувати</button>
        </div>
        <div class="pbc-canvas-wrap">
            <p class="pbc-hint">✏️ Намалюйте траєкторію ціни мишею</p>
            <canvas id="pbc-canvas-${idx}"></canvas>
        </div>
        <div id="pbc-chart-section-${idx}" style="display:none; margin-top:12px;">
            <div id="pbc-lw-container-${idx}" style="width:100%; border-radius:8px; overflow:hidden;"></div>
            <div id="pbc-editor-panel-${idx}" style="display:none; margin-top:10px; padding:12px; background:var(--bg-main); border:1px solid var(--border); border-radius:8px; flex-wrap:wrap; gap:8px; align-items:flex-end;">
                <span style="color:var(--text-muted); font-size:0.8rem; width:100%;">✏️ Редагувати свічку (клікніть на свічку вище)</span>
                <div class="pbc-ohlc-inputs">
                    <div class="pbc-ohlc-field"><label>Open</label><input type="number" id="pbc-edit-o-${idx}" step="0.01"></div>
                    <div class="pbc-ohlc-field"><label>High</label><input type="number" id="pbc-edit-h-${idx}" step="0.01"></div>
                    <div class="pbc-ohlc-field"><label>Low</label><input type="number" id="pbc-edit-l-${idx}" step="0.01"></div>
                    <div class="pbc-ohlc-field"><label>Close</label><input type="number" id="pbc-edit-c-${idx}" step="0.01"></div>
                </div>
                <button class="btn-primary" id="pbc-save-candle-btn-${idx}" style="width:auto; margin:0;">💾 Зберегти свічку</button>
            </div>
        </div>
    `;

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    wrapper.appendChild(nameInput);
    wrapper.appendChild(descArea);
    if ((state.appData?.settings?.playbookSituations || []).length > 0) wrapper.appendChild(sitWrap);
    wrapper.appendChild(chartSection);
    wrapper.appendChild(btnRow);

    item.innerHTML = '';
    item.appendChild(wrapper);
    nameInput.focus();
    // Ініціалізуємо конструктор після рендеру DOM
    requestAnimationFrame(() => initSetupChart(idx, setup.chartData || null));
}

export function savePlaybookSetup(idx) {
    const playbook = getPlaybook();
    const name = document.getElementById(`playbook-edit-name-${idx}`)?.value.trim();
    const desc = document.getElementById(`playbook-edit-desc-${idx}`)?.value.trim();
    if (!name) {
        const input = document.getElementById(`playbook-edit-name-${idx}`);
        if (input) { input.style.border = '1px solid var(--loss,#ef4444)'; input.focus(); }
        return;
    }
    const situations = [...document.querySelectorAll(`.playbook-sit-check-${idx}:checked`)].map(cb => cb.value);
    const chartData = getChartData(idx);
    playbook[idx] = { name, description: desc, situations, chartData: chartData || playbook[idx]?.chartData || null };
    savePlaybook().then(() => renderPlaybook());
}

export function deletePlaybookSetup(idx) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:24px 28px;max-width:320px;width:90%;text-align:center;';
    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 20px;color:var(--text-main,#f8fafc);font-size:1rem;';
    msg.textContent = 'Видалити цей сетап?';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
    const btnYes = document.createElement('button');
    btnYes.textContent = 'Видалити';
    btnYes.style.cssText = 'padding:8px 22px;border-radius:8px;border:none;background:var(--loss,#ef4444);color:#fff;cursor:pointer;font-size:0.95rem;';
    btnYes.onclick = () => {
        overlay.remove();
        const playbook = getPlaybook();
        playbook.splice(idx, 1);
        savePlaybook().then(() => renderPlaybook());
    };
    const btnNo = document.createElement('button');
    btnNo.textContent = 'Скасувати';
    btnNo.style.cssText = 'padding:8px 22px;border-radius:8px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-main,#f8fafc);cursor:pointer;font-size:0.95rem;';
    btnNo.onclick = () => overlay.remove();
    btnRow.appendChild(btnYes); btnRow.appendChild(btnNo);
    box.appendChild(msg); box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

export function getPlaybookContext() {
    const playbook = getPlaybook();
    if (!playbook.length) return '';
    const situations = state.appData?.settings?.playbookSituations || [];
    return '\n\nМІЙ ПЛЕЙБУК СЕТАПІВ (дуже важливо: порівнюй візуальний патерн графіка з описом сетапу):\n' + playbook.map((s, i) => {
        let sitNames = (s.situations || []).map(id => situations.find(x => x.id === id)?.name).filter(Boolean);
        let sitLine = sitNames.length ? `\n   Ситуації: ${sitNames.join(', ')}` : '';
        let chartLine = '';
        if (s.chartData?.ohlcData?.length) {
            const cd = s.chartData.ohlcData;
            const first = cd[0], last = cd[cd.length - 1];
            const trend = last.close > first.open ? 'зростаючий' : 'падаючий';
            const highs = cd.map(c => c.high); const lows = cd.map(c => c.low);
            const maxH = Math.max(...highs), minL = Math.min(...lows);
            const range = (maxH - minL).toFixed(4);
            // Визначаємо структуру руху
            const midIdx = Math.floor(cd.length / 2);
            const firstHalf = cd.slice(0, midIdx);
            const secondHalf = cd.slice(midIdx);
            const avgFirst = firstHalf.reduce((s, c) => s + c.close, 0) / firstHalf.length;
            const avgSecond = secondHalf.reduce((s, c) => s + c.close, 0) / secondHalf.length;
            const structure = avgSecond > avgFirst ? 'прискорення вгору' : 'прискорення вниз';
            chartLine = `\n   Візуальний патерн (конструктор): ${cd.length} свічок, тренд ${trend}, структура — ${structure}, діапазон ${range}`;
        }
        return `${i+1}. ${s.name}:${sitLine}${chartLine}\n${s.description}`;
    }).join('\n\n');
}

export function getPlaybookForSituation(situationId) {
    const playbook = getPlaybook();
    return playbook.filter(s => (s.situations || []).includes(situationId));
}
