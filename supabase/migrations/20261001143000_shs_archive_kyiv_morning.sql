-- 09:00 Europe/Kyiv on the morning after a session stores the previous day.
-- Ukraine stays on UTC+3, so 09:00 Kyiv is 06:00 UTC. Tuesday through Saturday
-- covers Monday through Friday sessions, including Friday on Saturday morning.

do $$
declare constraint_name text;
begin
    select conname into constraint_name
    from pg_constraint
    where conrelid = 'public.shs_desk_archives'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%slot%';
    if constraint_name is not null then
        execute format('alter table public.shs_desk_archives drop constraint %I', constraint_name);
    end if;
end $$;

alter table public.shs_desk_archives
    add constraint shs_desk_archives_slot_check
    check (slot in ('1200', '1550', '0900'));

select cron.unschedule(jobid)
from cron.job
where jobname = 'shs-desk-archive-kyiv-morning';

select cron.schedule(
    'shs-desk-archive-kyiv-morning',
    '0 6 * * 2-6',
    $cron$
    with wake as (
        insert into public.shs_archive_wake_tokens default values
        returning token
    )
    select net.http_post(
        url := 'https://traderjournal-six.vercel.app/api/cron/sync-google-sheets?task=shs-archive',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('source', 'supabase-cron', 'wakeToken', wake.token, 'requested_at', now()),
        timeout_milliseconds := 180000
    ) as request_id
    from wake;
    $cron$
);
