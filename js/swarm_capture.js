import { supabase } from './supabase.js';
import { state } from './state.js';
import { getDefaultDayEntry } from './data_utils.js';
import { markJournalDayDirty, saveJournalData } from './storage.js';
import { showToast } from './utils.js';
import { initMarketEnrichment } from './market_enrichment.js';
import { gradeDiscipline } from './discipline_score.js';

let recorder; let recognition; let browserTranscript = ''; let chunks = []; let vision = null; let transcript = ''; let chartPath = '';
const $ = (id) => document.getElementById(id);
function busy(active, label = 'Swarm аналізує сигнал…') { const node = $('swarm-status'); if (!node) return; node.hidden = !active; node.querySelector('b').textContent = label; document.querySelectorAll('.swarm-action,.swarm-save').forEach((button) => { button.disabled = active; }); }
function summary(text, error = false) { const node = $('swarm-summary'); if (!node) return; node.textContent = text; node.classList.toggle('is-error', error); }
function setInput(id, value) { if ($(id) && value != null && value !== '') $(id).value = value; }
const base64 = (blob) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(blob); });

async function swarm(body) {
    const { data } = await supabase.auth.getSession(); const token = data?.session?.access_token;
    if (!token) throw new Error('Увійдіть у STRUM ще раз.');
    const response = await fetch('/api/gemini', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(payload.message || `Swarm HTTP ${response.status}`); error.code = payload.code; throw error; }
    return payload;
}

function applyDraft(draft = {}) {
    setInput('swarm-ticker', draft.ticker); setInput('swarm-entry', draft.entry); setInput('swarm-exit', draft.exit); setInput('swarm-stop', draft.stop); setInput('swarm-setup', draft.setup); setInput('swarm-rvol', draft.rvol); setInput('swarm-atr', draft.atr);
    summary(`R/R: ${draft.riskReward ?? '—'}.${draft.warnings?.length ? ` Перевір: ${draft.warnings.join(' ')}` : ''}`);
}

async function toggleRecording() {
    const button = $('swarm-mic-btn');
    if (recorder?.state === 'recording') return recorder.stop();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return summary('Цей браузер не підтримує запис голосу.', true);
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
        recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined });
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = async () => {
            button.setAttribute('aria-pressed', 'false'); button.textContent = '🎙 Диктувати'; stream.getTracks().forEach((track) => track.stop()); try { recognition?.stop(); } catch {}
            try { busy(true, 'Whisper слухає, Parser структурує…'); const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); const result = await swarm({ action: 'swarm-voice', audioBase64: await base64(blob), mimeType: blob.type, language: 'uk' }); transcript = result.transcript || ''; applyDraft(result.draft); }
            catch (error) {
                if (browserTranscript) {
                    try { const result = await swarm({ action: 'swarm-parse', text: browserTranscript }); transcript = browserTranscript; applyDraft(result.draft); summary(`Browser Voice fallback: ${browserTranscript}`); }
                    catch (fallbackError) { summary(fallbackError.message, true); }
                } else summary(error.code === 'RATE_LIMITED' ? 'Voice free-tier перевантажений. Спробуйте трохи пізніше.' : error.message, true);
            } finally { busy(false); }
        };
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; browserTranscript = '';
        if (SpeechRecognition) { recognition = new SpeechRecognition(); recognition.lang = 'uk-UA'; recognition.interimResults = false; recognition.onresult = (event) => { browserTranscript = [...event.results].map((result) => result[0]?.transcript || '').join(' ').trim(); }; try { recognition.start(); } catch {} }
        recorder.start(); button.setAttribute('aria-pressed', 'true'); button.textContent = '■ Завершити'; summary('Говоріть: ticker, entry, stop/exit і setup.');
    } catch (error) { summary(`Мікрофон недоступний: ${error.message}`, true); }
}

async function analyzeImage(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return summary('Потрібен PNG, JPEG або WebP.', true);
    try {
        busy(true, 'Завантажую приватний chart і запускаю Vision…'); const { data } = await supabase.auth.getUser(); const userId = data?.user?.id; if (!userId) throw new Error('Сесію втрачено.');
        const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'; chartPath = `${userId}/drafts/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from('trade-charts').upload(chartPath, file, { contentType: file.type, upsert: false }); if (uploadError) throw uploadError;
        const result = await swarm({ modality: 'vision', chartImageUrl: chartPath, mimeType: file.type }); vision = result.vision; setInput('swarm-setup', vision.setup); summary(`${vision.summary}${vision.risks?.length ? ` Ризики: ${vision.risks.join('; ')}` : ''}`);
    }
    catch (error) { summary(error.code === 'RATE_LIMITED' ? 'Vision free-tier вичерпано. Чернетку можна зберегти без аналізу.' : error.message, true); } finally { busy(false); }
}

function nyDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
async function saveDraft() {
    const ticker = $('swarm-ticker')?.value.trim().toUpperCase(); if (!ticker) return summary('Вкажіть ticker перед збереженням.', true);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(state.selectedDateStr || '') ? state.selectedDateStr : nyDate(); const day = state.appData.journal[date] || getDefaultDayEntry(); day.trades = Array.isArray(day.trades) ? day.trades : [];
    const draftTrade = { symbol: ticker, type: 'SHORT', entry: $('swarm-entry').value, exit: $('swarm-exit').value, stop: $('swarm-stop').value, setup: $('swarm-setup').value.trim(), gapPct: $('swarm-gap')?.value || '', rvol: $('swarm-rvol').value, floatShares: $('swarm-float')?.value || '', atr: $('swarm-atr').value, opened: $('swarm-time')?.value || '' };
    const discipline = gradeDiscipline(draftTrade);
    const trade = { ...draftTrade, disciplineGrade: discipline.grade, disciplineScore: discipline.score, disciplineReasons: discipline.reasons, disciplineVersion: discipline.version, analysisResult: { source: 'ai-swarm', voiceTranscript: transcript, chartImageUrl: chartPath, vision } }; day.trades.push(trade);
    state.appData.journal[date] = day; markJournalDayDirty(date);
    try {
        busy(true, 'Зберігаю угоду, multimodal metadata й Vector Memory…'); await saveJournalData();
        const { data: auth } = await supabase.auth.getUser(); const { data: journalDay, error: dayError } = await supabase.from('journal_days').select('id').eq('user_id', auth.user.id).eq('trade_date', date).single(); if (dayError) throw dayError;
        const { data: multimodal, error: multimodalError } = await supabase.from('trade_multimodal_inputs').insert({ user_id: auth.user.id, journal_day_id: journalDay.id, trade_key: `${date}:${ticker}:${day.trades.length - 1}`, audio_transcript: transcript, chart_image_url: chartPath, vision_analysis: vision ? JSON.stringify(vision) : '', ai_confidence_score: vision ? Math.round((Number(vision.confidence) || 0) * 100) : null }).select('id').single(); if (multimodalError) throw multimodalError;
        trade.analysisResult.multimodalInputId = multimodal.id; markJournalDayDirty(date); await saveJournalData();
        summary(`Чернетку ${ticker} збережено за ${date}. Multimodal і Vector Memory синхронізуються.`); showToast('Chart analyzed successfully');
    }
    catch (error) { summary(`Не вдалося зберегти: ${error.message}`, true); } finally { busy(false); }
}

export function initSwarmCapture() {
    const root = $('swarm-capture'); if (!root || root.dataset.bound) return; root.dataset.bound = 'true';
    $('swarm-mic-btn')?.addEventListener('click', toggleRecording); $('swarm-image-btn')?.addEventListener('click', () => $('swarm-image-input')?.click()); $('swarm-image-input')?.addEventListener('change', (event) => analyzeImage(event.target.files?.[0])); $('swarm-save-btn')?.addEventListener('click', saveDraft);
    const zone = $('swarm-dropzone'); zone?.addEventListener('click', () => $('swarm-image-input')?.click()); zone?.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-dragging'); }); zone?.addEventListener('dragleave', () => zone.classList.remove('is-dragging')); zone?.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('is-dragging'); analyzeImage(event.dataTransfer?.files?.[0]); });
    document.addEventListener('paste', (event) => { if (!document.getElementById('view-trades')?.classList.contains('active')) return; const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith('image/')); if (file) analyzeImage(file); });
    initMarketEnrichment();
    const updateDiscipline = () => { const node = $('swarm-discipline'); if (!node) return; const result = gradeDiscipline({ type: 'SHORT', opened: $('swarm-time')?.value, entry: $('swarm-entry')?.value, exit: $('swarm-exit')?.value, stop: $('swarm-stop')?.value, setup: $('swarm-setup')?.value, rvol: $('swarm-rvol')?.value, atr: $('swarm-atr')?.value }); node.textContent = `Discipline ${result.grade} · ${result.score}/100${result.reasons.length ? ` · ${result.reasons[0]}` : ' · план підтверджено'}`; node.dataset.grade = result.grade; };
    ['swarm-time','swarm-entry','swarm-exit','swarm-stop','swarm-setup','swarm-rvol','swarm-atr'].forEach((id) => $(id)?.addEventListener('input', updateDiscipline)); updateDiscipline();
}
