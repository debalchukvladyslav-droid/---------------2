// === js/trade_story.js ===
import { callGeminiJSON } from './ai.js';

// ─── Part 1: Quant Analytics ──────────────────────────────────────────────────

function getNYOffset(dateStr) {
    const testDate = new Date(`${dateStr}T12:00:00`);
    const nyStr = testDate.toLocaleString('en-US', {
        timeZone: 'America/New_York', hour12: false,
        hour: '2-digit', timeZoneName: 'short'
    });
    return nyStr.includes('EDT') ? '-04:00' : '-05:00';
}

function toTs(timeStr, dateStr) {
    if (!timeStr) return 0;
    const full = timeStr.includes('-') ? timeStr : `${dateStr} ${timeStr}`;
    return Math.floor(new Date(full.replace(' ', 'T') + getNYOffset(dateStr)).getTime() / 1000);
}

function fmtTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/New_York', hour12: false
    });
}

function mean(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function calcATR(candles) {
    if (candles.length < 2) return candles[0] ? candles[0].high - candles[0].low : 0;
    const trs = candles.slice(1).map((c, i) => {
        const prev = candles[i];
        return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    });
    return mean(trs);
}

export function sliceCandles(candles, tsFrom, tsTo) {
    return candles.filter(c => c.time >= tsFrom && c.time <= tsTo);
}

export function findVolumeSpikes(candles, topN = 5) {
    if (!candles.length) return [];
    const vols = candles.map(c => c.volume ?? 0);
    const m  = mean(vols);
    const sd = stdDev(vols);
    return candles
        .filter(c => (c.volume ?? 0) >= m + 1.5 * sd)
        .map(c => ({
            time: c.time, volume: c.volume ?? 0,
            ratio: sd > 0 ? +((c.volume - m) / sd).toFixed(2) : 0,
            open: c.open, high: c.high, low: c.low, close: c.close,
        }))
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, topN);
}

export function findSwingPoints(candles, lookback = 3) {
    const highs = [], lows = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        const c = candles[i];
        if (candles.slice(i - lookback, i).every(x => x.high <= c.high) &&
            candles.slice(i + 1, i + lookback + 1).every(x => x.high <= c.high))
            highs.push({ time: c.time, price: c.high });
        if (candles.slice(i - lookback, i).every(x => x.low >= c.low) &&
            candles.slice(i + 1, i + lookback + 1).every(x => x.low >= c.low))
            lows.push({ time: c.time, price: c.low });
    }
    return { highs, lows };
}

// Визначає ключові рівні підтримки/опору з кластерів цін
function findKeyLevels(candles, tolerance = 0.003) {
    if (candles.length < 10) return [];
    const prices = candles.flatMap(c => [c.high, c.low]);
    const clusters = [];
    prices.forEach(p => {
        const existing = clusters.find(c => Math.abs(c.price - p) / p < tolerance);
        if (existing) { existing.touches++; existing.price = (existing.price + p) / 2; }
        else clusters.push({ price: +p.toFixed(4), touches: 1 });
    });
    return clusters.filter(c => c.touches >= 3).sort((a, b) => b.touches - a.touches).slice(0, 6);
}

// Визначає VWAP для масиву свічок
function calcVWAP(candles) {
    let cumPV = 0, cumV = 0;
    return candles.map(c => {
        const tp = (c.high + c.low + c.close) / 3;
        const v  = c.volume ?? 0;
        cumPV += tp * v;
        cumV  += v;
        return { time: c.time, vwap: cumV > 0 ? +(cumPV / cumV).toFixed(4) : tp };
    });
}

// Визначає патерни на свічках
function detectPatterns(candles) {
    const patterns = [];
    if (candles.length < 5) return patterns;

    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);
    const n = candles.length;

    // Double Top: два піки на одному рівні (толеранція 0.5%)
    for (let i = 2; i < n - 2; i++) {
        if (highs[i] >= highs[i-1] && highs[i] >= highs[i+1]) {
            for (let j = i + 3; j < n - 1; j++) {
                if (highs[j] >= highs[j-1] && highs[j] >= highs[j+1]) {
                    if (Math.abs(highs[i] - highs[j]) / highs[i] < 0.005) {
                        patterns.push({ type: 'double_top', time: fmtTime(candles[j].time), price: +((highs[i]+highs[j])/2).toFixed(4) });
                        break;
                    }
                }
            }
        }
    }

    // Double Bottom
    for (let i = 2; i < n - 2; i++) {
        if (lows[i] <= lows[i-1] && lows[i] <= lows[i+1]) {
            for (let j = i + 3; j < n - 1; j++) {
                if (lows[j] <= lows[j-1] && lows[j] <= lows[j+1]) {
                    if (Math.abs(lows[i] - lows[j]) / lows[i] < 0.005) {
                        patterns.push({ type: 'double_bottom', time: fmtTime(candles[j].time), price: +((lows[i]+lows[j])/2).toFixed(4) });
                        break;
                    }
                }
            }
        }
    }

    // Bull/Bear Flag: сильний імпульс + консолідація
    const atr = calcATR(candles);
    for (let i = 3; i < n - 3; i++) {
        const impulse = Math.abs(candles[i].close - candles[i-3].open);
        if (impulse < atr * 2) continue;
        const isBull = candles[i].close > candles[i-3].open;
        const flagCandles = candles.slice(i+1, i+4);
        const flagRange = Math.max(...flagCandles.map(c => c.high)) - Math.min(...flagCandles.map(c => c.low));
        if (flagRange < atr * 0.8) {
            patterns.push({ type: isBull ? 'bull_flag' : 'bear_flag', time: fmtTime(candles[i+1].time), price: +candles[i].close.toFixed(4) });
        }
    }

    return patterns.slice(0, 4);
}

export function buildTradeContext(trade, candles, dateStr) {
    const tsEntry = toTs(trade.opened, dateStr);
    const tsExit  = toTs(trade.closed,  dateStr);
    const offset  = getNYOffset(dateStr);
    // Full session: pre-market open (04:00) to after-hours close (20:00)
    const ts400  = Math.floor(new Date(`${dateStr}T04:00:00${offset}`).getTime() / 1000);
    const ts930  = Math.floor(new Date(`${dateStr}T09:30:00${offset}`).getTime() / 1000);
    const ts1600 = Math.floor(new Date(`${dateStr}T16:00:00${offset}`).getTime() / 1000);
    const ts2000 = Math.floor(new Date(`${dateStr}T20:00:00${offset}`).getTime() / 1000);

    const tradingSlice  = sliceCandles(candles, tsEntry, tsExit);
    // Post-exit: everything from exit to end of after-hours
    const postExitSlice = sliceCandles(candles, tsExit + 60, ts2000);
    // Full session for swing/pattern/level detection
    const fullSlice     = sliceCandles(candles, ts400, ts2000);
    const sessionSlice  = fullSlice;
    const preMarket     = sliceCandles(candles, ts400, ts930);
    const afterHours    = sliceCandles(candles, ts1600, ts2000);
    // Pre-trade: everything from pre-market open up to entry
    const preTradeSlice = sliceCandles(candles, ts400, tsEntry);
    const tsSessionStart = ts400;
    const tsSessionEnd   = ts2000;

    if (!tradingSlice.length) return null;

    const tradeHigh    = Math.max(...tradingSlice.map(c => c.high));
    const tradeLow     = Math.min(...tradingSlice.map(c => c.low));
    const atr          = calcATR(tradingSlice);
    const avgVolume    = mean(tradingSlice.map(c => c.volume ?? 0));
    const exitCandle   = tradingSlice[tradingSlice.length - 1];
    const exitVolRatio = avgVolume > 0 ? +((exitCandle?.volume ?? 0) / avgVolume).toFixed(2) : 0;
    // Відносний обсяг на вході відносно середнього за 2h до
    const preAvgVolume  = mean(preTradeSlice.map(c => c.volume ?? 0));
    const entryCandle   = tradingSlice[0];
    const entryVolRatio = preAvgVolume > 0 ? +((entryCandle?.volume ?? 0) / preAvgVolume).toFixed(2) : 0;

    const tradeSpikes = findVolumeSpikes(tradingSlice, 3);
    const postSpikes  = findVolumeSpikes(postExitSlice, 3);
    const { highs: swingHighs, lows: swingLows } = findSwingPoints(fullSlice, 2);

    const ahHigh = afterHours.length ? Math.max(...afterHours.map(c => c.high)) : null;
    const ahLow  = afterHours.length ? Math.min(...afterHours.map(c => c.low))  : null;
    const postLow  = postExitSlice.length ? Math.min(...postExitSlice.map(c => c.low))  : null;
    const postHigh = postExitSlice.length ? Math.max(...postExitSlice.map(c => c.high)) : null;
    const missedMove = trade.type === 'Short' && postLow  !== null ? +(trade.exit - postLow).toFixed(4)
                     : trade.type === 'Long'  && postHigh !== null ? +(postHigh - trade.exit).toFixed(4)
                     : 0;

    const keyLevels   = findKeyLevels(sessionSlice);
    const vwapData    = calcVWAP(sessionSlice);
    const vwapAtExit  = vwapData.find(v => v.time >= tsExit)?.vwap ?? null;
    const vwapAtEntry = vwapData.find(v => v.time >= tsEntry)?.vwap ?? null;
    const patterns    = detectPatterns(fullSlice);

    const pmHigh = preMarket.length ? Math.max(...preMarket.map(c => c.high)) : null;
    const pmLow  = preMarket.length ? Math.min(...preMarket.map(c => c.low))  : null;

    const q1 = sessionSlice.slice(0, Math.floor(sessionSlice.length / 4));
    const q4 = sessionSlice.slice(-Math.floor(sessionSlice.length / 4));
    const sessionTrend = q1.length && q4.length
        ? (mean(q4.map(c => c.close)) > mean(q1.map(c => c.close)) ? 'uptrend' : 'downtrend')
        : 'neutral';

    return {
        symbol: trade.symbol, type: trade.type, dateStr,
        entry: trade.entry, exit: trade.exit, qty: trade.qty, net: trade.net, gross: trade.gross,
        openedStr: trade.opened, closedStr: trade.closed,
        tsEntry, tsExit,
        durationMin: Math.round((tsExit - tsEntry) / 60),
        tradeHigh, tradeLow, atr: +atr.toFixed(4),
        totalVolume: tradingSlice.reduce((s, c) => s + (c.volume ?? 0), 0),
        avgVolume: +avgVolume.toFixed(0), exitVolRatio, entryVolRatio,
        tradeSpikes, postSpikes, swingHighs, swingLows,
        postLow, postHigh, missedMove,
        exitBeforeOpen: tsExit < ts930,
        entryBeforeOpen: tsEntry < ts930,
        minutesFromOpen: Math.round((tsExit - ts930) / 60),
        tradingSlice, postExitSlice, preTradeSlice,
        keyLevels, vwapAtEntry, vwapAtExit, patterns,
        pmHigh, pmLow, ahHigh, ahLow, sessionTrend, sessionSlice,
        preMarket, afterHours,
    };
}

// ─── Part 2: LLM Prompt Builder ───────────────────────────────────────────────

function compressCandles(candles, maxCandles = 40) {
    if (!candles.length) return '  (no data)';
    const step = Math.max(1, Math.floor(candles.length / maxCandles));
    return candles
        .filter((_, i) => i % step === 0)
        .map(c => {
            const t = new Date(c.time * 1000).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: false
            });
            const v = c.volume ? ` V=${Math.round(c.volume / 1000)}k` : '';
            return `${t} O=${c.open} H=${c.high} L=${c.low} C=${c.close}${v}`;
        }).join('\n');
}

export function buildStoryPrompt(ctx) {
    const dir     = ctx.type === 'Short' ? 'SHORT' : 'LONG';
    const pnlSign = ctx.net >= 0 ? '+' : '';

    // Full session blocks for complete context
    const preMarketBlock  = compressCandles(ctx.preMarket     || [], 20);
    const preTradeBlock   = compressCandles(ctx.preTradeSlice || [], 25);
    const tradeBlock      = compressCandles(ctx.tradingSlice,        30);
    const postExitBlock   = compressCandles(ctx.postExitSlice || [], 30);
    const afterHoursBlock = compressCandles(ctx.afterHours    || [], 20);

    const spikesText     = ctx.tradeSpikes.map(s => '  ' + fmtTime(s.time) + ': vol=' + Math.round(s.volume/1000) + 'k (' + s.ratio + 'sig), ' + s.open + '->' + s.close).join('\n') || '  none';
    const postSpikesText = ctx.postSpikes.map(s  => '  ' + fmtTime(s.time) + ': vol=' + Math.round(s.volume/1000) + 'k (' + s.ratio + 'sig)').join('\n') || '  none';
    const swingHighsText = ctx.swingHighs.slice(0, 5).map(s => '  ' + fmtTime(s.time) + ': $' + s.price).join('\n') || '  none';
    const swingLowsText  = ctx.swingLows.slice(0, 5).map(s  => '  ' + fmtTime(s.time) + ': $' + s.price).join('\n') || '  none';

    const postMoveText = ctx.type === 'Short'
        ? `After exit, price continued DOWN to $${ctx.postLow} (missed: $${ctx.missedMove}/share). After-hours low: $${ctx.ahLow ?? 'N/A'}`
        : `After exit, price continued UP to $${ctx.postHigh} (missed: $${ctx.missedMove}/share). After-hours high: $${ctx.ahHigh ?? 'N/A'}`;

    const timeCtx = ctx.exitBeforeOpen
        ? 'EXIT WAS PRE-MARKET (' + Math.abs(ctx.minutesFromOpen) + ' min BEFORE 9:30 open)'
        : 'Exit was ' + ctx.minutesFromOpen + ' min after 9:30 open';

    const levelsText = ctx.keyLevels.length
        ? ctx.keyLevels.map(l => '  $' + l.price + ' (' + l.touches + ' touches)').join('\n')
        : '  none detected';

    const patternsText = ctx.patterns.length
        ? ctx.patterns.map(p => '  ' + p.type + ' at ' + p.time + ' near $' + p.price).join('\n')
        : '  none detected';

    const vwapLines = [];
    if (ctx.vwapAtEntry) vwapLines.push('  At entry: VWAP=$' + ctx.vwapAtEntry + ' (price ' + (ctx.entry > ctx.vwapAtEntry ? 'ABOVE' : 'BELOW') + ' VWAP)');
    if (ctx.vwapAtExit)  vwapLines.push('  At exit:  VWAP=$' + ctx.vwapAtExit  + ' (price ' + (ctx.exit  > ctx.vwapAtExit  ? 'ABOVE' : 'BELOW') + ' VWAP)');
    const vwapText = vwapLines.join('\n') || '  no VWAP data';

    const pmText = (ctx.pmHigh && ctx.pmLow)
        ? `Pre-market range: $${ctx.pmLow} – $${ctx.pmHigh}`
        : 'No pre-market data';
    const ahText = (ctx.ahHigh && ctx.ahLow)
        ? `After-hours range: $${ctx.ahLow} – $${ctx.ahHigh}`
        : 'No after-hours data';

    const lines = [
        `You are a professional prop trader analyst. Analyze this ${dir} trade on ${ctx.symbol} and return ONLY valid JSON. All text fields MUST be in Ukrainian.`,
        '',
        '## TRADE DATA',
        `Symbol: ${ctx.symbol} | Direction: ${dir} | Date: ${ctx.dateStr}`,
        `Entry: $${ctx.entry} at ${ctx.openedStr} | Exit: $${ctx.exit} at ${ctx.closedStr}`,
        `Qty: ${ctx.qty} | Net P&L: ${pnlSign}$${ctx.net.toFixed(2)} | Duration: ${ctx.durationMin} min`,
        `ATR(1-min): $${ctx.atr} | Entry vol ratio: ${ctx.entryVolRatio}x | Exit vol ratio: ${ctx.exitVolRatio}x`,
        `${timeCtx} | Session trend: ${ctx.sessionTrend}`,
        `${pmText} | ${ahText}`,
        '',
        '## KEY SUPPORT / RESISTANCE LEVELS (full session, by touch count)',
        '  Identify which levels acted as support, resistance, or breakout triggers.',
        levelsText,
        '',
        '## VWAP ANALYSIS',
        '  Was the entry/exit above or below VWAP? Did price respect VWAP as S/R?',
        vwapText,
        '',
        '## CHART PATTERNS DETECTED (full session)',
        '  Identify Bull Flag, Bear Flag, Double Top/Bottom, Head & Shoulders, etc.',
        patternsText,
        '',
        '## SWING HIGHS / LOWS (full session)',
        'Highs:\n' + swingHighsText,
        'Lows:\n'  + swingLowsText,
        '',
        '## PRE-MARKET OHLCV (04:00–09:30 ET)',
        preMarketBlock,
        '',
        '## OHLCV FROM PRE-MARKET TO ENTRY (context before trade)',
        preTradeBlock,
        '',
        '## OHLCV DURING TRADE (1-min, ET)',
        tradeBlock,
        '',
        '## VOLUME SPIKES DURING TRADE',
        spikesText,
        '',
        '## POST-EXIT PRICE ACTION (until market close or after-hours)',
        postExitBlock,
        postMoveText,
        'Post-exit volume spikes: ' + postSpikesText,
        '',
        '## AFTER-HOURS OHLCV (16:00–20:00 ET)',
        afterHoursBlock,
        '',
        '## EXIT LOGIC CLASSIFICATION',
        'Classify exit as one of:',
        '  logical   — exit at a key S/R level, pattern completion, or VWAP, with supporting volume',
        '  emotional — exit on fear/panic, no clear level, low volume, or premature stop-out',
        '  mixed     — partial logic with emotional override (e.g. took profit early at a level but left size on)',
        '',
        '## TASK — return ONLY this JSON object, no markdown, no extra text, all string values in Ukrainian:',
        '{',
        '  "story": "3-4 sentence narrative covering: pre-market context, session trend, key S/R levels tested, chart pattern if any, and how the trade fit the overall session structure",',
        '  "exit_logic": "logical|emotional|mixed",',
        '  "exit_reasoning": "1-2 sentences: was the exit at a key level/VWAP/pattern? Was volume confirming? Was it systematic or reactive?",',
        '  "key_events": [{"time": "HH:MM", "type": "entry|exit|volume_spike|swing_high|swing_low|missed_move|warning|pattern|level_test", "insight": "short Ukrainian note"}],',
        '  "execution_grade": "A|B|C|D",',
        '  "grade_reasoning": "1-2 sentences: entry quality relative to S/R and VWAP, exit quality, risk management",',
        '  "risk_notes": "1 sentence: was position size appropriate for ATR? Was there a clear stop level?",',
        '  "missed_opportunity": "1 sentence describing what better exit/entry would have looked like, or null if execution was optimal",',
        '  "key_levels_analysis": "which specific price levels acted as support/resistance and how they influenced the trade",',
        '  "pattern_analysis": "which chart pattern(s) were present and whether the trade aligned with or against the pattern, or null",',
        '  "volume_analysis": "compare entry/exit volume to session average; did volume confirm the move or signal weakness?"',
        '}',
        'Grade rubric: A=entry from key level+VWAP alignment+logical exit with volume confirmation, B=good entry+readable exit+minor timing issue, C=reactive entry or emotional exit+low volume, D=panic/FOMO/no stop/against session trend',
    ];

    const prompt = lines.join('\n');

    return {
        prompt,
        payload: {
            systemInstruction: { parts: [{ text: 'You are a quantitative trading analyst. Reply ONLY with valid JSON. No markdown. All text fields in Ukrainian.' }] },
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 3000 },
        },
    };
}

// ─── Part 3: Gemini Call + JSON Parser ────────────────────────────────────────

function parseStoryJSON(raw) {
    if (!raw || typeof raw !== 'string') throw new Error('Empty response from Gemini');

    let text = raw.trim();

    // If the proxy returned a JSON-encoded string (double-quoted), unwrap it once.
    // JSON.parse natively decodes \uXXXX sequences to real Unicode characters.
    if (text.startsWith('"') && text.endsWith('"')) {
        try { text = JSON.parse(text); } catch (_) {}
    }

    // Direct parse — handles \uXXXX Cyrillic sequences natively
    try { return JSON.parse(text); } catch (_) {}

    // Strip markdown fence if present
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();

    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
        console.warn('[TradeStory] no JSON found, raw length:', raw.length);
        throw new Error('No JSON object found in Gemini response');
    }

    const jsonStr = text.slice(start, end + 1)
        .replace(/,\s*([}\]])/g, '$1');  // trailing commas

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        const pos = parseInt(e.message.match(/position (\d+)/)?.[1] || '0');
        console.warn('[TradeStory] parse error at pos', pos, ':', JSON.stringify(jsonStr.slice(Math.max(0, pos - 30), pos + 30)));
        throw new Error('JSON parse error: ' + e.message);
    }
}

export async function analyzeTradeStory(trade, candles, dateStr) {
    const ctx = buildTradeContext(trade, candles, dateStr);
    if (!ctx) throw new Error('Not enough candle data for this trade');

    const { payload } = buildStoryPrompt(ctx);
    const raw    = await callGeminiJSON(null, payload);
    const result = parseStoryJSON(raw);
    result._ctx  = ctx;
    return result;
}

// ─── Part 4: Chart Overlay Renderer ──────────────────────────────────────────

const GRADE_COLOR = { A: '#10b981', B: '#3b82f6', C: '#f59e0b', D: '#ef4444' };
const EVENT_COLOR = {
    entry: '#f97316', exit: '#10b981', volume_spike: '#a78bfa',
    swing_high: '#ef4444', swing_low: '#22d3ee', missed_move: '#fbbf24', warning: '#f87171',
    pattern: '#818cf8', level_test: '#38bdf8',
};

let _activeTooltip = null;
function closeActiveTooltip() {
    if (_activeTooltip) { _activeTooltip.remove(); _activeTooltip = null; }
}

function eventTimeToTs(timeStr, dateStr) {
    return Math.floor(new Date(`${dateStr}T${timeStr}:00${getNYOffset(dateStr)}`).getTime() / 1000);
}

function renderTooltip(container, pinEl, event, isDark) {
    closeActiveTooltip();
    const bg = isDark ? '#1e293b' : '#f8fafc', border = isDark ? '#334155' : '#cbd5e1';
    const text = isDark ? '#f1f5f9' : '#0f172a', muted = isDark ? '#94a3b8' : '#64748b';
    const color = EVENT_COLOR[event.type] || '#94a3b8';

    const tip = document.createElement('div');
    tip.style.cssText = `position:absolute;z-index:100;background:${bg};border:1px solid ${border};border-radius:8px;padding:10px 14px;max-width:260px;min-width:180px;color:${text};font-size:0.8rem;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,0.35);pointer-events:auto;`;
    tip.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="color:${color};font-weight:700;font-size:0.75rem;">${event.type.replace(/_/g,' ').toUpperCase()}</span><span style="color:${muted};font-size:0.72rem;">${event.time} EST</span></div><div style="color:${text}">${event.insight}</div>`;
    tip.addEventListener('click', closeActiveTooltip);
    container.appendChild(tip);
    _activeTooltip = tip;

    const pr = pinEl.getBoundingClientRect(), cr = container.getBoundingClientRect();
    let left = pr.left - cr.left - 10, top = pr.top - cr.top - tip.offsetHeight - 12;
    if (left + 260 > cr.width) left = cr.width - 270;
    if (left < 0) left = 4;
    if (top  < 0) top  = pr.bottom - cr.top + 8;
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
}

function renderSummaryPanel(container, result, isDark) {
    container.querySelector('#ts-summary-panel')?.remove();
    const grade = result.execution_grade || '?';
    const color = GRADE_COLOR[grade] || '#94a3b8';
    const bg     = isDark ? 'rgba(15,23,42,0.97)' : 'rgba(248,250,252,0.97)';
    const border = isDark ? '#334155' : '#cbd5e1';
    const text   = isDark ? '#f1f5f9' : '#0f172a';
    const muted  = isDark ? '#94a3b8' : '#64748b';

    const exitBadgeText = result.exit_logic === 'logical'  ? '\u2713 Логічний вихід'
                        : result.exit_logic === 'emotional' ? '\u26a0 Емоційний вихід'
                        : '~ Змішаний';
    const exitBadgeColor = result.exit_logic === 'logical' ? '#10b981'
                         : result.exit_logic === 'emotional' ? '#ef4444' : '#f59e0b';

    const panel = document.createElement('div');
    panel.id = 'ts-summary-panel';
    panel.style.cssText = [
        'position:absolute', 'top:40px', 'left:8px', 'z-index:20',
        'background:' + bg, 'border:1px solid ' + border, 'border-radius:10px',
        'padding:12px 14px', 'width:270px', 'color:' + text, 'font-size:0.78rem',
        'line-height:1.55', 'backdrop-filter:blur(6px)',
        'box-shadow:0 4px 24px rgba(0,0,0,0.35)',
        'max-height:calc(100% - 24px)', 'overflow-y:auto', 'scrollbar-width:thin',
    ].join(';');

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';

    const gradeCircle = document.createElement('div');
    gradeCircle.style.cssText = 'flex-shrink:0;width:34px;height:34px;border-radius:50%;background:' + color + '22;border:2px solid ' + color + ';display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:800;color:' + color;
    gradeCircle.textContent = grade;

    const titleBlock = document.createElement('div');
    titleBlock.style.cssText = 'min-width:0;flex:1;';
    const titleLine = document.createElement('div');
    titleLine.style.cssText = 'font-weight:700;font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    titleLine.textContent = (result._ctx?.symbol || '') + ' ' + (result._ctx?.type || '');
    const badgeLine = document.createElement('div');
    badgeLine.style.cssText = 'font-size:0.71rem;color:' + exitBadgeColor + ';';
    badgeLine.textContent = exitBadgeText;
    titleBlock.appendChild(titleLine);
    titleBlock.appendChild(badgeLine);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'ts-close-btn';
    closeBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:' + muted + ';cursor:pointer;font-size:1rem;padding:2px 4px;line-height:1;';
    closeBtn.textContent = '\u2715';

    header.appendChild(gradeCircle);
    header.appendChild(titleBlock);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Story
    const storyEl = document.createElement('div');
    storyEl.style.cssText = 'color:' + muted + ';font-size:0.76rem;margin-bottom:8px;font-style:italic;line-height:1.5;word-break:break-word;';
    storyEl.textContent = '\u00ab' + (result.story || '') + '\u00bb';
    panel.appendChild(storyEl);

    // Details
    const details = document.createElement('div');
    details.style.cssText = 'border-top:1px solid ' + border + ';padding-top:8px;display:flex;flex-direction:column;gap:6px;font-size:0.74rem;';

    const addRow = (label, value, labelColor) => {
        if (!value) return;
        const row = document.createElement('div');
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-weight:600;color:' + labelColor + ';';
        lbl.textContent = label;
        const val = document.createElement('span');
        val.style.color = text;
        val.textContent = value;
        row.appendChild(lbl);
        row.appendChild(val);
        details.appendChild(row);
    };

    addRow('Оцінка: ',      result.grade_reasoning,      muted);
    addRow('Вихід: ',        result.exit_reasoning,       exitBadgeColor);
    addRow('Рівні: ',        result.key_levels_analysis,  '#38bdf8');
    addRow('Патерн: ',       result.pattern_analysis,     '#818cf8');
    addRow('Обсяг: ',        result.volume_analysis,      '#a78bfa');
    addRow('Ризик: ',        result.risk_notes,           '#a78bfa');
    addRow('Пропущено: ',    result.missed_opportunity,   '#fbbf24');

    panel.appendChild(details);
    container.appendChild(panel);
    closeBtn.addEventListener('click', () => { panel.remove(); closeActiveTooltip(); });
}

export function renderStoryOverlay(result, lwChart, container, dateStr) {
    container.querySelectorAll('.ts-pin').forEach(el => el.remove());
    closeActiveTooltip();
    if (!result?.key_events?.length || !lwChart) return;

    const isDark    = document.body.getAttribute('data-theme') !== 'light';
    const timeScale = lwChart.timeScale();
    renderSummaryPanel(container, result, isDark);

    result.key_events.forEach(event => {
        const xCoord = timeScale.timeToCoordinate(eventTimeToTs(event.time, dateStr));
        if (xCoord === null || xCoord < 0) return;

        const color = EVENT_COLOR[event.type] || '#94a3b8';
        const pin   = document.createElement('div');
        pin.className = 'ts-pin';
        pin.style.cssText = `position:absolute;left:${Math.round(xCoord) - 7}px;top:6px;width:14px;height:14px;background:${color};border-radius:50%;border:2px solid ${isDark ? '#0f172a' : '#fff'};cursor:pointer;z-index:15;transition:transform 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.4);`;
        pin.addEventListener('mouseenter', () => { pin.style.transform = 'scale(1.4)'; });
        pin.addEventListener('mouseleave', () => { pin.style.transform = 'scale(1)'; });
        pin.addEventListener('click', e => { e.stopPropagation(); renderTooltip(container, pin, event, isDark); });
        container.appendChild(pin);
    });

    container.addEventListener('click', closeActiveTooltip);

    timeScale.subscribeVisibleTimeRangeChange(() => {
        container.querySelectorAll('.ts-pin').forEach((pin, i) => {
            const ev = result.key_events[i];
            if (!ev) return;
            const x = timeScale.timeToCoordinate(eventTimeToTs(ev.time, dateStr));
            if (x !== null) pin.style.left = `${Math.round(x) - 7}px`;
        });
    });
}
