const UNCERTAIN = new Set(['unclear', 'insufficient_data']);

export function reviewPriority(example = {}) {
    const confidence = Math.max(0, Math.min(1, Number(example.ai_confidence) || 0));
    const features = example.source_snapshot?.aiFeatures || {};
    const missing = Array.isArray(features.evidence?.missing) ? features.evidence.missing.length : 0;
    const hasJournalCriteria = Boolean(example.source_snapshot?.criteria || example.source_snapshot?.setup);
    let score = example.screenshot_path ? 10 : -10;
    const reasons = [];
    if (example.screenshot_path) reasons.push('є скріншот');
    if (UNCERTAIN.has(example.ai_pattern_key)) { score += 4; reasons.push('AI утримався від висновку'); }
    if (confidence >= 0.25 && confidence <= 0.75) { score += 3; reasons.push('межова впевненість'); }
    if (!UNCERTAIN.has(example.ai_pattern_key) && confidence >= 0.75) { score += 2; reasons.push('аудит впевненого прогнозу'); }
    if (missing) { score += Math.min(3, missing); reasons.push(`бракує доказів: ${missing}`); }
    if (hasJournalCriteria) { score += 1; reasons.push('є критерії журналу'); }
    if (example.alternative_pattern_key) { score += 1; reasons.push('є альтернативний патерн'); }
    return { score, reasons };
}

export function prioritizeReviewExamples(examples = []) {
    return [...examples].map((example) => ({ ...example, review_priority: reviewPriority(example) }))
        .sort((a, b) => b.review_priority.score - a.review_priority.score
            || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function reviewDimension(example, name) {
    if (name === 'ticker') return String(example.source_snapshot?.snapshot?.ticker || example.source_snapshot?.ticker || '').toUpperCase();
    if (name === 'date') return String(example.trade_date || '');
    return String(example.ai_pattern_key || 'unknown');
}

export function diversifyReviewExamples(examples = []) {
    const remaining = prioritizeReviewExamples(examples);
    const selected = [];
    const counts = { ticker: new Map(), date: new Map(), pattern: new Map() };
    const count = (dimension, item) => counts[dimension].get(reviewDimension(item, dimension)) || 0;
    while (remaining.length) {
        let bestIndex = 0;
        let bestValue = -Infinity;
        for (let index = 0; index < remaining.length; index++) {
            const item = remaining[index];
            const diversityPenalty = count('ticker', item) * 5 + count('pattern', item) * 2 + count('date', item);
            const value = item.review_priority.score - diversityPenalty;
            if (value > bestValue) { bestValue = value; bestIndex = index; }
        }
        const [chosen] = remaining.splice(bestIndex, 1);
        selected.push(chosen);
        for (const dimension of Object.keys(counts)) {
            const key = reviewDimension(chosen, dimension);
            counts[dimension].set(key, (counts[dimension].get(key) || 0) + 1);
        }
    }
    return selected;
}
