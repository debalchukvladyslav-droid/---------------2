-- Daily market cache and immutable Aggressiveness scores.
-- Base columns never change for a (date, score_version) row.
-- A formula change inserts a new score_version and leaves the old row in place.

CREATE TABLE IF NOT EXISTS public.daily_market_bars (
    symbol text NOT NULL,
    bar_date date NOT NULL,
    open numeric,
    high numeric,
    low numeric,
    close numeric NOT NULL,
    provider text NOT NULL DEFAULT 'polygon',
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, bar_date)
);

CREATE INDEX IF NOT EXISTS daily_market_bars_date_idx
    ON public.daily_market_bars (bar_date DESC);

CREATE TABLE IF NOT EXISTS public.daily_market_regime (
    date date NOT NULL,
    score_version integer NOT NULL,
    base_score numeric(6,2) NOT NULL,
    live_score numeric(6,2) NOT NULL,
    live_adjustment numeric(5,2) NOT NULL,
    micro_small_score numeric(6,2) NOT NULL,
    speculative_score numeric(6,2) NOT NULL,
    broad_score numeric(6,2) NOT NULL,
    stress_score numeric(6,2) NOT NULL,
    narrow_penalty numeric(5,2) NOT NULL,
    meltup_penalty numeric(5,2) NOT NULL,
    spy_1d numeric,
    spy_5d numeric,
    spy_10d numeric,
    spy_20d numeric,
    spy_rv5 numeric,
    qqq_rs5 numeric,
    qqq_rs10 numeric,
    iwm_rs5 numeric,
    iwm_rs10 numeric,
    iwc_rs5 numeric,
    iwc_rs10 numeric,
    xbi_rs5 numeric,
    xbi_rs10 numeric,
    arkk_rs5 numeric,
    arkk_rs10 numeric,
    smh_rs5 numeric,
    smh_rs10 numeric,
    vix numeric,
    vix_1d numeric,
    vix_5d numeric,
    us10y numeric,
    us10y_5d_bp numeric,
    oil numeric,
    oil_1d numeric,
    oil_5d numeric,
    mechanical_entries integer,
    mechanical_total_r numeric,
    mechanical_r_per_trade numeric,
    mechanical_win_rate numeric,
    mechanical_avg_winner numeric,
    mechanical_avg_loser numeric,
    info_through date NOT NULL,
    live_frozen boolean NOT NULL DEFAULT false,
    live_updated_at timestamptz,
    calculated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (date, score_version),
    CONSTRAINT daily_market_regime_score_range CHECK (
        base_score BETWEEN 0 AND 100
        AND live_score BETWEEN 0 AND 100
        AND live_adjustment BETWEEN -8 AND 8
        AND score_version > 0
    )
);

CREATE INDEX IF NOT EXISTS daily_market_regime_date_idx
    ON public.daily_market_regime (date DESC);

COMMENT ON TABLE public.daily_market_regime IS
    'Aggressiveness for mechanical pump-and-dump shorts. Base score is immutable per score_version. Do not train it on manual journal PnL.';

CREATE OR REPLACE FUNCTION public.protect_daily_market_regime()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.date IS DISTINCT FROM OLD.date
        OR NEW.score_version IS DISTINCT FROM OLD.score_version
        OR NEW.base_score IS DISTINCT FROM OLD.base_score
        OR NEW.micro_small_score IS DISTINCT FROM OLD.micro_small_score
        OR NEW.speculative_score IS DISTINCT FROM OLD.speculative_score
        OR NEW.broad_score IS DISTINCT FROM OLD.broad_score
        OR NEW.stress_score IS DISTINCT FROM OLD.stress_score
        OR NEW.narrow_penalty IS DISTINCT FROM OLD.narrow_penalty
        OR NEW.meltup_penalty IS DISTINCT FROM OLD.meltup_penalty
        OR NEW.spy_1d IS DISTINCT FROM OLD.spy_1d
        OR NEW.spy_5d IS DISTINCT FROM OLD.spy_5d
        OR NEW.spy_10d IS DISTINCT FROM OLD.spy_10d
        OR NEW.spy_20d IS DISTINCT FROM OLD.spy_20d
        OR NEW.spy_rv5 IS DISTINCT FROM OLD.spy_rv5
        OR NEW.qqq_rs5 IS DISTINCT FROM OLD.qqq_rs5
        OR NEW.qqq_rs10 IS DISTINCT FROM OLD.qqq_rs10
        OR NEW.iwm_rs5 IS DISTINCT FROM OLD.iwm_rs5
        OR NEW.iwm_rs10 IS DISTINCT FROM OLD.iwm_rs10
        OR NEW.iwc_rs5 IS DISTINCT FROM OLD.iwc_rs5
        OR NEW.iwc_rs10 IS DISTINCT FROM OLD.iwc_rs10
        OR NEW.xbi_rs5 IS DISTINCT FROM OLD.xbi_rs5
        OR NEW.xbi_rs10 IS DISTINCT FROM OLD.xbi_rs10
        OR NEW.arkk_rs5 IS DISTINCT FROM OLD.arkk_rs5
        OR NEW.arkk_rs10 IS DISTINCT FROM OLD.arkk_rs10
        OR NEW.smh_rs5 IS DISTINCT FROM OLD.smh_rs5
        OR NEW.smh_rs10 IS DISTINCT FROM OLD.smh_rs10
        OR NEW.vix IS DISTINCT FROM OLD.vix
        OR NEW.vix_1d IS DISTINCT FROM OLD.vix_1d
        OR NEW.vix_5d IS DISTINCT FROM OLD.vix_5d
        OR NEW.us10y IS DISTINCT FROM OLD.us10y
        OR NEW.us10y_5d_bp IS DISTINCT FROM OLD.us10y_5d_bp
        OR NEW.oil IS DISTINCT FROM OLD.oil
        OR NEW.oil_1d IS DISTINCT FROM OLD.oil_1d
        OR NEW.oil_5d IS DISTINCT FROM OLD.oil_5d
        OR NEW.info_through IS DISTINCT FROM OLD.info_through
        OR NEW.calculated_at IS DISTINCT FROM OLD.calculated_at
    THEN
        RAISE EXCEPTION 'historical aggressiveness score % version % is immutable', OLD.date, OLD.score_version;
    END IF;

    IF OLD.mechanical_entries IS NOT NULL AND (
        NEW.mechanical_entries IS DISTINCT FROM OLD.mechanical_entries
        OR NEW.mechanical_total_r IS DISTINCT FROM OLD.mechanical_total_r
        OR NEW.mechanical_r_per_trade IS DISTINCT FROM OLD.mechanical_r_per_trade
        OR NEW.mechanical_win_rate IS DISTINCT FROM OLD.mechanical_win_rate
        OR NEW.mechanical_avg_winner IS DISTINCT FROM OLD.mechanical_avg_winner
        OR NEW.mechanical_avg_loser IS DISTINCT FROM OLD.mechanical_avg_loser
    ) THEN
        RAISE EXCEPTION 'stored mechanical results for % are immutable', OLD.date;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_daily_market_regime ON public.daily_market_regime;
CREATE TRIGGER protect_daily_market_regime
    BEFORE UPDATE ON public.daily_market_regime
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_daily_market_regime();

ALTER TABLE public.daily_market_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_market_regime ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_market_bars_read ON public.daily_market_bars;
CREATE POLICY daily_market_bars_read ON public.daily_market_bars
    FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS daily_market_regime_read ON public.daily_market_regime;
CREATE POLICY daily_market_regime_read ON public.daily_market_regime
    FOR SELECT TO authenticated
    USING (true);

REVOKE ALL ON FUNCTION public.protect_daily_market_regime() FROM PUBLIC;
GRANT SELECT ON public.daily_market_bars TO authenticated;
GRANT SELECT ON public.daily_market_regime TO authenticated;
