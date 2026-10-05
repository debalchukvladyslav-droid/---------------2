import { askJournalAssistant } from './client.js';
import { buildPageContext } from './page_context.js';
import { state } from '../state.js';
import { sanitizeHTML, renderMarkdown } from '../sanitize.js';
import { saveToLocal } from '../storage.js';

let panelBusy = false;

export function initAssistantPanel() {
    if (document.getElementById('journal-ai-panel')) return;
    const root = document.createElement('div');
    root.id = 'journal-ai-root';
    root.innerHTML = `
        <button type="button" id="journal-ai-fab" class="journal-ai-fab" data-action="assistant-toggle" aria-label="Journal AI">AI</button>
        <aside id="journal-ai-panel" class="journal-ai-panel" hidden aria-label="Journal AI">
            <header class="journal-ai-panel__head">
                <div>
                    <div class="journal-ai-panel__kicker">Journal AI</div>
                    <h3 class="journal-ai-panel__title">Запитай журнал</h3>
                </div>
                <button type="button" class="journal-ai-panel__close" data-action="assistant-toggle" aria-label="Закрити">×</button>
            </header>
            <div id="journal-ai-chips" class="journal-ai-chips"></div>
            <div id="journal-ai-box" class="journal-ai-box" role="log" aria-live="polite"></div>
            <div class="journal-ai-compose">
                <input id="journal-ai-input" class="journal-ai-input" type="text" maxlength="2000" placeholder="Ask your journal..." data-action="assistant-input">
                <button type="button" class="btn-primary journal-ai-send" data-action="assistant-send">Send</button>
            </div>
        </aside>
    `;
    document.body.appendChild(root);
    refreshAssistantChips();
    renderAssistantGreeting();
}

export function toggleAssistantPanel(force) {
    const panel = document.getElementById('journal-ai-panel');
    const fab = document.getElementById('journal-ai-fab');
    if (!panel) return;
    const open = typeof force === 'boolean' ? force : panel.hasAttribute('hidden');
    if (open) {
        panel.removeAttribute('hidden');
        fab?.classList.add('is-open');
        refreshAssistantChips();
        document.getElementById('journal-ai-input')?.focus();
    } else {
        panel.setAttribute('hidden', '');
        fab?.classList.remove('is-open');
    }
}

export function refreshAssistantChips() {
    const host = document.getElementById('journal-ai-chips');
    if (!host) return;
    const ctx = buildPageContext();
    const chips = [];
    if (ctx.tradeKey?.ticker || ctx.tab === 'trades') {
        chips.push(
            { label: 'Що не так з цією угодою?', prompt: 'Що зроблено неправильно в цій угоді?' },
            { label: 'Чи хороший стоп?', prompt: 'Оціни stop placement цієї угоди порівняно з подібними.' },
            { label: 'Схожі угоди', prompt: 'Знайди схожі угоди і порівняй результат.' },
        );
    } else if (ctx.date || ctx.tab === 'calendar') {
        chips.push(
            { label: 'Проаналізувати день', prompt: 'Проаналізуй цей торговий день: execution, risk, selectivity, discipline.' },
            { label: 'Головна помилка', prompt: 'Яка головна помилка цього дня і що змінити завтра?' },
        );
    } else {
        chips.push(
            { label: 'Тижневий розбір', prompt: 'Чому я останній тиждень торгую гірше? Порівняй з попередніми 30 днями.' },
            { label: 'Ризик зараз', prompt: 'Який мій поточний risk state і який ризик рекомендуєш сьогодні?' },
            { label: 'Після 08:00', prompt: 'Як я торгую після 08:00 порівняно з ранком?' },
        );
    }
    host.innerHTML = chips.map((chip) => (
        `<button type="button" class="journal-ai-chip" data-action="assistant-chip" data-assistant-prompt="${escapeAttr(chip.prompt)}">${escapeHtml(chip.label)}</button>`
    )).join('');
}

export function applyAssistantChip(prompt) {
    const input = document.getElementById('journal-ai-input');
    if (!input || !prompt) return;
    input.value = prompt;
    input.focus();
    void sendAssistantPanelMessage();
}

export async function sendAssistantPanelMessage() {
    const input = document.getElementById('journal-ai-input');
    const box = document.getElementById('journal-ai-box');
    if (!input || !box || panelBusy) return;
    const userText = input.value.trim();
    if (!userText) return;

    input.value = '';
    panelBusy = true;
    setPanelBusy(true);
    appendPanelMessage('user', userText);
    const typing = appendPanelMessage('ai', '<em>Аналізую журнал...</em>', { html: true, temporary: true });

    try {
        const history = (state.appData.aiChatHistory || []).slice(-12);
        const result = await askJournalAssistant({
            message: userText,
            history,
            pageContext: buildPageContext(),
        });
        typing.remove();
        const answerHtml = renderMarkdown(result.answer || '');
        appendPanelMessage('ai', answerHtml, { html: true });
        appendUiHints(box, result.uiHints || []);
        pushHistory(userText, answerHtml);
        syncDataChatMirror(userText, answerHtml);
    } catch (error) {
        typing.remove();
        appendPanelMessage('ai', `<span style="color:var(--loss)">⚠️ ${sanitizeHTML(error.message || 'Помилка AI')}</span>`, { html: true });
    } finally {
        panelBusy = false;
        setPanelBusy(false);
        input.focus();
    }
}

export function applyAssistantUiHint(hint) {
    if (!hint || typeof hint !== 'object') return;
    if (hint.type === 'open_day' && hint.date && window.selectDate) {
        window.switchMainTab?.('calendar');
        window.selectDate(hint.date);
        return;
    }
    if (hint.type === 'open_trade') {
        window.switchMainTab?.('trades');
        if (hint.date && window.openTradesAtDayIndex) {
            const index = Number.isFinite(Number(hint.tradeIndex)) ? Number(hint.tradeIndex) : 0;
            window.openTradesAtDayIndex(hint.date, index);
        } else if (hint.date && window.selectDate) {
            window.selectDate(hint.date);
        }
    }
}

function renderAssistantGreeting() {
    const box = document.getElementById('journal-ai-box');
    if (!box || box.childElementCount) return;
    appendPanelMessage('ai', 'Привіт. Я можу читати твої угоди, дні, статистику та ризик через інструменти журналу. Що перевірити?');
}

function appendPanelMessage(role, content, { html = false, temporary = false } = {}) {
    const box = document.getElementById('journal-ai-box');
    if (!box) return null;
    const el = document.createElement('div');
    el.className = `chat-msg ${role === 'user' ? 'user-msg' : 'ai-msg'}`;
    if (temporary) el.dataset.temporary = '1';
    if (html) el.innerHTML = content;
    else el.textContent = content;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
}

function appendUiHints(box, hints) {
    if (!box || !hints.length) return;
    const row = document.createElement('div');
    row.className = 'journal-ai-hints';
    for (const hint of hints.slice(0, 4)) {
        const label = hint.type === 'open_day'
            ? `Відкрити день ${hint.date || ''}`.trim()
            : hint.type === 'open_trade'
                ? `Відкрити угоду ${hint.date || ''}`.trim()
                : 'Відкрити в журналі';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'journal-ai-hint';
        btn.textContent = label;
        btn.dataset.action = 'assistant-ui-hint';
        btn.dataset.hint = JSON.stringify(hint);
        row.appendChild(btn);
    }
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
}

function setPanelBusy(isBusy) {
    const input = document.getElementById('journal-ai-input');
    const send = document.querySelector('[data-action="assistant-send"]');
    if (input) input.disabled = isBusy;
    if (send) {
        send.disabled = isBusy;
        send.textContent = isBusy ? '...' : 'Send';
    }
}

function pushHistory(userText, aiHtml) {
    if (!state.appData.aiChatHistory) state.appData.aiChatHistory = [];
    state.appData.aiChatHistory.push({ role: 'user', text: userText });
    state.appData.aiChatHistory.push({ role: 'ai', text: aiHtml });
    state.appData.aiChatHistory = state.appData.aiChatHistory.slice(-40);
    saveToLocal();
}

function syncDataChatMirror(userText, aiHtml) {
    const chatBox = document.getElementById('data-chat-box');
    if (!chatBox) return;
    const userMsg = document.createElement('div');
    userMsg.className = 'chat-msg user-msg';
    userMsg.textContent = userText;
    chatBox.appendChild(userMsg);
    const aiMsg = document.createElement('div');
    aiMsg.className = 'chat-msg ai-msg';
    aiMsg.innerHTML = `<strong>AI Аналітик:</strong><br>${aiHtml}`;
    chatBox.appendChild(aiMsg);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
}
