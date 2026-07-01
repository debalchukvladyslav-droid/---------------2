// === js/ai.js ===
import { state } from './state.js';
import { saveJournalData, saveToLocal, markJournalDayDirty } from './storage.js';
import { getImgUrl, getStorageUrl } from './gallery.js';
import { getGeminiKeys, callGemini, callGeminiViaProxy, callGeminiJSON, sleep } from './ai/client.js';
import { sanitizeHTML, sanitizeRichHTML } from './sanitize.js';
import { buildTradeTypeAIContext, buildDayTradeTypeAIContext } from './trade_type_analysis.js';
import { isNotTakenTrade } from './data_utils.js';

export { getGeminiKeys, callGemini, callGeminiViaProxy, callGeminiJSON, sleep };

const sanitizeAIHtml = sanitizeRichHTML;

let sosChatHistory = []; 
let dataChatHistory = [];

const AI_QUICK_PROMPTS = {
    weekly: 'Зроби короткий тижневий звіт: що тягне результат, що ламає дисципліну, які 3 правила взяти на наступний тиждень.',
    mistakes: 'Знайди мої повторювані помилки за останні угоди. Розділи на технічні, ризикові та психологічні.',
    risk: 'Оціни мій ризик-менеджмент: дейлос, серії мінусів, розмір збитків і моменти, де я міг перегинати.',
    setups: 'Порівняй мої типи входів і сетапи. Які варто форсити, які краще фільтрувати або тимчасово прибрати?'
};

function formatAIResponse(text) {
    return sanitizeAIHtml(sanitizeHTML(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^### (.*$)/gm, '<h4>$1</h4>')
        .replace(/^## (.*$)/gm, '<h3>$1</h3>')
        .replace(/^- (.*$)/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
        .replace(/\n/g, '<br>'));
}

function setDataChatBusy(isBusy) {
    const inputEl = document.getElementById('data-chat-input');
    const sendBtn = document.querySelector('[data-action="data-chat-send"]');
    if (inputEl) inputEl.disabled = isBusy;
    if (sendBtn) {
        sendBtn.disabled = isBusy;
        sendBtn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
        sendBtn.textContent = isBusy ? 'Думаю...' : 'Відправити';
    }
}

function makeAIChatBubble(userText, aiHtml) {
    const wrapperDiv = document.createElement('div');
    wrapperDiv.className = 'ai-chat-answer';

    const aiMsgDiv = document.createElement('div');
    aiMsgDiv.className = 'chat-msg ai-msg';
    aiMsgDiv.innerHTML = `<strong>🤖 AI Аналітик:</strong><br>${aiHtml}`;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save-icon';
    saveBtn.type = 'button';
    saveBtn.innerHTML = '🔖';
    saveBtn.title = 'Зберегти / видалити закладку';
    saveBtn.onclick = () => {
        bookmarkAIChat(userText, aiHtml, saveBtn);
    };

    wrapperDiv.appendChild(aiMsgDiv);
    wrapperDiv.appendChild(saveBtn);
    return wrapperDiv;
}

function buildAIJournalForPrompt(journal = {}) {
    const output = {};
    for (const [dateStr, day] of Object.entries(journal || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
        const nextDay = { ...(day || {}) };
        if (Array.isArray(day?.trades)) {
            nextDay.trades = day.trades.map((trade) => {
                const notTaken = isNotTakenTrade(trade);
                return {
                    ...trade,
                    aiExecutionStatus: notTaken ? 'not_taken' : 'executed',
                    aiExecutionNote: notTaken
                        ? 'Це сетап/можливість, яку трейдер НЕ БРАВ. Не рахувати як виконану угоду, PnL, winrate або помилку виконання входу.'
                        : 'Це виконана угода, якщо інші поля не кажуть протилежне.',
                };
            });
        }
        output[dateStr] = nextDay;
    }
    return output;
}

function buildNotTakenAIContext(journal = {}) {
    let notTakenCount = 0;
    let executedCount = 0;
    const examples = [];

    for (const [dateStr, day] of Object.entries(journal || {})) {
        const trades = Array.isArray(day?.trades) ? day.trades : [];
        for (const trade of trades) {
            if (isNotTakenTrade(trade)) {
                notTakenCount++;
                if (examples.length < 8) {
                    const sheet = trade?.sheet && typeof trade.sheet === 'object' ? trade.sheet : {};
                    const type = sheet.tradeType || trade?.type || sheet.fondexxType || 'тип не вказаний';
                    const symbol = trade?.symbol || trade?.ticker || '';
                    examples.push(`- ${dateStr}${symbol ? ` ${symbol}` : ''}: "${type}" = НЕ БРАВ / пропущена можливість`);
                }
            } else {
                executedCount++;
            }
        }
    }

    return [
        '',
        '',
        'ВАЖЛИВО ПРО УГОДИ "НЕ БРАВ":',
        'Якщо тип/коментар угоди містить "не брав", "не взяв", "do not take", "not taken", "no trade", "skip" або схожий зміст — це НЕ виконана угода.',
        'Такі записи рахуй як пропущені або спостережні сетапи: їх можна аналізувати як фільтр, якість відбору, missed opportunity або дисципліну очікування.',
        'Не включай їх у PnL, winrate, середній результат, кількість реальних входів і не критикуй трейдера за виконання входу/стопа, бо позиції не було.',
        `У поточному контексті: виконаних записів приблизно ${executedCount}, "не брав"/спостережних записів ${notTakenCount}.`,
        examples.length ? `Приклади:\n${examples.join('\n')}` : '',
    ].filter(Boolean).join('\n');
}

export function applyAIQuickPrompt(key) {
    const inputEl = document.getElementById('data-chat-input');
    if (!inputEl) return;
    const prompt = AI_QUICK_PROMPTS[key];
    if (!prompt) return;
    inputEl.value = prompt;
    inputEl.focus();
}

export function extractGeminiText(respData) {
    if (respData && respData.error && respData.error.message) throw new Error(respData.error.message);
    const parts = respData && respData.candidates && respData.candidates[0] && respData.candidates[0].content
        ? respData.candidates[0].content.parts : null;
    const text = Array.isArray(parts) ? parts.map(part => typeof part.text === 'string' ? part.text : '').join('').trim() : '';
    if (!text) throw new Error('Gemini не повернув текстову відповідь.');
    return text;
}

let _waitingToast = null;
function showGeminiWaiting(show, secs = 60) {
    if (show) {
        if (!_waitingToast) {
            _waitingToast = document.createElement('div');
            _waitingToast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid var(--accent);color:var(--text-main);padding:12px 20px;border-radius:10px;font-size:0.9rem;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
            document.body.appendChild(_waitingToast);
        }
        let remaining = secs;
        _waitingToast.innerHTML = `⏳ AI зайнятий, зачекайте <b>${remaining}с</b>...`;
        const interval = setInterval(() => {
            remaining--;
            if (_waitingToast) _waitingToast.innerHTML = `⏳ AI зайнятий, зачекайте <b>${remaining}с</b>...`;
            if (remaining <= 0) clearInterval(interval);
        }, 1000);
        _waitingToast._interval = interval;
    } else {
        if (_waitingToast) {
            clearInterval(_waitingToast._interval);
            _waitingToast.remove();
            _waitingToast = null;
        }
    }
}

export function renderAIAdviceUI() {
    let aiBox = document.getElementById('ai-response');
    let data = state.appData.journal[state.selectedDateStr] || {};
    if (data.ai_advice && data.ai_advice.trim() !== '') {
        aiBox.style.display = 'block'; aiBox.innerHTML = `<strong>🧠 Ментор:</strong><br>${sanitizeHTML(data.ai_advice).replace(/\n/g, '<br>')}`;
    } else { aiBox.style.display = 'none'; aiBox.innerHTML = ''; }
}

export async function getAIAdvice() {
    const key = getGeminiKeys()[0];
    
    let btn = document.getElementById('ai-btn'); btn.innerText = '⏳ Бот аналізує день...'; btn.disabled = true;
    let pnl = document.getElementById('trade-pnl').value || 0;
    let notes = document.getElementById('trade-notes').value || "Немає коментарів.";
    
    let errs = []; document.querySelectorAll('#errors-list-container input[type="checkbox"]:checked').forEach(cb => errs.push(cb.value));
    let params = []; document.querySelectorAll('.daily-param-check:checked').forEach(cb => { let f = state.appData.settings.checklist.find(p => p.id === cb.value); if(f) params.push(f.name); });
    let slidersText = []; document.querySelectorAll('.slider-input').forEach(el => { let f = state.appData.settings.sliders.find(p => p.id === el.getAttribute('data-id')); if(f) slidersText.push(`${f.name}: ${el.value}/10`); });
    
    const currentDay = state.appData.journal[state.selectedDateStr] || {};
    const tradeTypeContext = `${buildDayTradeTypeAIContext(currentDay)}${buildTradeTypeAIContext(state.appData.journal || {}, { tradeTypes: state.appData.tradeTypes, recentDays: 90, limit: 6 })}`;
    const notTakenContext = buildNotTakenAIContext({ [state.selectedDateStr]: currentDay });
    let promptText = `Ось мій звіт за торговий день:\nPnL: ${pnl}$\nВідмітки: ${params.length > 0 ? params.join(', ') : 'Немає'}\nПомилки: ${errs.length > 0 ? errs.join(', ') : 'Немає'}\nМій стан: ${slidersText.join(', ')}\nМої думки: "${notes}"\n${tradeTypeContext}${notTakenContext}${window.getPlaybookContext ? window.getPlaybookContext() : ''}`;
    
    try {
        let advice = await callGemini(key, { systemInstruction: { parts: [{ text: "Ти мій напарник по пропу і строгий ризик-менеджер. Спілкуйся українською, коротко (3-4 речення), прямо і по суті, без офіціозу. Використовуй звичайний трейдерський сленг (тільт, фомо, дейлос, профіт). Якщо я порушив систему або поплив емоційно — спокійно, але жорстко ткни в це носом, спираючись на звіт, щоб я зробив висновки. Якщо день ідеально зелений і без косяків — не розводь дифірамби, просто скажи щось типу: 'Нормально відпрацював, систему дотримав. Завтра головне не зловити корону і не лудоманіти, тримай ризики'." }] }, contents: [{ parts: [{ text: promptText }] }] });
        if (!state.appData.journal[state.selectedDateStr] && window.saveEntry) window.saveEntry(); 
        state.appData.journal[state.selectedDateStr].ai_advice = advice;
        markJournalDayDirty(state.selectedDateStr);
        saveJournalData();
        renderAIAdviceUI();
    } catch(e) {
        const aiBox = document.getElementById('ai-response');
        aiBox.style.display = 'block';
        const hint = /500|GEMINI|proxy|key/i.test(String(e.message)) ? ' Перевірте GEMINI_API_KEY на сервері (/api/gemini).' : '';
        aiBox.innerHTML = `<span style="color:var(--loss)">⚠️ Помилка AI: ${sanitizeHTML(e.message)}${hint}</span>`;
    } finally { btn.innerText = '🤖 Отримати пораду від Gemini AI'; btn.disabled = false; }
}

export async function analyzeTagPatterns() {
    const chatBox = document.getElementById('data-chat-box');
    if (!chatBox) return;

    // Збираємо статистику по тегах
    const tagStats = {}; // tag -> { days: number, totalPnl: number, minusDays: number }
    const screenTags = state.appData.screenTags || {};
    const journal = state.appData.journal || {};

    // Для кожного скріна знаходимо дату і PnL
    for (const [filename, tags] of Object.entries(screenTags)) {
        if (!tags || tags.length === 0) continue;
        // Шукаємо в якому дні є цей скрін
        for (const [date, dayData] of Object.entries(journal)) {
            const screens = dayData.screenshots || {};
            const allScreens = [...(screens.good||[]), ...(screens.normal||[]), ...(screens.bad||[]), ...(screens.error||[])];
            if (!allScreens.includes(filename)) continue;
            const pnl = parseFloat(dayData.pnl) || 0;
            tags.forEach(tag => {
                if (!tagStats[tag]) tagStats[tag] = { days: 0, totalPnl: 0, minusDays: 0 };
                tagStats[tag].days++;
                tagStats[tag].totalPnl += pnl;
                if (pnl < 0) tagStats[tag].minusDays++;
            });
        }
    }

    if (Object.keys(tagStats).length === 0) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg ai-msg';
        msgDiv.innerHTML = '⚠️ Немає тегів для аналізу. Додайте теги до скрінів.';
        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
        return;
    }

    const userMsgDiv = document.createElement('div');
    userMsgDiv.className = 'chat-msg user-msg';
    userMsgDiv.innerHTML = '🏷️ Проаналізуй мої теги сетапів';
    chatBox.appendChild(userMsgDiv);

    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-msg ai-msg';
    typingDiv.innerHTML = '<em>Аналізую теги...</em>';
    chatBox.appendChild(typingDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    const statsText = Object.entries(tagStats).map(([tag, s]) =>
        `"${tag}": ${s.days} днів, сумарний PnL: ${s.totalPnl.toFixed(2)}$, мінусових днів: ${s.minusDays} з ${s.days}`
    ).join('\n');
    const tradeTypeContext = buildTradeTypeAIContext(journal, { tradeTypes: state.appData.tradeTypes, recentDays: 120, limit: 6 });

    try {
        const aiText = await callGemini(getGeminiKeys()[0], {
            systemInstruction: { parts: [{ text: 'Ти строгий трейдинг-ментор. Аналізуй патерни тегів сетапів. Якщо якийсь тег переважно мінусовий — скажи прямо. Відповідай українською, коротко і по суті.' }] },
            contents: [{ parts: [{ text: `Ось статистика моїх сетапів по тегах:\n${statsText}\n${tradeTypeContext}\n\nЗнайди проблемні патерни і дай конкретні висновки. Обов'язково зв'яжи висновки з типами входу, якщо дані показують різницю між ними.` }] }]
        });
        chatBox.removeChild(typingDiv);
        const aiMsgDiv = document.createElement('div');
        aiMsgDiv.className = 'chat-msg ai-msg';
        aiMsgDiv.innerHTML = `<strong>🏷️ Аналіз тегів:</strong><br>${sanitizeAIHtml(sanitizeHTML(aiText).replace(/\n/g, '<br>'))}`;
        chatBox.appendChild(aiMsgDiv);
    } catch(e) {
        chatBox.removeChild(typingDiv);
        const errDiv = document.createElement('div');
        errDiv.className = 'chat-msg ai-msg';
        errDiv.innerHTML = `<span style="color:var(--loss)">⚠️ Помилка: ${sanitizeHTML(e.message)}</span>`;
        chatBox.appendChild(errDiv);
    }
    chatBox.scrollTop = chatBox.scrollHeight;
}

export async function analyzeChart(encodedPath, cleanId) {
    const key = getGeminiKeys()[0];
    let box = document.getElementById(`ai-vision-${cleanId}`); 
    box.style.display = 'block'; box.innerHTML = '⏳ <strong>AI Vision:</strong> Аналізую свічки, об\'єми та формацію...';
    try {
        let safePath = decodeURIComponent(encodedPath);
        let src = await getStorageUrl(safePath);
        if (!src) throw new Error('Не вдалось отримати URL зображення.');
        const _srcUrl = new URL(src, location.origin);
        const _isAllowed = _srcUrl.origin === location.origin ||
            /^([a-z0-9-]+\.)?supabase\.co$/.test(_srcUrl.hostname) ||
            /^([a-z0-9-]+\.)?googleapis\.com$/.test(_srcUrl.hostname) ||
            /^([a-z0-9-]+\.)?firebasestorage\.app$/.test(_srcUrl.hostname);
        if (!_isAllowed) throw new Error('Недозволений URL зображення.');
        let response = await fetch(src);
        if (!response.ok) throw new Error(`Не вдалось завантажити зображення (${response.status})`);
        let blob = await response.blob();
        const mimeType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
        let base64data = await new Promise((resolve) => { let reader = new FileReader(); reader.onloadend = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
        
        const tradeTypeContext = buildTradeTypeAIContext(state.appData.journal || {}, { tradeTypes: state.appData.tradeTypes, recentDays: 90, limit: 6 });
        const notTakenContext = buildNotTakenAIContext(state.appData.journal || {});
        let prompt = `Ти — професійний проп-трейдер. Проаналізуй цей графік.

КОНТЕКСТ ТРЕЙДЕРА (дуже важливо враховувати):
- Трейдер здебільшого торгує ШОРТ
- Якщо на графіку є нестанадартна сітка фібоначі 100 50 0 -50 -100 -200 -300 -370 -400 рахувати її за консолідацію де 100 це стоп 0 це вхід в позицію, співставляти ціну і розіщення стрілок щоб зрозуміти що це точка входу
- Якщо на графіку є стрілки: ЧЕРВОНА стрілка = вхід у шорт, ЗЕЛЕНА стрілка = закриття шорту
- Якщо перша стрілка ЗЕЛЕНА — це лонг, тоді ЧЕРВОНА = стоп або закриття лонгу
- Стрілки можуть бути відсутні або неточно розставлені — орієнтуйся на price action і контекст
- Не роби висновок про напрямок угоди тільки по кольору свічок — дивись на стрілки і структуру
- Детальніше розглядай рух після входу в позицію
- Сітка фібоначі служить тільки консолідацією
${tradeTypeContext}
${notTakenContext}

ЩО АНАЛІЗУВАТИ НАСАМПЕРЕД — ВІЗУАЛЬНИЙ ПАТЕРН:
1. Опиши форму руху ціни ДО входу: як виглядає структура (консолідація, пробій, відкат, імпульс, флет, клин тощо)
2. Де саме стався вхід відносно цієї структури — на пробої, на відкаті, на тесті рівня?
3. Як виглядає рух ПІСЛЯ входу — чи підтвердив він патерн?
4. Якість точки входу відносно структури і ключових зон
5. Розміщення стопу — чи є сенс, чи не затісно/задалеко
6. Технічні помилки або слабкі місця сетапу
${window.getPlaybookContext ? window.getPlaybookContext() : ''}

ЯКЩО В ПЛЕЙБУКУ Є СЕТАПИ З ВІЗУАЛЬНИМ ПАТЕРНОМ (конструктор): порівняй форму руху на цьому графіку з описаними патернами — чи схожа структура? Який сетап найближчий візуально?
Відповідай українською, лаконічно, по суті.`;
        const imagePayload = { contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: mimeType, data: base64data } } ] }] };

        const text = await callGeminiViaProxy(imagePayload, 'gemini-2.5-flash');
        let formattedHTML = sanitizeAIHtml(sanitizeHTML(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/\n/g, '<br>'));
        box.innerHTML = `<strong>👁️ AI Аналіз сетапу:</strong><br><br>${formattedHTML}`;
    } catch(e) { box.innerHTML = `<span style="color: red;">Помилка аналізу: ${sanitizeHTML(e.message)}</span>`; }
}

export function openSOSModal() { document.getElementById('sos-modal').style.display = 'flex'; document.getElementById('sos-input').focus(); }
export function closeSOSModal() { document.getElementById('sos-modal').style.display = 'none'; }
export function appendSOSMessage(text, isAI) {
    const chatBox = document.getElementById('sos-chat-box'); const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg ${isAI ? 'ai-msg' : 'user-msg'}`;
    if (isAI) {
        // amazonq-ignore-next-line
        msgDiv.innerHTML = `<strong>🚨 РМ:</strong><br>${sanitizeHTML(text)}`;
    } else {
        msgDiv.textContent = text;
    }
    chatBox.appendChild(msgDiv); chatBox.scrollTop = chatBox.scrollHeight;
}

export async function sendSOSMessage() {
    const inputEl = document.getElementById('sos-input'); const btnEl = document.getElementById('sos-send-btn'); const text = inputEl.value.trim();
    if (!text) return;
    const key = getGeminiKeys()[0];

    appendSOSMessage(text, false); inputEl.value = ''; btnEl.innerText = '⏳...'; btnEl.disabled = true; inputEl.disabled = true;
    sosChatHistory.push({ role: "user", parts: [{ text: text }] });

    const systemPrompt = `Ти — досвідчений торговий психолог. Трейдер натиснув кнопку SOS. Його треба заспокоїти і повернути холодний розум.`;

    try {
        let aiResponseText = await callGemini(key, { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: sosChatHistory });
        sosChatHistory.push({ role: "model", parts: [{ text: aiResponseText }] }); appendSOSMessage(aiResponseText, true);
    } catch(e) { appendSOSMessage("Помилка зв'язку з сервером.", true); } finally { btnEl.innerText = 'Відправити'; btnEl.disabled = false; inputEl.disabled = false; inputEl.focus(); }
}

export function appendDataChatMessage(text, isAI) {
    const chatBox = document.getElementById('data-chat-box'); const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg ${isAI ? 'ai-msg' : 'user-msg'}`;
    if (isAI) {
        msgDiv.style.borderLeftColor = 'var(--accent)';
        msgDiv.style.background = 'color-mix(in srgb, var(--accent) 10%, transparent)';
        msgDiv.innerHTML = `<strong>📊 AI Аналітик:</strong><br>${sanitizeAIHtml(text)}`;
    } else {
        msgDiv.textContent = text;
    }
    chatBox.appendChild(msgDiv); chatBox.scrollTop = chatBox.scrollHeight;
}

export async function sendDataChatMessage() {
    const inputEl = document.getElementById('data-chat-input');
    const chatBox = document.getElementById('data-chat-box');
    if (!inputEl || !chatBox) return;

    const userText = inputEl.value.trim();
    if (!userText) return;

    inputEl.value = '';
    setDataChatBusy(true);

    const key = getGeminiKeys()[0];

    // Телеграм стиль для користувача (без "Ти:")
    const userMsgDiv = document.createElement('div');
    userMsgDiv.className = 'chat-msg user-msg';
    userMsgDiv.textContent = userText;
    chatBox.appendChild(userMsgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-msg ai-msg';
    typingDiv.classList.add('chat-typing-row');
    typingDiv.innerHTML = '<em>Друкую відповідь...</em>';
    chatBox.appendChild(typingDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const journalForAI = buildAIJournalForPrompt(state.appData.journal || {});
        const journalData = JSON.stringify(journalForAI);
        const screenTagsData = JSON.stringify(state.appData.screenTags || {});
        const tradeTypeContext = buildTradeTypeAIContext(state.appData.journal || {}, { tradeTypes: state.appData.tradeTypes, recentDays: 120, limit: 8 });
        const notTakenContext = buildNotTakenAIContext(state.appData.journal || {});
        const playbookContext = window.getPlaybookContext ? window.getPlaybookContext() : '';
        const promptText = `Ось дані журналу: ${journalData}\n\nТеги скріншотів: ${screenTagsData}${tradeTypeContext}${notTakenContext}${playbookContext}\n\nВідповідай коротко українською. Коли питання стосується результату, обов'язково враховуй різні типи входу як різні логіки. Окремо відрізняй виконані угоди від записів "не брав". Запит: ${userText}`;

        const aiResponseText = await callGemini(key, {
            systemInstruction: { parts: [{ text: "Ти професійний трейдинг-ментор. Пиши українською, коротко, конкретно і без фінансових обіцянок. Роби висновки з журналу, ризику, типів входу, тегів скрінів і плейбуку. Якщо даних мало, прямо скажи що саме треба додати." }] },
            contents: [{ parts: [{ text: promptText }] }]
        });
        const formattedHTML = formatAIResponse(aiResponseText);

        chatBox.removeChild(typingDiv);
        chatBox.appendChild(makeAIChatBubble(userText, formattedHTML));
        
        chatBox.scrollTop = chatBox.scrollHeight;

        if (!state.appData.aiChatHistory) state.appData.aiChatHistory = [];
        state.appData.aiChatHistory.push({ role: 'user', text: userText });
        state.appData.aiChatHistory.push({ role: 'ai', text: formattedHTML });
        state.appData.aiChatHistory = state.appData.aiChatHistory.slice(-40);
        saveToLocal();

    } catch (error) {
        if (typingDiv.parentElement) chatBox.removeChild(typingDiv);
        const errDiv = document.createElement('div');
        errDiv.className = 'chat-msg ai-msg';
        errDiv.innerHTML = `<span style="color:var(--loss)">⚠️ Помилка AI: ${sanitizeHTML(error.message)}</span>`;
        chatBox.appendChild(errDiv);
    } finally {
        setDataChatBusy(false);
        inputEl.focus();
    }
}

export function loadAIChatHistory() {
    const chatBox = document.getElementById('data-chat-box');
    if (!chatBox) return;
    chatBox.innerHTML = '';
    
    // Привітання ШІ
    const greetingDiv = document.createElement('div');
    greetingDiv.className = 'chat-msg ai-msg';
    greetingDiv.innerHTML = `<strong>🤖 AI Аналітик:</strong><br>Привіт! Я проаналізую твої угоди. Що тебе цікавить?`;
    chatBox.appendChild(greetingDiv);

    if (state.appData.aiChatHistory && state.appData.aiChatHistory.length > 0) {
        for (let i = 0; i < state.appData.aiChatHistory.length; i++) {
            const msg = state.appData.aiChatHistory[i];

            if (msg.role === 'ai') {
                // Знаходимо текст юзера, щоб зберегти в закладки
                const prevUserMsg = (i > 0 && state.appData.aiChatHistory[i-1].role === 'user') ? state.appData.aiChatHistory[i-1].text : 'Запит з історії';
                const aiHtml = sanitizeAIHtml(msg.text);
                const wrapperDiv = makeAIChatBubble(prevUserMsg, aiHtml);
                const saveBtn = wrapperDiv.querySelector('.btn-save-icon');

                // Перевіряємо, чи повідомлення ВЖЕ є у збережених
                let isAlreadySaved = state.appData.aiSavedChats && state.appData.aiSavedChats.some(item => item.user === prevUserMsg && item.ai === msg.text);
                if (isAlreadySaved) {
                    saveBtn?.classList.add('is-saved');
                }

                chatBox.appendChild(wrapperDiv);
            } else {
                // Повідомлення юзера (Телеграм стиль)
                const msgDiv = document.createElement('div');
                msgDiv.className = 'chat-msg user-msg';
                msgDiv.textContent = msg.text;
                chatBox.appendChild(msgDiv);
            }
        }
    }
    chatBox.scrollTop = chatBox.scrollHeight;
}

export function switchAITab(tab) {
    document.getElementById('ai-chat-section').style.display = tab === 'chat' ? 'flex' : 'none';
    document.getElementById('ai-saved-section').style.display = tab === 'saved' ? 'flex' : 'none';

    const chatBtn = document.getElementById('btn-ai-chat');
    const savedBtn = document.getElementById('btn-ai-saved');
    if (chatBtn) {
        chatBtn.classList.toggle('btn-primary', tab === 'chat');
        chatBtn.classList.toggle('btn-secondary', tab !== 'chat');
    }
    if (savedBtn) {
        savedBtn.classList.toggle('btn-primary', tab === 'saved');
        savedBtn.classList.toggle('btn-secondary', tab !== 'saved');
    }
    
    if(tab === 'saved') renderSavedAIChats();
}

export function bookmarkAIChat(userText, aiHtml, btnEl) {
    import('./state.js').then(({ state }) => {
        if (!state.appData.aiSavedChats) state.appData.aiSavedChats = [];
        
        // Шукаємо, чи є вже такий запис у збережених (порівнюємо текст)
        let existingIdx = state.appData.aiSavedChats.findIndex(item => item.user === userText && item.ai === aiHtml);
        
        if (existingIdx !== -1) {
            // ❌ ЯКЩО ВЖЕ Є — ВИДАЛЯЄМО ЗІ ЗБЕРЕЖЕНОГО
            state.appData.aiSavedChats.splice(existingIdx, 1);
            if (btnEl) {
                btnEl.classList.remove('is-saved');
            }
        } else {
            // ✅ ЯКЩО НЕМАЄ — ДОДАЄМО В ЗБЕРЕЖЕНЕ
            state.appData.aiSavedChats.push({
                date: new Date().toLocaleDateString('uk-UA') + ' ' + new Date().toLocaleTimeString('uk-UA', {hour: '2-digit', minute:'2-digit'}),
                user: userText,
                ai: aiHtml
            });
            if (btnEl) {
                btnEl.classList.add('is-saved');
            }
        }
        
        // Зберігаємо в базу
        import('./storage.js').then(module => module.saveToLocal());
        
        // Оновлюємо список "Збережене", якщо він зараз відкритий
        if (window.renderSavedAIChats) window.renderSavedAIChats();
    });
}

export function renderSavedAIChats() {
    import('./state.js').then(({ state }) => {
        const container = document.getElementById('ai-saved-list');
        if (!container) return;
        
        if (!state.appData.aiSavedChats || state.appData.aiSavedChats.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted)">У вас поки немає збережених відповідей ШІ.</p>';
            return;
        }
        
        container.innerHTML = '';
        state.appData.aiSavedChats.forEach((item, idx) => {
            const card = document.createElement('div');
            card.className = 'ai-saved-card';

            const dateDiv = document.createElement('div');
            dateDiv.className = 'ai-saved-card-date';
            dateDiv.textContent = `📅 Збережено: ${item.date}`;

            const userDiv = document.createElement('div');
            userDiv.className = 'ai-saved-card-user';
            const userLabel = document.createElement('strong');
            userLabel.textContent = 'Ваш запит: ';
            const userSpan = document.createElement('span');
            userSpan.textContent = item.user;
            userDiv.appendChild(userLabel);
            userDiv.appendChild(userSpan);

            const aiDiv = document.createElement('div');
            aiDiv.className = 'ai-saved-card-answer';
            const aiLabel = document.createElement('strong');
            aiLabel.textContent = 'ШІ:';
            const aiBr = document.createElement('br');
            const aiContent = document.createElement('span');
            // amazonq-ignore-next-line
            aiContent.innerHTML = sanitizeAIHtml(item.ai);
            aiDiv.appendChild(aiLabel);
            aiDiv.appendChild(aiBr);
            aiDiv.appendChild(aiContent);

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-secondary';
            delBtn.classList.add('ai-saved-delete');
            delBtn.textContent = '❌ Видалити закладку';
            delBtn.addEventListener('click', () => deleteSavedAI(idx));

            card.appendChild(dateDiv);
            card.appendChild(userDiv);
            card.appendChild(aiDiv);
            card.appendChild(delBtn);
            container.appendChild(card);
        });
    });
}

export function deleteSavedAI(idx) {
    const safeIdx = parseInt(idx, 10);
    if (!Number.isFinite(safeIdx) || safeIdx < 0) return;

    const container = document.getElementById('ai-saved-list');
    const items = container?.querySelectorAll(':scope > div');
    const target = items?.[safeIdx];
    if (!target) return;

    const confirmBar = document.createElement('div');
    confirmBar.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

    const label = document.createElement('span');
    label.style.cssText = 'flex:1;color:var(--loss);font-size:0.85rem;';
    label.textContent = 'Видалити цей аналіз?';

    const yesBtn = document.createElement('button');
    yesBtn.className = 'btn-secondary';
    yesBtn.style.cssText = 'width:auto;margin:0;border-color:var(--loss);color:var(--loss);';
    yesBtn.textContent = '✔ Так';
    yesBtn.onclick = () => {
        import('./state.js').then(({ state }) => {
            state.appData.aiSavedChats.splice(safeIdx, 1);
            import('./storage.js').then(m => m.saveToLocal());
            renderSavedAIChats();
        });
    };

    const noBtn = document.createElement('button');
    noBtn.className = 'btn-secondary';
    noBtn.style.cssText = 'width:auto;margin:0;';
    noBtn.textContent = '✖ Ні';
    noBtn.onclick = () => confirmBar.remove();

    confirmBar.appendChild(label);
    confirmBar.appendChild(yesBtn);
    confirmBar.appendChild(noBtn);
    target.appendChild(confirmBar);
}
