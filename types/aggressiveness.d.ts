export interface DailyBar {
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number;
}

export interface AggressivenessComponents {
    smallMicro: number | null;
    breadth: number | null;
    speculative: number | null;
    broadMarket: number | null;
    macro: number | null;
    analog: number | null;
    ruleScore: number | null;
    microSmall?: number | null;
    broad?: number | null;
    stress?: number | null;
    narrowPenalty: number;
    meltUpPenalty: number;
    liveAdjustment: number;
}

export interface AggressivenessResult {
    complete: boolean;
    sessionDate: string;
    infoThrough: string;
    scoreVersion: number;
    ruleScore?: number | null;
    analogScore?: number | null;
    baseScore?: number | null;
    liveScore?: number | null;
    liveAdjustment?: number | null;
    displayScore?: number | null;
    label?: string;
    tone?: string;
    confidence?: number | null;
    components?: AggressivenessComponents;
    missing: string[];
    coverageGaps?: string[];
    breadthUnavailable?: boolean;
    message?: string;
}

export interface BacktestBucket {
    id: string;
    days: number;
    trades: number;
    totalR: number;
    rPerTrade: number | null;
    medianRPerTrade: number | null;
    winRate: number | null;
    avgWinner: number | null;
    avgLoser: number | null;
    positiveDayPct: number | null;
}
