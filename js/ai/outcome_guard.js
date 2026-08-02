const POST_TRADE_FIELDS = new Set([
    'exitTime', 'exitPrice', 'exitReason', 'tradeComment',
    'dayNotes', 'mistakes', 'nextSession',
]);

export function outcomeBlindJournalContext(context = {}) {
    return Object.fromEntries(Object.entries(context || {})
        .filter(([key]) => !POST_TRADE_FIELDS.has(key)));
}

export function requireVisualPatternEvidence(result = {}) {
    if (
        !['unclear', 'insufficient_data'].includes(result.patternKey)
        && String(result.visualEvidence || '').trim().length < 12
    ) {
        return {
            ...result,
            patternKey: 'unclear',
            label: 'Потрібна ручна перевірка',
            confidence: Math.min(Number(result.confidence) || 0, 0.35),
        };
    }
    return result;
}
