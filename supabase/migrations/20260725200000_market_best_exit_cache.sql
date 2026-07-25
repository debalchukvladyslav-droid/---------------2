-- Shared compact cache for the 09:30-12:00 New York best-exit analysis.
-- Raw minute bars remain at the market-data provider; only the derived low is stored.
CREATE TABLE IF NOT EXISTS public.market_best_exit_cache (
    symbol TEXT NOT NULL CHECK (symbol ~ '^[A-Z]{1,10}$'),
    trade_date DATE NOT NULL,
    entry_minute SMALLINT NOT NULL CHECK (entry_minute >= 570 AND entry_minute < 720),
    low_price NUMERIC NOT NULL CHECK (low_price > 0),
    low_at TIMESTAMPTZ NOT NULL,
    provider TEXT NOT NULL DEFAULT 'polygon',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, trade_date, entry_minute)
);

ALTER TABLE public.market_best_exit_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_best_exit_cache FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS market_best_exit_cache_date_idx
    ON public.market_best_exit_cache (trade_date);
