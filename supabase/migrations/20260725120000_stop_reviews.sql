CREATE TABLE IF NOT EXISTS public.stop_mistakes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stop_mistakes_user_order
    ON public.stop_mistakes(user_id, archived, sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.stop_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    trade_date DATE NOT NULL,
    symbol TEXT NOT NULL CHECK (length(btrim(symbol)) > 0),
    trade_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    screenshot_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
    initial_status TEXT CHECK (initial_status IN ('normal', 'bad', 'uncertain')),
    final_status TEXT CHECK (final_status IN ('normal', 'bad')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, trade_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_stop_reviews_user_date
    ON public.stop_reviews(user_id, trade_date DESC, active);

CREATE TABLE IF NOT EXISTS public.stop_review_mistakes (
    review_id UUID NOT NULL REFERENCES public.stop_reviews(id) ON DELETE CASCADE,
    mistake_id UUID NOT NULL REFERENCES public.stop_mistakes(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (review_id, mistake_id)
);

ALTER TABLE public.stop_mistakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stop_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stop_review_mistakes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stop_mistakes_read_visible_user ON public.stop_mistakes;
CREATE POLICY stop_mistakes_read_visible_user ON public.stop_mistakes
FOR SELECT TO authenticated
USING (public.app_can_view_user(user_id));

DROP POLICY IF EXISTS stop_mistakes_owner_write ON public.stop_mistakes;
CREATE POLICY stop_mistakes_owner_write ON public.stop_mistakes
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS stop_reviews_read_visible_user ON public.stop_reviews;
CREATE POLICY stop_reviews_read_visible_user ON public.stop_reviews
FOR SELECT TO authenticated
USING (public.app_can_view_user(user_id));

DROP POLICY IF EXISTS stop_reviews_owner_write ON public.stop_reviews;
CREATE POLICY stop_reviews_owner_write ON public.stop_reviews
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS stop_review_mistakes_read_visible_user ON public.stop_review_mistakes;
CREATE POLICY stop_review_mistakes_read_visible_user ON public.stop_review_mistakes
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.stop_reviews review
        WHERE review.id = review_id
          AND public.app_can_view_user(review.user_id)
    )
);

DROP POLICY IF EXISTS stop_review_mistakes_owner_write ON public.stop_review_mistakes;
CREATE POLICY stop_review_mistakes_owner_write ON public.stop_review_mistakes
FOR ALL TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.stop_reviews review
        WHERE review.id = review_id
          AND review.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.stop_reviews review
        WHERE review.id = review_id
          AND review.user_id = auth.uid()
    )
    AND EXISTS (
        SELECT 1 FROM public.stop_mistakes mistake
        WHERE mistake.id = mistake_id
          AND mistake.user_id = auth.uid()
    )
);

NOTIFY pgrst, 'reload schema';
