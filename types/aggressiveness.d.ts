export interface DailyBar {
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number;
}

export interface AggressivenessComponents {
    microSmall: number;
    speculative: number;
    broad: number;
    stress: number;
    narrowPenalty: number;
    meltUpPenalty: number;
    liveAdjustment: number;
    detail?: Record<string, { value: number | null; method: string; sample: number }>;
}

export interface AggressivenessResult {
    complete: boolean;
    sessionDate: string;
    infoThrough: string;
    scoreVersion: number;
    baseScore?: number;
    liveScore?: number;
    liveAdjustment?: number | null;
    displayScore?: number;
    label?: string;
    tone?: string;
    confidence?: number | null;
    components?: AggressivenessComponents;
    missing: string[];
    message?: string;
}

export interface BacktestBucket {
    id: string;
    days: number;
    trades: number;
    totalR: number;
    rPerTrade: number | null;
    winRate: number | null;
    avgWinner: number | null;
    avgLoser: number | null;
    positiveDayPct: number | null;
}
