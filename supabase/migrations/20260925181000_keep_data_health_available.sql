-- A busy sync used to cancel this read at the 8s authenticated limit and
-- PostgREST returned 500. Finish quickly, and if the database is still too
-- busy, answer with a small payload instead of an error.
create or replace function public.get_data_health(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_owner_id uuid := data_recovery.authorize_owner(p_user_id, false);
    result jsonb;
begin
    perform set_config('statement_timeout', '2500ms', true);
    perform set_config('lock_timeout', '1500ms', true);
    begin
        select jsonb_build_object(
            'lastRestorePointAt', (select max(created_at) from data_recovery.restore_points where user_id = v_owner_id),
            'unresolvedConflicts', (select count(*) from data_recovery.data_conflicts where user_id = v_owner_id and resolved_at is null),
            'offsite', (
                select jsonb_build_object('status', status, 'startedAt', started_at, 'completedAt', completed_at, 'manifest', manifest)
                from data_recovery.backup_runs
                order by started_at desc
                limit 1
            ),
            'usage', jsonb_build_object(
                'databaseBytes', pg_database_size(current_database()),
                'storageBytes', coalesce((
                    select sum(case
                        when coalesce(o.metadata->>'size', '') ~ '^[0-9]+$' then (o.metadata->>'size')::bigint
                        else 0
                    end)
                    from storage.objects o
                    where o.name = v_owner_id::text
                       or o.name like (v_owner_id::text || '/%')
                       or (
                            o.bucket_id = 'files'
                            and (
                                o.name = ('screenshots/' || v_owner_id::text)
                                or o.name like ('screenshots/' || v_owner_id::text || '/%')
                            )
                       )
                ), 0)
            ),
            'integrationJobs', jsonb_build_object(
                'errors', (select count(*) from public.source_sync_jobs where user_id = v_owner_id and status = 'error'),
                'overdue', (
                    select count(*) from public.source_sync_jobs
                    where user_id = v_owner_id
                      and status in ('queued', 'running')
                      and coalesce(lease_until, next_attempt_at) < now() - interval '10 minutes'
                )
            ),
            'historyRetentionDays', 30,
            'offsiteStale', not exists (
                select 1 from data_recovery.backup_runs
                where status = 'verified' and completed_at > now() - interval '26 hours'
            ),
            'bytesProtectedIndependently', exists (
                select 1 from data_recovery.backup_runs
                where status = 'verified' and completed_at > now() - interval '26 hours'
            )
        ) into result;
    exception
        when query_canceled or lock_not_available then
            return jsonb_build_object('unavailable', true, 'historyRetentionDays', 30);
    end;
    return result;
end
$$;

alter function public.get_data_health(uuid) set statement_timeout = '4s';
alter function public.get_data_health(uuid) set lock_timeout = '2s';

notify pgrst, 'reload schema';
