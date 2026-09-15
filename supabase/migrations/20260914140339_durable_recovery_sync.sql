-- Durable synchronization and recoverable data changes. Deploy with the matching
-- client: legacy whole-journal writes intentionally fail instead of overwriting.
begin;

create schema if not exists data_recovery;
revoke all on schema data_recovery from public, anon, authenticated;
grant usage on schema data_recovery to service_role;
alter default privileges in schema data_recovery revoke execute on functions from public;

create table data_recovery.owner_state (
    user_id uuid primary key,
    epoch bigint not null default 1,
    cursor bigint not null default 0,
    minimum_cursor bigint not null default 0,
    settings_version bigint not null default 1,
    updated_at timestamptz not null default now()
);
create table data_recovery.table_registry (
    table_name text primary key check (table_name ~ '^[a-z_]+$'),
    owner_kind text not null check (owner_kind in ('user_id','profile','review','evaluation','legacy','global')),
    restore_order integer not null,
    snapshot_enabled boolean not null default true
);
create table data_recovery.change_history (
    id bigint generated always as identity primary key,
    user_id uuid not null,
    cursor bigint not null,
    epoch bigint not null,
    table_name text not null,
    entity_id text not null,
    domain text not null,
    old_record jsonb,
    new_record jsonb,
    version bigint not null default 0,
    operation_id uuid,
    actor_id uuid,
    source text not null default 'database',
    created_at timestamptz not null default now(),
    unique(user_id,cursor)
);
create index change_history_owner_entity on data_recovery.change_history(user_id,table_name,entity_id,cursor desc);
create index change_history_retention on data_recovery.change_history(created_at);
create table data_recovery.operation_receipts (
    user_id uuid not null,
    operation_id uuid not null,
    request_hash text not null,
    result jsonb not null,
    created_at timestamptz not null default now(),
    primary key(user_id,operation_id)
);
create table data_recovery.data_conflicts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    operation_id uuid not null,
    domain text not null,
    entity_id text not null,
    base jsonb,
    patch jsonb,
    server_record jsonb,
    reason text not null,
    created_at timestamptz not null default now(),
    resolved_at timestamptz
);
create index data_conflicts_owner on data_recovery.data_conflicts(user_id,created_at desc);
create table data_recovery.restore_points (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    created_at timestamptz not null default now(),
    created_by uuid,
    reason text not null,
    epoch bigint not null,
    cursor bigint not null,
    snapshot jsonb not null,
    checksum text not null,
    counts jsonb not null,
    scope text not null default 'full' check(scope in ('full','legacy-merge')),
    retain_until timestamptz not null default now()+interval '30 days'
);
create index restore_points_owner_created on data_recovery.restore_points(user_id,created_at desc);
create table data_recovery.file_retirements (
    user_id uuid not null,
    storage_path text not null,
    retired_at timestamptz not null default now(),
    purge_after timestamptz not null default now()+interval '30 days',
    externally_verified_at timestamptz,
    primary key(user_id,storage_path)
);
create table data_recovery.backup_runs (
    id uuid primary key default gen_random_uuid(),
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    status text not null check(status in ('running','verified','failed')),
    manifest jsonb not null default '{}',
    error text
);

do $$ declare t text; begin
    for t in select tablename from pg_tables where schemaname='data_recovery' loop
        execute format('alter table data_recovery.%I enable row level security',t);
        execute format('revoke all on data_recovery.%I from public,anon,authenticated',t);
    end loop;
end $$;

create function data_recovery.authorize_owner(p_user_id uuid default null,p_write boolean default true)
returns uuid language plpgsql security definer set search_path='' as $$
declare owner_id uuid := coalesce(p_user_id,auth.uid());
begin
    if owner_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
    if coalesce(auth.jwt()->>'role','')='service_role' then return owner_id; end if;
    if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
    if public.app_is_admin() then return owner_id; end if;
    if owner_id <> auth.uid() or not public.app_is_approved() then
        raise exception 'Data access denied' using errcode='42501';
    end if;
    return owner_id;
end $$;

create function data_recovery.lock_owner(p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('data-owner:'||p_user_id::text,0));
    insert into data_recovery.owner_state(user_id) values(p_user_id) on conflict do nothing;
    perform 1 from data_recovery.owner_state where user_id=p_user_id for update;
end $$;

create function data_recovery.merge_patch(p_target jsonb,p_patch jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb:=case when jsonb_typeof(p_target)='object' then p_target else '{}'::jsonb end; k text; v jsonb;
begin
    if jsonb_typeof(p_patch)<>'object' then return p_patch; end if;
    for k,v in select key,value from jsonb_each(p_patch) loop
        if v='null'::jsonb then result:=result-k;
        else result:=jsonb_set(result,array[k],data_recovery.merge_patch(result->k,v),true); end if;
    end loop;
    return result;
end $$;

-- Compare only leaves the caller changed. Arrays are atomic values. Independently
-- edited fields can merge, while two edits to the same field remain explicit.
create function data_recovery.patch_conflicts(p_current jsonb,p_base jsonb,p_patch jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare k text; v jsonb;
begin
    if jsonb_typeof(p_patch)<>'object' then
        return p_current is distinct from p_base and p_current is distinct from p_patch;
    end if;
    for k,v in select key,value from jsonb_each(p_patch) loop
        if jsonb_typeof(v)='object' then
            if data_recovery.patch_conflicts(p_current->k,p_base->k,v) then return true; end if;
        elsif (p_current->k) is distinct from (p_base->k)
          and (p_current->k) is distinct from (case when v='null'::jsonb then null else v end) then return true;
        end if;
    end loop;
    return false;
end $$;

create function data_recovery.capture_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb; after_row jsonb; row_data jsonb; owner_id uuid; kind text;
    entity text; domain_name text; next_cursor bigint; current_epoch bigint; row_version bigint;
begin
    if tg_op<>'INSERT' then before_row:=to_jsonb(old); end if;
    if tg_op<>'DELETE' then after_row:=to_jsonb(new); end if;
    if (before_row-array['updated_at','sync_version']) is not distinct from (after_row-array['updated_at','sync_version']) then return coalesce(new,old); end if;
    row_data:=coalesce(after_row,before_row);
    select owner_kind into kind from data_recovery.table_registry where table_name=tg_table_name;
    owner_id:=case when kind='profile' then (row_data->>'id')::uuid else (row_data->>'user_id')::uuid end;
    if kind='review' then select user_id into owner_id from public.stop_reviews where id=(row_data->>'review_id')::uuid; end if;
    if kind='evaluation' then select user_id into owner_id from public.ai_evaluation_cases where id=(row_data->>'case_id')::uuid; end if;
    if kind='legacy' then select id into owner_id from public.profiles where nick=regexp_replace(row_data->>'user_doc_name','_stats$',''); end if;
    entity:=coalesce(row_data->>'id',row_data->>'review_id'||':'||(row_data->>'mistake_id'),row_data->>'start_token',md5(row_data::text));
    -- Cascading deletes can run after the parent vanished; recover the prior owner.
    if owner_id is null and kind in ('review','evaluation') then
        select h.user_id into owner_id from data_recovery.change_history h where h.table_name=tg_table_name and h.entity_id=entity order by h.id desc limit 1;
    end if;
    owner_id:=coalesce(owner_id,'00000000-0000-0000-0000-000000000000'::uuid);
    perform data_recovery.lock_owner(owner_id);
    update data_recovery.owner_state set cursor=cursor+1,updated_at=now(),
        settings_version=settings_version+case when tg_table_name='profiles' and (before_row->'settings') is distinct from (after_row->'settings') then 1 else 0 end
        where user_id=owner_id returning cursor,epoch,settings_version into next_cursor,current_epoch,row_version;
    domain_name:=tg_table_name;
    if tg_table_name='journal_days' then
        domain_name:='journal'; entity:=row_data->>'trade_date'; row_version:=coalesce((row_data->>'sync_version')::bigint,1);
    elsif tg_table_name='profiles' then domain_name:='settings'; entity:=owner_id::text;
    else row_version:=next_cursor; end if;
    insert into data_recovery.change_history(user_id,cursor,epoch,table_name,entity_id,domain,old_record,new_record,version,operation_id,actor_id,source)
    values(owner_id,next_cursor,current_epoch,tg_table_name,entity,domain_name,before_row,after_row,row_version,
        nullif(current_setting('app.data_operation_id',true),'')::uuid,auth.uid(),coalesce(nullif(current_setting('app.data_source',true),''),'database'));
    return coalesce(new,old);
end $$;

create function data_recovery.install_history_trigger(p_table text)
returns void language plpgsql security definer set search_path='' as $$
begin
    if not exists(select 1 from data_recovery.table_registry where table_name=p_table) then raise exception 'Unregistered business table'; end if;
    if to_regclass(format('public.%I',p_table)) is null then return; end if;
    execute format('drop trigger if exists zz_data_recovery_history on public.%I',p_table);
    execute format('create trigger zz_data_recovery_history after insert or update or delete on public.%I for each row execute function data_recovery.capture_change()',p_table);
end $$;

insert into data_recovery.table_registry(table_name,owner_kind,restore_order) values
('profiles','profile',0),('journal_days','user_id',10),('journal_months','legacy',11),
('screenshots','user_id',20),('stop_mistakes','user_id',20),('stop_reviews','user_id',21),('stop_review_mistakes','review',22),
('google_sheet_sync_configs','user_id',25),('daily_reviews','user_id',30),('ai_coach_insights','user_id',30),
('ai_feedback','user_id',31),('ai_learning_examples','user_id',32),('ai_evaluation_cases','user_id',33),
('ai_evaluation_results','evaluation',34),('ai_paper_signals','user_id',35),('ai_user_patterns','user_id',36),
('trade_embeddings','user_id',40),('trade_multimodal_inputs','user_id',41),
('teams','global',0),('bots','global',0),('ai_learning_versions','global',0),('ai_learning_runs','global',0);
do $$ declare t text; begin
    for t in select table_name from data_recovery.table_registry loop perform data_recovery.install_history_trigger(t); end loop;
end $$;

alter table public.screenshots add column if not exists deleted_at timestamptz,
    add column if not exists content_sha256 text,
    add column if not exists upload_status text not null default 'ready';
create index screenshots_owner_active on public.screenshots(user_id,created_at desc) where deleted_at is null;
update storage.buckets set public=false where id='screenshots';

-- Preserve existing legacy recovery payloads even when an admin deletes a profile.
do $$ declare c record; begin
    if to_regclass('public.journal_backups') is not null then
        for c in select conname from pg_constraint where conrelid='public.journal_backups'::regclass and contype='f' and confrelid='public.profiles'::regclass loop
            execute format('alter table public.journal_backups drop constraint %I',c.conname);
        end loop;
        revoke insert,update,delete on public.journal_backups from authenticated,anon;
    end if;
end $$;

create function public.get_data_sync_state(p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); s data_recovery.owner_state; settings jsonb;
begin
    perform data_recovery.lock_owner(owner_id);
    select * into s from data_recovery.owner_state where user_id=owner_id;
    select coalesce(p.settings,'{}') into settings from public.profiles p where p.id=owner_id;
    return jsonb_build_object('epoch',s.epoch,'cursor',s.cursor,'settingsVersion',s.settings_version,'settings',coalesce(settings,'{}'));
end $$;

create function data_recovery.apply_one(p_op jsonb,p_owner uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
<<operation_scope>>
declare operation_id uuid:=(p_op->>'operationId')::uuid; domain_name text:=p_op->>'domain'; entity text:=p_op->>'entityId';
    current_row jsonb; current_value jsonb; merged jsonb; v bigint:=0; s data_recovery.owner_state; receipt data_recovery.operation_receipts;
    result jsonb; conflict_id uuid; request_hash text:=encode(sha256(convert_to(p_op::text,'UTF8')),'hex'); reason text; k text;
begin
    if operation_id is null or domain_name not in ('journal','settings') or entity is null
       or jsonb_typeof(p_op->'patch')<>'object' or p_op->>'epoch' is null or p_op->>'baseVersion' is null then
        raise exception 'Invalid data operation' using errcode='22023';
    end if;
    if nullif(p_op->>'userId','')::uuid is distinct from p_owner then raise exception 'Operation owner mismatch' using errcode='42501'; end if;
    select * into s from data_recovery.owner_state where user_id=p_owner;
    select * into receipt from data_recovery.operation_receipts where user_id=p_owner and operation_receipts.operation_id=operation_scope.operation_id;
    if found then
        if receipt.request_hash<>request_hash then raise exception 'Operation ID reused with different content' using errcode='22023'; end if;
        if (p_op->>'epoch')::bigint<>s.epoch then
            return jsonb_build_object('operationId',operation_id,'status','stale_epoch','epoch',s.epoch,'version',0);
        end if;
        return receipt.result || case when receipt.result->>'status'='applied' then '{"status":"duplicate"}'::jsonb else '{}'::jsonb end;
    end if;
    if (p_op->>'epoch')::bigint<>s.epoch then reason:='stale_epoch'; end if;
    if domain_name='journal' then
        if entity !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid journal date' using errcode='22023'; end if;
        if exists(select 1 from jsonb_object_keys(p_op->'patch') key where key<>all(array['pnl','gross_pnl','commissions','locates','kf','notes','mentor_comment','ai_advice','daily_metrics'])) then
            raise exception 'Unsupported journal field' using errcode='22023';
        end if;
        select to_jsonb(j),j.sync_version into current_row,v from public.journal_days j where j.user_id=p_owner and j.trade_date=entity::date for update;
        v:=coalesce(v,0); current_value:=coalesce(current_row-array['id','user_id','created_at','updated_at','sync_version','trade_date'],'{}');
    else
        if entity<>p_owner::text then raise exception 'Settings owner mismatch' using errcode='42501'; end if;
        for k in select jsonb_object_keys(p_op->'patch') loop
            if k ~ '^(account_|registration|approved|blocked|role$|mentor_enabled$)' and not public.app_is_admin()
              and coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Protected account setting' using errcode='42501'; end if;
        end loop;
        select coalesce(settings,'{}') into current_value from public.profiles where id=p_owner for update;
        if not found then raise exception 'Profile not found'; end if;
        v:=s.settings_version; current_row:=current_value;
    end if;
    if reason is null and ((v=0 and (p_op->>'baseVersion')::bigint>0)
       or ((p_op->>'baseVersion')::bigint<>v and data_recovery.patch_conflicts(current_value,p_op->'base',p_op->'patch'))) then reason:='conflict'; end if;
    if reason is not null then
        insert into data_recovery.data_conflicts(user_id,operation_id,domain,entity_id,base,patch,server_record,reason)
        values(p_owner,operation_id,domain_name,entity,p_op->'base',p_op->'patch',current_row,reason) returning id into conflict_id;
        result:=jsonb_build_object('operationId',operation_id,'status',reason,'version',v,'epoch',s.epoch,'row',current_row,'conflictId',conflict_id);
    else
        merged:=data_recovery.merge_patch(current_value,p_op->'patch');
        perform set_config('app.data_operation_id',operation_id::text,true);
        perform set_config('app.data_source','operation',true);
        if domain_name='journal' then
            insert into public.journal_days as j(user_id,trade_date,pnl,gross_pnl,commissions,locates,kf,notes,mentor_comment,ai_advice,daily_metrics)
            values(p_owner,entity::date,(merged->>'pnl')::numeric,(merged->>'gross_pnl')::numeric,(merged->>'commissions')::numeric,
                (merged->>'locates')::numeric,(merged->>'kf')::numeric,merged->>'notes',merged->>'mentor_comment',merged->>'ai_advice',coalesce(merged->'daily_metrics','{}'))
            on conflict(user_id,trade_date) do update set pnl=excluded.pnl,gross_pnl=excluded.gross_pnl,commissions=excluded.commissions,
                locates=excluded.locates,kf=excluded.kf,notes=excluded.notes,mentor_comment=excluded.mentor_comment,ai_advice=excluded.ai_advice,daily_metrics=excluded.daily_metrics
            returning to_jsonb(j),j.sync_version into current_row,v;
        else
            update public.profiles set settings=merged,updated_at=now() where id=p_owner;
            select settings_version into v from data_recovery.owner_state where user_id=p_owner;
            current_row:=merged;
        end if;
        perform set_config('app.data_operation_id','',true);
        result:=jsonb_build_object('operationId',operation_id,'status','applied','version',v,'epoch',s.epoch,'row',current_row);
    end if;
    insert into data_recovery.operation_receipts(user_id,operation_id,request_hash,result) values(p_owner,operation_id,request_hash,result);
    return result;
end $$;

create function public.apply_data_operations(p_operations jsonb,p_atomic boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid; op jsonb; result jsonb; results jsonb:='[]'; s data_recovery.owner_state;
    failed_status text; conflict_id uuid; failed_result jsonb; rolled_back_row jsonb; rolled_back_version bigint;
begin
    if jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations)>2000 or octet_length(p_operations::text)>8388608 then
        raise exception 'Operations must be an array of at most 2000 entries / 8 MiB' using errcode='22023';
    end if;
    owner_id:=data_recovery.authorize_owner(nullif(p_operations->0->>'userId','')::uuid,true);
    if exists(select 1 from jsonb_array_elements(p_operations) x where nullif(x->>'userId','')::uuid is distinct from owner_id) then
        raise exception 'A batch must have one owner' using errcode='42501';
    end if;
    perform data_recovery.lock_owner(owner_id);
    begin
        for op in select value from jsonb_array_elements(p_operations) loop
            result:=data_recovery.apply_one(op,owner_id); results:=results||jsonb_build_array(result);
            if p_atomic and result->>'status' in ('conflict','stale_epoch') then
                failed_status:=result->>'status'; failed_result:=result; raise exception 'Atomic operation conflict' using errcode='PT409';
            end if;
        end loop;
    exception when sqlstate 'PT409' then
        results:='[]';
        for op in select value from jsonb_array_elements(p_operations) loop
            -- The entire batch was rolled back. Return each entity's own current
            -- row, never the row of the one operation that caused the rollback.
            rolled_back_row:=null; rolled_back_version:=0;
            if op->>'domain'='journal' then
                select to_jsonb(j),j.sync_version into rolled_back_row,rolled_back_version
                from public.journal_days j where j.user_id=owner_id and j.trade_date=(op->>'entityId')::date;
            else
                select p.settings,os.settings_version into rolled_back_row,rolled_back_version
                from public.profiles p join data_recovery.owner_state os on os.user_id=p.id where p.id=owner_id;
            end if;
            insert into data_recovery.data_conflicts(user_id,operation_id,domain,entity_id,base,patch,server_record,reason)
            values(owner_id,(op->>'operationId')::uuid,op->>'domain',op->>'entityId',op->'base',op->'patch',rolled_back_row,'atomic_'||failed_status)
            returning id into conflict_id;
            result:=jsonb_build_object('operationId',op->>'operationId','status',failed_status,'epoch',failed_result->'epoch','version',coalesce(rolled_back_version,0),'row',rolled_back_row,'conflictId',conflict_id,'batchAtomic',true);
            insert into data_recovery.operation_receipts(user_id,operation_id,request_hash,result)
            values(owner_id,(op->>'operationId')::uuid,encode(sha256(convert_to(op::text,'UTF8')),'hex'),result) on conflict do nothing;
            results:=results||jsonb_build_array(result);
        end loop;
    end;
    select * into s from data_recovery.owner_state where user_id=owner_id;
    return jsonb_build_object('results',results,'epoch',s.epoch,'cursor',s.cursor);
end $$;

create function public.pull_data_changes(p_cursor bigint default 0,p_limit integer default 500,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); s data_recovery.owner_state; changes jsonb; last_cursor bigint;
begin
    perform data_recovery.lock_owner(owner_id);
    select * into s from data_recovery.owner_state where user_id=owner_id;
    select coalesce(jsonb_agg(jsonb_build_object('cursor',h.cursor,'domain',h.domain,'entityId',h.entity_id,
        'record',case when h.domain='settings' then h.new_record->'settings' else h.new_record end,
        'deleted',h.new_record is null,'version',h.version,'epoch',h.epoch,'operationId',h.operation_id) order by h.cursor),'[]'),max(h.cursor)
        into changes,last_cursor
        from (select * from data_recovery.change_history where user_id=owner_id and cursor>greatest(p_cursor,0) order by cursor limit least(greatest(p_limit,1),2000)) h;
    return jsonb_build_object('changes',changes,'cursor',coalesce(last_cursor,s.cursor),'epoch',s.epoch,
        'hasMore',coalesce(last_cursor,s.cursor)<s.cursor,'resetRequired',p_cursor<s.minimum_cursor or p_cursor>s.cursor);
end $$;

create function public.list_data_history(p_user_id uuid default null,p_before_cursor bigint default null,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); result jsonb;
begin
    select coalesce(jsonb_agg(to_jsonb(h) order by h.cursor desc),'[]'::jsonb) into result
    from (select cursor,epoch,table_name,entity_id,domain,old_record,new_record,version,operation_id,actor_id,source,created_at
          from data_recovery.change_history where user_id=owner_id and (p_before_cursor is null or cursor<p_before_cursor)
          order by cursor desc limit least(greatest(p_limit,1),500)) h;
    return result;
end $$;

create function public.resolve_data_conflict(p_conflict_id uuid,p_resolution text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid; conflict_row data_recovery.data_conflicts;
begin
    if p_resolution not in ('local','server') then raise exception 'Invalid conflict resolution' using errcode='22023'; end if;
    select * into conflict_row from data_recovery.data_conflicts where id=p_conflict_id for update;
    if not found then raise exception 'Conflict not found'; end if;
    owner_id:=data_recovery.authorize_owner(conflict_row.user_id,true);
    update data_recovery.data_conflicts set resolved_at=coalesce(resolved_at,now()) where id=p_conflict_id and user_id=owner_id;
    return jsonb_build_object('id',p_conflict_id,'resolution',p_resolution,'resolvedAt',coalesce(conflict_row.resolved_at,now()));
end $$;

create function data_recovery.owner_predicate(p_table text,p_alias text default 't')
returns text language plpgsql stable set search_path='' as $$
declare kind text;
begin
    select owner_kind into kind from data_recovery.table_registry where table_name=p_table;
    return case kind when 'profile' then format('%I.id = $1',p_alias)
      when 'user_id' then format('%I.user_id = $1',p_alias)
      when 'review' then format('%I.review_id in (select id from public.stop_reviews where user_id=$1)',p_alias)
      when 'evaluation' then format('%I.case_id in (select id from public.ai_evaluation_cases where user_id=$1)',p_alias)
      when 'legacy' then format('%I.user_doc_name in (select nick||''_stats'' from public.profiles where id=$1)',p_alias)
      else 'false' end;
end $$;

create function data_recovery.snapshot_owner(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t record; rows jsonb; tables jsonb:='{}'; files jsonb; s data_recovery.owner_state;
begin
    perform data_recovery.lock_owner(p_user_id);
    for t in select * from data_recovery.table_registry where snapshot_enabled and owner_kind<>'global' order by restore_order,table_name loop
        if to_regclass(format('public.%I',t.table_name)) is null then continue; end if;
        execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t where %s',t.table_name,data_recovery.owner_predicate(t.table_name)) into rows using p_user_id;
        tables:=tables||jsonb_build_object(t.table_name,rows);
    end loop;
    select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'path',o.name,'id',o.id,'metadata',o.metadata,'createdAt',o.created_at,'updatedAt',o.updated_at) order by o.bucket_id,o.name),'[]')
        into files from storage.objects o where o.bucket_id in ('screenshots','backgrounds','avatars','trade-charts','files','assets')
        and (split_part(o.name,'/',1)=p_user_id::text or (o.bucket_id='files' and split_part(o.name,'/',1)='screenshots' and split_part(o.name,'/',2)=p_user_id::text));
    select * into s from data_recovery.owner_state where user_id=p_user_id;
    return jsonb_build_object('version',2,'userId',p_user_id,'createdAt',now(),'epoch',s.epoch,'cursor',s.cursor,'tables',tables,'files',files);
end $$;

create function data_recovery.snapshot_counts(p_snapshot jsonb)
returns jsonb language sql immutable set search_path='' as $$
    select coalesce(jsonb_object_agg(key,jsonb_array_length(value)),'{}') from jsonb_each(p_snapshot->'tables')
$$;

create function data_recovery.point_metadata(p data_recovery.restore_points)
returns jsonb language sql stable set search_path='' as $$
    select jsonb_build_object('id',p.id,'userId',p.user_id,'createdAt',p.created_at,'reason',p.reason,'epoch',p.epoch,
        'cursor',p.cursor,'counts',p.counts,'checksum',p.checksum,'scope',p.scope,'incomplete',p.scope='legacy-merge','coverage','database-and-file-manifest')
$$;

create function data_recovery.create_point(p_user_id uuid,p_reason text,p_snapshot jsonb default null,p_scope text default 'full')
returns jsonb language plpgsql security definer set search_path='' as $$
declare snapshot jsonb; p data_recovery.restore_points;
begin
    perform data_recovery.lock_owner(p_user_id);
    snapshot:=coalesce(p_snapshot,data_recovery.snapshot_owner(p_user_id));
    insert into data_recovery.restore_points(user_id,created_by,reason,epoch,cursor,snapshot,checksum,counts,scope)
    select p_user_id,auth.uid(),left(p_reason,120),s.epoch,s.cursor,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),data_recovery.snapshot_counts(snapshot),p_scope
    from data_recovery.owner_state s where s.user_id=p_user_id returning * into p;
    return data_recovery.point_metadata(p);
end $$;

create function public.export_data_snapshot(p_user_id uuid default null)
returns jsonb language sql security definer set search_path='' as $$
    select data_recovery.snapshot_owner(data_recovery.authorize_owner(p_user_id,false))
$$;
create function public.create_restore_point(p_reason text default 'manual',p_user_id uuid default null)
returns jsonb language sql security definer set search_path='' as $$
    select data_recovery.create_point(data_recovery.authorize_owner(p_user_id,true),p_reason)
$$;
create function public.list_restore_points(p_user_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); result jsonb;
begin
    select coalesce(jsonb_agg(data_recovery.point_metadata(p) order by p.created_at desc),'[]') into result
    from (select * from data_recovery.restore_points where user_id=owner_id order by created_at desc limit least(greatest(p_limit,1),200)) p;
    return result;
end $$;
create function public.get_restore_point(p_restore_point_id uuid,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); p data_recovery.restore_points;
begin
    select * into p from data_recovery.restore_points where id=p_restore_point_id and user_id=owner_id;
    if not found then raise exception 'Restore point not found'; end if;
    return data_recovery.point_metadata(p)||jsonb_build_object('snapshot',p.snapshot);
end $$;

create function public.preview_restore(p_restore_point_id uuid,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); p data_recovery.restore_points; current_snapshot jsonb; missing jsonb;
begin
    perform data_recovery.lock_owner(owner_id);
    select * into p from data_recovery.restore_points where id=p_restore_point_id and user_id=owner_id;
    if not found then raise exception 'Restore point not found'; end if;
    current_snapshot:=data_recovery.snapshot_owner(owner_id);
    select coalesce(jsonb_agg(f),'[]') into missing from jsonb_array_elements(coalesce(p.snapshot->'files','[]')) f
      where not exists(select 1 from storage.objects o where o.bucket_id=f->>'bucket' and o.name=f->>'path');
    return data_recovery.point_metadata(p)||jsonb_build_object('restorePointId',p.id,'epoch',current_snapshot->'epoch',
        'currentCounts',data_recovery.snapshot_counts(current_snapshot),'missingFiles',missing,
        'canRestore',p.checksum=encode(sha256(convert_to(p.snapshot::text,'UTF8')),'hex') and jsonb_array_length(missing)=0);
end $$;

-- Restore rows by their existing primary keys. Upsert first; remove only rows
-- absent from a complete snapshot, in reverse dependency order afterwards.
create function data_recovery.preserve_account_settings(p_incoming jsonb,p_current jsonb)
returns jsonb language sql immutable set search_path='' as $$
    select coalesce(p_incoming,'{}'::jsonb)||coalesce((
        select jsonb_object_agg(key,value) from jsonb_each(coalesce(p_current,'{}'::jsonb))
        where key ~ '^(account_|registration|approved|blocked|role$|mentor_enabled$)'
    ),'{}'::jsonb)
$$;

create function data_recovery.upsert_rows(p_table text,p_rows jsonb,p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
declare columns_sql text; updates_sql text; primary_sql text; identity_override text:='';
begin
    if jsonb_array_length(p_rows)=0 then return; end if;
    if p_table='profiles' then
        update public.profiles p set settings=data_recovery.preserve_account_settings(coalesce(p_rows->0->'settings','{}'),p.settings),
            private_notes=coalesce(p_rows->0->'private_notes','{}'),updated_at=now() where p.id=p_owner;
        return;
    end if;
    select string_agg(format('%I',a.attname),',' order by a.attnum),
        string_agg(format('%I=excluded.%I',a.attname,a.attname),',' order by a.attnum) filter(where not a.attname=any(coalesce(pk.names,array[]::text[])))
      into columns_sql,updates_sql from pg_attribute a
      left join lateral(select array_agg(pa.attname::text) names from pg_index i join pg_attribute pa on pa.attrelid=i.indrelid and pa.attnum=any(i.indkey) where i.indrelid=a.attrelid and i.indisprimary) pk on true
      where a.attrelid=to_regclass(format('public.%I',p_table)) and a.attnum>0 and not a.attisdropped and a.attgenerated='';
    select string_agg(format('%I',a.attname),',' order by a.attnum) into primary_sql from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
      where i.indrelid=to_regclass(format('public.%I',p_table)) and i.indisprimary;
    if primary_sql is null then raise exception 'Restore table has no primary key: %',p_table; end if;
    execute format('insert into public.%1$I (%2$s) overriding system value select %2$s from jsonb_populate_recordset(null::public.%1$I,$1) on conflict (%3$s) do update set %4$s',p_table,columns_sql,primary_sql,updates_sql) using p_rows;
end $$;

create function data_recovery.delete_extra_rows(p_table text,p_rows jsonb,p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
declare keys_predicate text;
begin
    if p_table='profiles' then return; end if;
    select string_agg(format('to_jsonb(t)->%L = r->%L',a.attname,a.attname),' and ') into keys_predicate
      from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
      where i.indrelid=to_regclass(format('public.%I',p_table)) and i.indisprimary;
    execute format('delete from public.%I t where %s and not exists(select 1 from jsonb_array_elements($2) r where %s)',p_table,data_recovery.owner_predicate(p_table),keys_predicate) using p_owner,p_rows;
end $$;

create function public.restore_data(p_restore_point_id uuid,p_expected_epoch bigint,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,true); p data_recovery.restore_points; s data_recovery.owner_state;
    before_point jsonb; preview jsonb; t record; rows jsonb;
begin
    perform data_recovery.lock_owner(owner_id);
    select * into s from data_recovery.owner_state where user_id=owner_id;
    if p_expected_epoch is null or p_expected_epoch<>s.epoch then raise exception 'Dataset changed; refresh restore preview' using errcode='PT409'; end if;
    select * into p from data_recovery.restore_points where id=p_restore_point_id and user_id=owner_id;
    if not found then raise exception 'Restore point not found'; end if;
    preview:=public.preview_restore(p.id,owner_id);
    if not (preview->>'canRestore')::boolean then raise exception 'Restore point is corrupt or files are missing'; end if;
    before_point:=data_recovery.create_point(owner_id,'before-restore');
    update data_recovery.owner_state set epoch=epoch+1 where user_id=owner_id;
    perform set_config('app.data_source','restore',true);
    for t in select * from data_recovery.table_registry where snapshot_enabled and owner_kind<>'global' order by restore_order,table_name loop
        if not (p.snapshot->'tables' ? t.table_name) or to_regclass(format('public.%I',t.table_name)) is null then continue; end if;
        rows:=p.snapshot->'tables'->t.table_name;
        if p.scope='legacy-merge' and t.table_name='journal_days' then
            -- Legacy files do not own IDs; merge matching dates without removing
            -- other months or recreating existing rows and child references.
            insert into public.journal_days as j(user_id,trade_date,pnl,gross_pnl,commissions,locates,kf,notes,mentor_comment,ai_advice,daily_metrics)
            select owner_id,r.trade_date,r.pnl,r.gross_pnl,r.commissions,r.locates,r.kf,r.notes,r.mentor_comment,r.ai_advice,r.daily_metrics
            from jsonb_populate_recordset(null::public.journal_days,rows) r
            on conflict(user_id,trade_date) do update set pnl=excluded.pnl,gross_pnl=excluded.gross_pnl,commissions=excluded.commissions,
                locates=excluded.locates,kf=excluded.kf,notes=excluded.notes,mentor_comment=excluded.mentor_comment,ai_advice=excluded.ai_advice,
                daily_metrics=coalesce(j.daily_metrics,'{}')||coalesce(excluded.daily_metrics,'{}');
        elsif p.scope='legacy-merge' and t.table_name='profiles' then
            update public.profiles set settings=data_recovery.preserve_account_settings(coalesce(settings,'{}')||coalesce(rows->0->'settings','{}'),settings),updated_at=now() where id=owner_id;
        else perform data_recovery.upsert_rows(t.table_name,rows,owner_id); end if;
    end loop;
    if p.scope='full' then
        for t in select * from data_recovery.table_registry where snapshot_enabled and owner_kind<>'global' order by restore_order desc,table_name desc loop
            if p.snapshot->'tables' ? t.table_name and to_regclass(format('public.%I',t.table_name)) is not null then
                perform data_recovery.delete_extra_rows(t.table_name,p.snapshot->'tables'->t.table_name,owner_id);
            end if;
        end loop;
    end if;
    delete from data_recovery.file_retirements f where f.user_id=owner_id and exists(
      select 1 from public.screenshots sc where sc.user_id=owner_id and sc.storage_path=f.storage_path and sc.deleted_at is null);
    -- A restore always emits a cursor event, including a no-content-change restore.
    update data_recovery.owner_state set cursor=cursor+1,updated_at=now() where user_id=owner_id returning * into s;
    insert into data_recovery.change_history(user_id,cursor,epoch,table_name,entity_id,domain,new_record,source)
      values(owner_id,s.cursor,s.epoch,'restore_points',p.id::text,'restore',jsonb_build_object('restorePointId',p.id),'restore');
    return jsonb_build_object('restorePointId',p.id,'preRestorePointId',before_point->>'id','epoch',s.epoch,'cursor',s.cursor,'counts',p.counts);
end $$;

create function public.prepare_legacy_restore(p_app_data jsonb,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,true); days jsonb:='[]'; d record; row_data jsonb; settings jsonb; payload jsonb;
begin
    if jsonb_typeof(p_app_data)<>'object' or jsonb_typeof(p_app_data->'journal')<>'object' or octet_length(p_app_data::text)>33554432 then raise exception 'Invalid legacy journal file'; end if;
    for d in select key,value from jsonb_each(p_app_data->'journal') loop
        if d.key !~ '^\d{4}-\d{2}-\d{2}$' or d.value->>'__detailsLoaded'='false' then continue; end if;
        row_data:=jsonb_build_object('user_id',owner_id,'trade_date',d.key,'pnl',d.value->'pnl','gross_pnl',d.value->'gross_pnl',
            'commissions',d.value->'commissions','locates',d.value->'locates','kf',d.value->'kf','notes',d.value->>'notes',
            'mentor_comment',coalesce(d.value->>'mentorComment',d.value->>'mentor_comment'),'ai_advice',d.value->>'ai_advice',
            'daily_metrics',d.value-array['id','user_id','trade_date','__detailsLoaded','pnl','gross_pnl','commissions','locates','kf','notes','mentor_comment','mentorComment','ai_advice']);
        days:=days||jsonb_build_array(row_data);
    end loop;
    settings:=coalesce(p_app_data->'settings','{}');
    settings:=settings-array(select key from jsonb_object_keys(settings) key where key ~ '^(account_|registration|approved|blocked|role$|mentor_enabled$)');
    settings:=settings||(p_app_data-array['settings','journal','id','user_id']);
    payload:=jsonb_build_object('version',2,'userId',owner_id,'tables',jsonb_build_object('journal_days',days,'profiles',jsonb_build_array(jsonb_build_object('id',owner_id,'settings',settings))),'files','[]'::jsonb);
    return data_recovery.create_point(owner_id,'legacy-import',payload,'legacy-merge');
end $$;

create function public.import_restore_point(p_payload jsonb,p_user_id uuid default null)
returns jsonb language sql security definer set search_path='' as $$
    select public.prepare_legacy_restore(coalesce(p_payload->'appData',p_payload),p_user_id)
$$;

create function public.reset_data(p_expected_epoch bigint,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,true); snapshot jsonb; point jsonb;
begin
    snapshot:=data_recovery.snapshot_owner(owner_id);
    -- Reset journal workspace only; reviews and annotations remain recoverable in
    -- the pre-reset snapshot. Keeping profile security fields is mandatory.
    snapshot:=jsonb_set(snapshot,'{tables}',(select jsonb_object_agg(key,case when key='profiles' then value else '[]'::jsonb end) from jsonb_each(snapshot->'tables')));
    point:=data_recovery.create_point(owner_id,'reset-target',snapshot);
    return public.restore_data((point->>'id')::uuid,p_expected_epoch,owner_id);
end $$;

create function public.finalize_screenshot_upload(p_storage_path text,p_metadata jsonb default '{}',p_user_id uuid default null,p_expected_epoch bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,true); object_path text:=regexp_replace(p_storage_path,'^screenshots/','');
    result jsonb; sync_state data_recovery.owner_state; canonical text; existing_meta jsonb; settings_value jsonb; inbox jsonb; object_meta jsonb;
begin
    if split_part(object_path,'/',1)<>owner_id::text or object_path like '%..%' then raise exception 'Upload path owner mismatch' using errcode='42501'; end if;
    perform data_recovery.lock_owner(owner_id);
    select * into sync_state from data_recovery.owner_state where user_id=owner_id;
    if p_expected_epoch is null or p_expected_epoch<>sync_state.epoch then raise exception 'STALE_EPOCH: upload predates restore' using errcode='PT409'; end if;
    canonical:='screenshots/'||object_path;
    if exists(select 1 from data_recovery.file_retirements where user_id=owner_id and storage_path=canonical)
      or exists(select 1 from public.screenshots where user_id=owner_id and storage_path=canonical and deleted_at is not null) then
        raise exception 'FILE_RETIRED: deleted uploads require explicit restore' using errcode='PT409';
    end if;
    select metadata into object_meta from storage.objects where bucket_id='screenshots' and name=object_path;
    if not found then raise exception 'Upload has not reached durable storage'; end if;
    if object_meta->>'size' is not null and p_metadata->>'byte_size' is not null and (object_meta->>'size')::bigint<>(p_metadata->>'byte_size')::bigint then raise exception 'Stored file size mismatch'; end if;
    if p_metadata ? 'sha256' and (p_metadata->>'sha256') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid file checksum'; end if;
    insert into public.screenshots as screenshot(user_id,storage_path,source,source_file_id,original_name,mime_type,byte_size,content_sha256,upload_status,
      source_created_at,source_modified_at,pixel_width,pixel_height,ticker,trade_key,screenshot_role,captured_at,quality_status,quality_details)
    values(owner_id,canonical,coalesce(p_metadata->>'source','upload'),p_metadata->>'source_file_id',p_metadata->>'original_name',
        coalesce(object_meta->>'mimetype',p_metadata->>'mime_type'),coalesce((object_meta->>'size')::bigint,(p_metadata->>'byte_size')::bigint),p_metadata->>'sha256','ready',
        nullif(p_metadata->>'source_created_at','')::timestamptz,nullif(p_metadata->>'source_modified_at','')::timestamptz,
        nullif(p_metadata->>'pixel_width','')::integer,nullif(p_metadata->>'pixel_height','')::integer,p_metadata->>'ticker',p_metadata->>'trade_key',
        coalesce(nullif(p_metadata->>'screenshot_role',''),'unknown'),nullif(p_metadata->>'captured_at','')::timestamptz,
        coalesce(nullif(p_metadata->>'quality_status',''),'unchecked'),coalesce(p_metadata->'quality_details','{}'::jsonb))
    on conflict(user_id,storage_path) do update set upload_status='ready',updated_at=now(),content_sha256=coalesce(excluded.content_sha256,screenshot.content_sha256),
      ticker=coalesce(excluded.ticker,screenshot.ticker),trade_key=coalesce(excluded.trade_key,screenshot.trade_key),
      screenshot_role=coalesce(excluded.screenshot_role,screenshot.screenshot_role),captured_at=coalesce(excluded.captured_at,screenshot.captured_at),
      quality_status=coalesce(excluded.quality_status,screenshot.quality_status),quality_details=coalesce(excluded.quality_details,screenshot.quality_details)
    returning to_jsonb(screenshot) into result;
    select coalesce(settings,'{}') into settings_value from public.profiles where id=owner_id;
    existing_meta:=coalesce(settings_value->'screenMeta','{}');
    existing_meta:=jsonb_set(existing_meta,array[canonical],coalesce(existing_meta->canonical,'{}')||jsonb_strip_nulls(jsonb_build_object(
        'source',result->'source','createdAt',result->'created_at','driveId',p_metadata->>'source_file_id','driveName',p_metadata->>'original_name',
        'sha256',p_metadata->>'sha256','byteSize',result->'byte_size','uploadStatus','ready')),true);
    inbox:=case when jsonb_typeof(settings_value->'unassignedImages')='array' then settings_value->'unassignedImages' else '[]'::jsonb end;
    if not inbox @> jsonb_build_array(canonical) and not exists(select 1 from public.journal_days j,
        lateral jsonb_each(coalesce(j.daily_metrics->'screenshots','{}')) screen
        where j.user_id=owner_id and screen.value @> jsonb_build_array(canonical)) then inbox:=inbox||jsonb_build_array(canonical); end if;
    update public.profiles set settings=settings_value||jsonb_build_object('screenMeta',existing_meta,'unassignedImages',inbox),updated_at=now() where id=owner_id;
    select * into sync_state from data_recovery.owner_state where user_id=owner_id;
    return jsonb_build_object('record',result,'epoch',sync_state.epoch,'cursor',sync_state.cursor);
end $$;

create function public.soft_delete_screenshot(p_storage_path text,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,true); point jsonb; s data_recovery.owner_state; object_path text:=regexp_replace(p_storage_path,'^screenshots/','');
begin
    if split_part(object_path,'/',1)<>owner_id::text then raise exception 'File owner mismatch' using errcode='42501'; end if;
    perform data_recovery.lock_owner(owner_id);
    point:=data_recovery.create_point(owner_id,'before-file-delete');
    update public.screenshots set deleted_at=now(),updated_at=now() where user_id=owner_id and storage_path in (p_storage_path,'screenshots/'||object_path);
    update public.journal_days j set daily_metrics=jsonb_set(coalesce(j.daily_metrics,'{}'),'{screenshots}',
        (select coalesce(jsonb_object_agg(key,(select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(value) v where v #>> '{}' not in (p_storage_path,'screenshots/'||object_path))),'{}')
        from jsonb_each(coalesce(j.daily_metrics->'screenshots','{}')) where jsonb_typeof(value)='array'))
        where j.user_id=owner_id and coalesce(j.daily_metrics->'screenshots','{}')::text like '%'||object_path||'%';
    update public.profiles set settings=jsonb_set(coalesce(settings,'{}')- 'screenMeta'-'screenTags'-'screenDiscipline','{unassignedImages}',
        (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(coalesce(settings->'unassignedImages','[]')) v where v #>> '{}' not in (p_storage_path,'screenshots/'||object_path)))
        || jsonb_build_object('screenMeta',coalesce(settings->'screenMeta','{}')-p_storage_path-('screenshots/'||object_path),
        'screenTags',coalesce(settings->'screenTags','{}')-p_storage_path-('screenshots/'||object_path),
        'screenDiscipline',coalesce(settings->'screenDiscipline','{}')-p_storage_path-('screenshots/'||object_path)) where id=owner_id;
    insert into data_recovery.file_retirements(user_id,storage_path) values(owner_id,'screenshots/'||object_path)
      on conflict(user_id,storage_path) do update set retired_at=now(),purge_after=now()+interval '30 days';
    select * into s from data_recovery.owner_state where user_id=owner_id;
    return jsonb_build_object('deleted',true,'restorePointId',point->>'id','epoch',s.epoch,'cursor',s.cursor);
end $$;

create function public.get_data_health(p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); result jsonb;
begin
    select jsonb_build_object('lastRestorePointAt',(select max(created_at) from data_recovery.restore_points where user_id=owner_id),
        'unresolvedConflicts',(select count(*) from data_recovery.data_conflicts where user_id=owner_id and resolved_at is null),
        'offsite',(select jsonb_build_object('status',status,'startedAt',started_at,'completedAt',completed_at,'manifest',manifest) from data_recovery.backup_runs order by started_at desc limit 1),
        'usage',jsonb_build_object('databaseBytes',pg_database_size(current_database()),'storageBytes',coalesce((select sum(coalesce(nullif(o.metadata->>'size','')::bigint,0))
          from storage.objects o where split_part(o.name,'/',1)=owner_id::text or (o.bucket_id='files' and split_part(o.name,'/',1)='screenshots' and split_part(o.name,'/',2)=owner_id::text)),0)),
        'integrationJobs',jsonb_build_object('errors',(select count(*) from public.source_sync_jobs where user_id=owner_id and status='error'),
          'overdue',(select count(*) from public.source_sync_jobs where user_id=owner_id and status in ('queued','running') and coalesce(lease_until,next_attempt_at)<now()-interval '10 minutes')),
        'historyRetentionDays',30,'offsiteStale',not exists(select 1 from data_recovery.backup_runs where status='verified' and completed_at>now()-interval '26 hours'),
        'bytesProtectedIndependently',exists(select 1 from data_recovery.backup_runs where status='verified' and completed_at>now()-interval '26 hours')) into result;
    return result;
end $$;

create function public.report_backup_run(p_run jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare run_id uuid:=coalesce(nullif(p_run->>'id','')::uuid,gen_random_uuid());
begin
    if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required' using errcode='42501'; end if;
    insert into data_recovery.backup_runs(id,status,completed_at,manifest,error) values(run_id,p_run->>'status',
      case when p_run->>'status'<>'running' then now() end,coalesce(p_run->'manifest','{}'),left(p_run->>'error',2000))
      on conflict(id) do update set status=excluded.status,completed_at=excluded.completed_at,manifest=excluded.manifest,error=excluded.error;
    return run_id;
end $$;

create function data_recovery.maintain_recovery()
returns void language plpgsql security definer set search_path='' as $$
declare owner_id uuid; cutoff timestamptz:=now()-interval '30 days';
begin
    for owner_id in select id from public.profiles order by id loop
        perform data_recovery.lock_owner(owner_id);
        if not exists(select 1 from data_recovery.restore_points where user_id=owner_id and created_at>now()-interval '23 hours' and scope='full') then
            perform data_recovery.create_point(owner_id,'daily');
        end if;
        update data_recovery.owner_state s set minimum_cursor=greatest(s.minimum_cursor,coalesce((select max(h.cursor) from data_recovery.change_history h where h.user_id=owner_id and h.created_at<cutoff),0)) where s.user_id=owner_id;
        delete from data_recovery.change_history where user_id=owner_id and created_at<cutoff;
        delete from data_recovery.restore_points p where user_id=owner_id and retain_until<now()
          and p.id<>(select id from data_recovery.restore_points where user_id=owner_id and scope='full' order by created_at desc limit 1);
    end loop;
    -- Operation receipts are deliberately retained: deleting dedupe keys can
    -- replay old mutations. Purging objects requires separate offsite verification.
end $$;

create function data_recovery.guard_legacy_writes()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
    if current_user in ('authenticated','anon') then
        if tg_table_name='journal_days' or (tg_table_name='profiles' and tg_op='UPDATE' and to_jsonb(new)->'settings' is distinct from to_jsonb(old)->'settings') then
            raise exception 'CLIENT_UPGRADE_REQUIRED: use revision-aware data operations' using errcode='PT409';
        end if;
    end if;
    return coalesce(new,old);
end $$;
create trigger aa_guard_legacy_journal before insert or update or delete on public.journal_days for each row execute function data_recovery.guard_legacy_writes();
create trigger aa_guard_legacy_settings before update on public.profiles for each row execute function data_recovery.guard_legacy_writes();
revoke execute on function public.sync_journal_days_batch(jsonb) from authenticated,anon,public;

-- Storage bytes are immutable to normal clients. Retirement is a metadata
-- operation; only a verified backup/retention worker may physically purge bytes.
create function data_recovery.guard_storage_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
    if current_user in ('authenticated','anon') and old.bucket_id in ('screenshots','backgrounds','avatars','trade-charts','files','assets') then
        raise exception 'IMMUTABLE_FILE: upload a new object or use the recycle bin' using errcode='PT409';
    end if;
    return coalesce(new,old);
end $$;
create trigger data_recovery_immutable_objects before update or delete on storage.objects for each row execute function data_recovery.guard_storage_mutation();

do $$ declare f record; begin
    for f in select oid::regprocedure as signature from pg_proc where pronamespace='data_recovery'::regnamespace loop
        execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    end loop;
    for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname=any(array[
      'get_data_sync_state','apply_data_operations','pull_data_changes','export_data_snapshot','create_restore_point','list_restore_points',
      'get_restore_point','preview_restore','restore_data','prepare_legacy_restore','import_restore_point','reset_data',
      'finalize_screenshot_upload','soft_delete_screenshot','get_data_health','resolve_data_conflict','list_data_history']) loop
        execute format('revoke all on function %s from public,anon',f.signature);
        execute format('grant execute on function %s to authenticated,service_role',f.signature);
    end loop;
end $$;
revoke all on function public.report_backup_run(jsonb) from public,anon,authenticated;
grant execute on function public.report_backup_run(jsonb) to service_role;

do $$ begin
    if exists(select 1 from pg_extension where extname='pg_cron') then
        perform cron.schedule('data-recovery-daily','17 2 * * *','select data_recovery.maintain_recovery()');
    end if;
end $$;
notify pgrst,'reload schema';
commit;
