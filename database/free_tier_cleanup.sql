-- Run only after archive-recovery.mjs has verified the external archives.
-- This is a dry run by default: the final ROLLBACK must be replaced by COMMIT
-- only after the counts have been reviewed. Storage bytes are NEVER deleted SQL-side.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create temporary table history_to_retire(id bigint primary key,user_id uuid,cursor bigint) on commit drop;
with fingerprints as materialized (
    select id,user_id,entity_id,cursor,encode(sha256(convert_to(new_record::text,'UTF8')),'hex') as hash
    from data_recovery.change_history where domain='setting'
), compared as (
    select *,lag(hash) over(partition by user_id,entity_id order by cursor) as previous_hash
    from fingerprints
), candidates as (
    select h.id,h.user_id,h.cursor from data_recovery.change_history h
    left join compared c on c.id=h.id
    where h.created_at<now()-interval '30 days'
       or (h.domain='setting' and c.hash=c.previous_hash)
       or (h.table_name='integration_connections' and h.old_record is not null and h.new_record is not null
           and (h.old_record-array['verified_at','last_sync_at','last_revision','last_error','next_sync_at'])
              is not distinct from (h.new_record-array['verified_at','last_sync_at','last_revision','last_error','next_sync_at']))
)
insert into history_to_retire
select c.* from candidates c
where exists(select 1 from data_recovery.history_archives a where a.verified_at is not null and a.row_ids @> array[c.id]);

create temporary table points_to_retire(id uuid primary key) on commit drop;
insert into points_to_retire
select p.id from (select id,user_id,checksum,row_number() over(partition by user_id order by created_at desc,id desc) as rank
    from data_recovery.restore_points) p
join data_recovery.restore_point_archives a on a.restore_point_id=p.id and a.user_id=p.user_id and a.checksum=p.checksum
where p.rank>3 and a.verified_at is not null;

-- Acquire the same owner locks as normal writes, in deterministic order.
do $$ declare owner_id uuid; begin
    for owner_id in select distinct user_id from history_to_retire order by user_id loop
        perform data_recovery.lock_owner(owner_id);
    end loop;
end $$;

update data_recovery.owner_state s
set minimum_cursor=greatest(s.minimum_cursor,r.cursor)
from (select user_id,max(cursor) as cursor from history_to_retire group by user_id) r where r.user_id=s.user_id;
delete from data_recovery.change_history h using history_to_retire r where h.id=r.id;
delete from data_recovery.restore_points p using points_to_retire r where p.id=r.id;

select jsonb_build_object('historyRows',(select count(*) from history_to_retire),
    'restorePoints',(select count(*) from points_to_retire),
    'remainingRestorePoints',(select count(*) from data_recovery.restore_points),
    'storageObjectsDeleted',0) as cleanup;
rollback;

-- Physical space is reclaimed only after an approved COMMIT. VACUUM FULL locks
-- the named table while rewriting its surviving rows. Run separately in a quiet window:
-- vacuum (full, analyze) data_recovery.change_history;
-- vacuum (full, analyze) data_recovery.restore_points;
