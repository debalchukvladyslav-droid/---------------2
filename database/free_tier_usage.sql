-- Read-only operator report. Run after recovery/cleanup, then daily while measuring.
begin read only;
select jsonb_build_object(
    'databaseBytes',pg_database_size(current_database()),
    'databaseWriteThresholdBytes',475000000,
    'marketCacheWriteThresholdBytes',430000000,
    'storageBytes',(select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects),
    'storageReservationThresholdBytes',900000000,
    'storageByBucket',(select jsonb_object_agg(bucket_id,bytes) from (
        select bucket_id,sum((metadata->>'size')::bigint) bytes from storage.objects group by bucket_id) b),
    'largestRelations',(select jsonb_agg(to_jsonb(r)) from (
        select schemaname,relname,pg_total_relation_size(relid) bytes
        from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 12) r),
    'restorePointsByOwner',(select jsonb_agg(to_jsonb(p)) from (
        select user_id,count(*) copies from data_recovery.restore_points where scope='full' group by user_id) p),
    'sourceJobs',(select jsonb_object_agg(status,n) from (
        select status,count(*) n from public.source_sync_jobs group by status) j)
) as usage;
rollback;
