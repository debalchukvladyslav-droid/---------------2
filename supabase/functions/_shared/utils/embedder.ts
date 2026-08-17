const compact = (value, max = 1800) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const line = (label, value) => compact(value) ? `${label}: ${compact(value)}` : '';

export function buildUnifiedEmbeddingText({ baseText = '', trade = {}, multimodal = null } = {}) {
    const analysis = trade?.analysisResult && typeof trade.analysisResult === 'object' ? trade.analysisResult : {};
    const visionRaw = multimodal?.vision_analysis || analysis?.vision || '';
    let vision = visionRaw;
    if (typeof visionRaw === 'string' && /^\s*[\[{]/.test(visionRaw)) {
        try { vision = JSON.parse(visionRaw); } catch { vision = visionRaw; }
    }
    const visionText = typeof vision === 'object' && vision
        ? [vision.setup, vision.summary, vision.volumeEvidence, ...(Array.isArray(vision.risks) ? vision.risks : [])].filter(Boolean).join('; ')
        : vision;
    return [
        compact(baseText, 5000),
        line('Unified ticker', trade?.symbol || trade?.ticker),
        line('Unified setup', trade?.setup || trade?.setupType || vision?.setup),
        line('Unified RVOL', trade?.rvol),
        line('Chart vision summary', visionText),
        line('Voice notes', multimodal?.audio_transcript || analysis?.voiceTranscript),
        line('Trade result', trade?.result || trade?.net || trade?.pnl),
    ].filter(Boolean).join('\n').slice(0, 8000);
}

export function multimodalIdForTrade(trade = {}) {
    const id = String(trade?.analysisResult?.multimodalInputId || '');
    return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? id : '';
}
