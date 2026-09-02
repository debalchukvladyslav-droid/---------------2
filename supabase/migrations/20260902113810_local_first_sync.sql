-- Local-first journal synchronization primitives. Existing REST writes remain
-- compatible; clients can adopt these functions progressively.

alter table public.journal_days
    add column if not exists sync_version bigint not null default 1,
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_journal_days_user_updated
    on public.journal_days (user_id, updated_at desc);

create or replace function public.touch_journal_day_sync_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    new.updated_at := now();
    if tg_op = 'UPDATE' then
        new.sync_version := greatest(coalesce(old.sync_version, 0) + 1, coalesce(new.sync_version, 0));
    end if;
    return new;
end;
$$;

drop trigger if exists trg_journal_days_sync_version on public.journal_days;
create trigger trg_journal_days_sync_version
before insert or update on public.journal_days
for each row execute function public.touch_journal_day_sync_version();

drop function if exists public.sync_journal_days_batch(jsonb);
create function public.sync_journal_days_batch(payload jsonb)
returns table (id uuid, trade_date date, sync_version bigint, updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Authentication required';
    end if;

    return query
    insert into public.journal_days as target (
        user_id, trade_date, pnl, gross_pnl, commissions, locates, kf,
        notes, mentor_comment, ai_advice, daily_metrics
    )
    select
        auth.uid(), source.trade_date, source.pnl, source.gross_pnl,
        source.commissions, source.locates, source.kf, coalesce(source.notes, ''),
        coalesce(source.mentor_comment, ''), coalesce(source.ai_advice, ''),
        coalesce(source.daily_metrics, '{}'::jsonb)
    from jsonb_to_recordset(coalesce(payload, '[]'::jsonb)) as source (
        trade_date date, pnl numeric, gross_pnl numeric, commissions numeric,
        locates numeric, kf numeric, notes text, mentor_comment text,
        ai_advice text, daily_metrics jsonb
    )
    on conflict on constraint journal_days_user_id_trade_date_key do update set
        pnl = excluded.pnl,
        gross_pnl = excluded.gross_pnl,
        commissions = excluded.commissions,
        locates = excluded.locates,
        kf = excluded.kf,
        notes = excluded.notes,
        mentor_comment = excluded.mentor_comment,
        ai_advice = excluded.ai_advice,
        daily_metrics = excluded.daily_metrics
    returning target.id, target.trade_date, target.sync_version, target.updated_at;
end;
$$;

create or replace function public.get_app_bootstrap(
    target_user_id uuid default auth.uid(),
    date_from date default (date_trunc('month', current_date) - interval '1 month')::date,
    date_to date default (date_trunc('month', current_date) + interval '1 month - 1 day')::date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'profile', coalesce((
            select to_jsonb(p) from public.profiles p where p.id = target_user_id
        ), '{}'::jsonb),
        'journal_days', coalesce((
            select jsonb_agg(to_jsonb(j) order by j.trade_date)
            from public.journal_days j
            where j.user_id = target_user_id
              and j.trade_date between date_from and date_to
        ), '[]'::jsonb),
        'server_time', now()
    );
$$;

revoke all on function public.sync_journal_days_batch(jsonb) from public;
revoke all on function public.get_app_bootstrap(uuid, date, date) from public;
grant execute on function public.sync_journal_days_batch(jsonb) to authenticated;
grant execute on function public.get_app_bootstrap(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';
