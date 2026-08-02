const TRADEABLE_PATTERNS = new Set([
    'valid_entry', 'breakout_retest', 'pullback_entry', 'liquidity_sweep',
    'range_entry', 'trend_continuation', 'confirmed_reversal',
]);

const REQUIRED_SCORE_KEYS = ['setupValidity', 'contextFit', 'entryQuality', 'riskPlan', 'executionReadiness'];

function finiteScore(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function normalizeDirection(value) {
    const direction = String(value || '').trim().toLowerCase();
    if (['long', 'buy'].includes(direction)) return 'LONG';
    if (['short', 'sell'].includes(direction)) return 'SHORT';
    return null;
}

function visibleEvidence(analysis) {
    return Array.isArray(analysis?.analysis_features?.evidence?.visible)
        ? analysis.analysis_features.evidence.visible.map(String).filter(Boolean)
        : [];
}

export function buildPaperTradeDecision(analysis = {}, snapshot = {}, patternStats = null) {
    const pattern = String(analysis.ai_pattern_key || 'unclear');
    const confidence = Math.max(0, Math.min(1, Number(analysis.ai_confidence) || 0));
    const scores = analysis?.analysis_features?.processScores || {};
    const normalizedScores = Object.fromEntries(REQUIRED_SCORE_KEYS.map((key) => [key, finiteScore(scores[key])]));
    const evidence = visibleEvidence(analysis);
    const missing = Array.isArray(analysis?.analysis_features?.evidence?.missing)
        ? analysis.analysis_features.evidence.missing.map(String).filter(Boolean)
        : [];
    const direction = normalizeDirection(snapshot.direction);
    const reasons = [];

    if (!TRADEABLE_PATTERNS.has(pattern)) reasons.push('pattern_not_tradeable');
    if (confidence < 0.82) reasons.push('confidence_below_82');
    if (!direction) reasons.push('direction_unknown');
    if (evidence.length < 2) reasons.push('visual_evidence_incomplete');
    if (missing.some((item) => /entry|trigger|confirmation|screenshot|image/i.test(item))) reasons.push('critical_visual_evidence_missing');
    for (const key of REQUIRED_SCORE_KEYS) {
        if (normalizedScores[key] == null || normalizedScores[key] < 70) reasons.push(`${key}_below_70`);
    }

    const reviewedSamples = Number(patternStats?.sample_size || 0);
    const reliability = Number(patternStats?.reliability || patternStats?.precision || 0);
    if (reviewedSamples < 5) reasons.push('reviewed_pattern_samples_below_5');
    if (!Number.isFinite(reliability) || reliability < 0.6) reasons.push('pattern_reliability_below_60');

    const allowed = reasons.length === 0;
    return {
        mode: 'paper',
        action: allowed ? direction : 'SKIP',
        executable: false,
        pattern,
        confidence,
        reasons,
        evidence,
        scores: normalizedScores,
        risk: {
            maxRiskR: allowed ? 0.25 : 0,
            requiresDefinedStop: true,
            requiresLivePriceValidation: true,
        },
        guardrails: {
            brokerOrdersEnabled: false,
            humanApprovalRequired: true,
            outcomeBlind: true,
        },
    };
}

export function canEnableLiveExecution(metrics = {}) {
    return Number(metrics.goldCount) >= 100
        && Number(metrics.holdoutCount) >= 30
        && Number(metrics.selectiveAccuracy) >= 0.75
        && Number(metrics.coverage) >= 0.5
        && Number(metrics.maxPaperDrawdownR) <= 5
        && Number(metrics.paperTrades) >= 100;
}

export function summarizePaperPerformance(signals = []) {
    const resolved = (Array.isArray(signals) ? signals : [])
        .filter((item) => item.action !== 'SKIP' && Number.isFinite(Number(item.outcome_r)))
        .sort((a, b) => String(a.resolved_at || a.observed_at).localeCompare(String(b.resolved_at || b.observed_at)));
    let equityR = 0;
    let peakR = 0;
    let maxDrawdownR = 0;
    let wins = 0;
    let losses = 0;
    for (const signal of resolved) {
        const outcomeR = Number(signal.outcome_r);
        equityR += outcomeR;
        peakR = Math.max(peakR, equityR);
        maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
        if (outcomeR > 0) wins++;
        if (outcomeR < 0) losses++;
    }
    return {
        paperTrades: resolved.length, wins, losses,
        winRate: resolved.length ? wins / resolved.length : null,
        netR: equityR, maxDrawdownR,
        emergencyStop: maxDrawdownR > 5,
    };
}
