create index if not exists ai_feedback_insight_id_idx
    on public.ai_feedback (insight_id);

create index if not exists ai_feedback_reviewed_by_idx
    on public.ai_feedback (reviewed_by)
    where reviewed_by is not null;
