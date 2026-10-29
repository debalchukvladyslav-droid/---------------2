-- Run with psql -v database_budget=20000000 -f scripts/check-backup-budget.sql.
-- Check logical row bytes before a scheduled full dump. No user data is returned.
-- This is a source-size ceiling, not a measurement of the provider's billed egress.
begin;
create function pg_temp.check_backup_budget(p_limit bigint)
returns jsonb language plpgsql as $$
declare item record; bytes bigint; total bigint:=0;
begin
    if p_limit<1 then raise exception 'Invalid database backup budget'; end if;
    for item in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind in ('r','m') and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
          and (n.nspname,c.relname) not in (
            ('data_recovery','change_history'),('data_recovery','restore_points'),('cron','job_run_details'),
            ('public','polygon_bars'),('public','market_time_price_cache'),('public','market_best_exit_cache'))
        order by n.nspname,c.relname
    loop
        execute format('select coalesce(sum(octet_length(t::text)),0) from %I.%I t',item.nspname,item.relname) into bytes;
        total:=total+bytes;
        if total>p_limit then
            raise exception 'DATABASE_BACKUP_BUDGET_LIMIT: logical source exceeds % bytes; scheduled dump stopped. Archive or review data growth before increasing the budget.',p_limit;
        end if;
    end loop;
    return jsonb_build_object('logicalSourceBytes',total,'budgetBytes',p_limit);
end $$;
select pg_temp.check_backup_budget(:'database_budget'::bigint);
rollback;
