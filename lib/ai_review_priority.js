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
