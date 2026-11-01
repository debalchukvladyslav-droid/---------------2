-- Run when Disk IO budget has recovered enough for short writes.
-- Safe to re-run. Does not touch journal_days / trades / live user_settings.
-- After deletes, reclaim physical space in a quiet window:
--   vacuum (full, analyze) data_recovery.change_history;
--   vacuum (full, analyze) data_recovery.restore_points;
--   vacuum (analyze) cron.job_run_details;

begin;
set local statement_timeout = '120s';
set local lock_timeout = '15s';

-- Batch slim: empty setting history payloads (sync reads live user_settings).
with batch as (
    select id
    from data_recovery.change_history
    where domain = 'setting'
      and (old_record is not null or (new_record is not null and new_record <> '{}'::jsonb))
    order by id
    limit 500
)
update data_recovery.change_history h
set old_record = null,
    new_record = case when h.new_record is null then null else '{}'::jsonb end
from batch b
where h.id = b.id;

-- Keep three newest full restore points per account (owner free-tier policy).
with doomed as (
    select id
    from (
        select id,
            row_number() over (partition by user_id order by created_at desc, id desc) as rank
        from data_recovery.restore_points
        where scope = 'full'
    ) ranked
    where rank > 3
)
delete from data_recovery.restore_points p
using doomed d
where p.id = d.id;

delete from cron.job_run_details where end_time < now() - interval '7 days';

select jsonb_build_object(
    'restorePoints', (select count(*) from data_recovery.restore_points),
    'settingMarkers', (
        select count(*) from data_recovery.change_history
        where domain = 'setting' and new_record = '{}'::jsonb
    ),
    'dbSize', pg_size_pretty(pg_database_size(current_database()))
) as status;
commit;
