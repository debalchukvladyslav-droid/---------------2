begin;
create or replace function public.get_data_health(p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); result jsonb;
begin
    select jsonb_build_object('lastRestorePointAt',(select max(created_at) from data_recovery.restore_points where user_id=v_owner_id),
        'unresolvedConflicts',(select count(*) from data_recovery.data_conflicts where user_id=v_owner_id and resolved_at is null),
        'offsite',(select jsonb_build_object('status',status,'startedAt',started_at,'completedAt',completed_at,'manifest',manifest) from data_recovery.backup_runs order by started_at desc limit 1),
        'usage',jsonb_build_object('databaseBytes',pg_database_size(current_database()),'storageBytes',coalesce((select sum(coalesce(nullif(o.metadata->>'size','')::bigint,0))
          from storage.objects o where split_part(o.name,'/',1)=v_owner_id::text or (o.bucket_id='files' and split_part(o.name,'/',1)='screenshots' and split_part(o.name,'/',2)=v_owner_id::text)),0)),
        'integrationJobs',jsonb_build_object('errors',(select count(*) from public.source_sync_jobs where user_id=v_owner_id and status='error'),
          'overdue',(select count(*) from public.source_sync_jobs where user_id=v_owner_id and status in ('queued','running') and coalesce(lease_until,next_attempt_at)<now()-interval '10 minutes')),
        'historyRetentionDays',30,'offsiteStale',not exists(select 1 from data_recovery.backup_runs where status='verified' and completed_at>now()-interval '26 hours'),
        'bytesProtectedIndependently',exists(select 1 from data_recovery.backup_runs where status='verified' and completed_at>now()-interval '26 hours')) into result;
    return result;
end $$;


create or replace function data_recovery.snapshot_owner(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ordering text; t record; tables json; table_queries text[]:='{}'; files jsonb; s data_recovery.owner_state;
begin
    perform data_recovery.lock_owner(p_user_id);
    for t in select * from data_recovery.table_registry where snapshot_enabled and owner_kind<>'global' order by restore_order,table_name loop
        if to_regclass(format('public.%I',t.table_name)) is null then continue; end if;
        -- Sort compact primary keys, never complete JSON documents (large AI data).
        select string_agg(format('t.%I',a.attname),',' order by k.ordinality) into ordering
        from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,ordinality)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
        where i.indrelid=to_regclass(format('public.%I',t.table_name)) and i.indisprimary;
        if ordering is null then raise exception 'Snapshot table % has no primary key',t.table_name; end if;
        table_queries:=array_append(table_queries,format('select %L as name, coalesce(json_agg(t order by %s),''[]''::json) as rows from public.%I t where %s',t.table_name,ordering,t.table_name,data_recovery.owner_predicate(t.table_name)));
    end loop;
    execute 'select json_object_agg(name,rows) from ('||array_to_string(table_queries,' union all ')||') snapshot_tables' into tables using p_user_id;
    select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'path',o.name,'id',o.id,'metadata',o.metadata,'createdAt',o.created_at,'updatedAt',o.updated_at) order by o.bucket_id,o.name),'[]')
        into files from storage.objects o where o.bucket_id in ('screenshots','backgrounds','avatars','trade-charts','files','assets')
        and (split_part(o.name,'/',1)=p_user_id::text or (o.bucket_id='files' and split_part(o.name,'/',1)='screenshots' and split_part(o.name,'/',2)=p_user_id::text));
    select * into s from data_recovery.owner_state where user_id=p_user_id;
    return json_build_object('version',2,'userId',p_user_id,'createdAt',now(),'epoch',s.epoch,'cursor',s.cursor,'tables',tables,'files',files);
end $$;


-- Do not pass the snapshot-bearing composite through point_metadata: SQL
-- composite argument expansion repeatedly materializes the entire payload.
create or replace function data_recovery.create_point(p_user_id uuid,p_reason text,p_snapshot jsonb default null,p_scope text default 'full')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_snapshot jsonb; v_counts jsonb; v_checksum text; v_result jsonb;
begin
    perform data_recovery.lock_owner(p_user_id);
    v_snapshot:=coalesce(p_snapshot,data_recovery.snapshot_owner(p_user_id));
    v_counts:=data_recovery.snapshot_counts(v_snapshot);
    v_checksum:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
    insert into data_recovery.restore_points(user_id,created_by,reason,epoch,cursor,snapshot,checksum,counts,scope)
    select p_user_id,auth.uid(),left(p_reason,120),s.epoch,s.cursor,v_snapshot,v_checksum,v_counts,p_scope
    from data_recovery.owner_state s where s.user_id=p_user_id
    returning jsonb_build_object('id',id,'userId',user_id,'createdAt',created_at,'reason',reason,'epoch',epoch,
        'cursor',cursor,'counts',counts,'checksum',checksum,'scope',scope,'incomplete',scope='legacy-merge',
        'coverage','database-and-file-manifest') into v_result;
    return v_result;
end $$;

create or replace function data_recovery.point_metadata(p data_recovery.restore_points)
returns jsonb language plpgsql stable set search_path='' as $$
begin
    return jsonb_build_object('id',p.id,'userId',p.user_id,'createdAt',p.created_at,'reason',p.reason,'epoch',p.epoch,
        'cursor',p.cursor,'counts',p.counts,'checksum',p.checksum,'scope',p.scope,'incomplete',p.scope='legacy-merge','coverage','database-and-file-manifest');
end
$$;


-- Full snapshots on Free can exceed the normal 8s authenticated query limit.
-- Scope this budget to the recovery RPC, leaving ordinary writes bounded.
alter function public.create_restore_point(text,uuid) set statement_timeout='45s';
notify pgrst, 'reload schema';
commit;

