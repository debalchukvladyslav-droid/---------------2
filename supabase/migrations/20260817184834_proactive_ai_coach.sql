create table if not exists public.ai_coach_insights (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    trade_date date not null,
    insight_type text not null default 'session_review' check (insight_type in ('session_review','risk_warning','weekly_pattern')),
    status text not null default 'ready' check (status in ('pending','ready','failed','dismissed')),
    severity text not null default 'info' check (severity in ('info','attention','risk')),
    title text not null,
    summary text not null,
    evidence jsonb not null default '[]'::jsonb,
    recommendations jsonb not null default '[]'::jsonb,
    trading_dna_patch jsonb not null default '{}'::jsonb,
    context_snapshot jsonb not null default '{}'::jsonb,
    model_name text,
    prompt_version text not null default 'proactive-coach-v1',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, trade_date, insight_type, prompt_version)
);

create index if not exists ai_coach_insights_user_date_idx on public.ai_coach_insights(user_id, trade_date desc);
alter table public.ai_coach_insights enable row level security;
grant select, update on public.ai_coach_insights to authenticated;
revoke all on public.ai_coach_insights from anon;

create policy ai_coach_insights_select_own on public.ai_coach_insights for select to authenticated
using ((select auth.uid()) = user_id);
create policy ai_coach_insights_update_own on public.ai_coach_insights for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.get_my_ai_coach_context(days_limit integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select jsonb_build_object(
        'days', coalesce((select jsonb_agg(to_jsonb(d) order by d.trade_date desc) from (
            select trade_date, pnl, kf, notes, daily_metrics from public.journal_days
            where user_id = (select auth.uid()) order by trade_date desc limit least(greatest(days_limit, 1), 90)
        ) d), '[]'::jsonb),
        'patterns', coalesce((select jsonb_agg(to_jsonb(p)) from (
            select dimension, pattern_key, sample_size, win_rate, lift, reliability, statistics
            from public.ai_user_patterns where user_id = (select auth.uid()) and active order by reliability desc, sample_size desc limit 20
        ) p), '[]'::jsonb),
        'insights', coalesce((select jsonb_agg(to_jsonb(i) order by i.trade_date desc) from (
            select id, trade_date, severity, title, summary, evidence, recommendations, trading_dna_patch, created_at
            from public.ai_coach_insights where user_id = (select auth.uid()) and status = 'ready' order by trade_date desc limit 10
        ) i), '[]'::jsonb)
    );
$$;
revoke all on function public.get_my_ai_coach_context(integer) from public, anon;
grant execute on function public.get_my_ai_coach_context(integer) to authenticated;
