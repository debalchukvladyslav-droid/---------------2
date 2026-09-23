create or replace function data_recovery.assert_operations_safe(p_operations jsonb,p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
declare emptied_trade_days integer; emptied_setting_groups integer;
begin
    select count(*) into emptied_trade_days
    from jsonb_array_elements(p_operations) op
    join public.journal_days j on j.user_id=p_owner and j.trade_date=(op->>'entityId')::date
    where op->>'domain'='journal'
      and jsonb_typeof(coalesce(j.daily_metrics->'trades','[]'::jsonb))='array'
      and jsonb_array_length(coalesce(j.daily_metrics->'trades','[]'::jsonb))>0
      and jsonb_typeof(coalesce(data_recovery.merge_patch(j.daily_metrics,coalesce(op->'patch'->'daily_metrics','{}'::jsonb))->'trades','[]'::jsonb))='array'
      and jsonb_array_length(coalesce(data_recovery.merge_patch(j.daily_metrics,coalesce(op->'patch'->'daily_metrics','{}'::jsonb))->'trades','[]'::jsonb))=0;
    if emptied_trade_days>=3 then
        raise exception 'Data loss guard: refused to clear trades from % journal days',emptied_trade_days using errcode='22023';
    end if;

    select count(*) into emptied_setting_groups
    from public.profiles p
    cross join lateral jsonb_each(p.settings) old_setting
    cross join lateral (
        select data_recovery.merge_patch(p.settings,op->'patch') value
        from jsonb_array_elements(p_operations) op
        where op->>'domain'='settings' limit 1
    ) merged
    where p.id=p_owner
      and old_setting.key=any(array['tickers','screenMeta','sheetRows','cumulativeSheetRows','unassignedImages','aiChatHistory','aiSavedChats','weeklyComments','monthlyDayloss'])
      and octet_length(old_setting.value::text)>32
      and coalesce(merged.value->old_setting.key,'null'::jsonb) in ('null'::jsonb,'{}'::jsonb,'[]'::jsonb);
    if emptied_setting_groups>=3 then
        raise exception 'Data loss guard: refused to clear % populated settings groups',emptied_setting_groups using errcode='22023';
    end if;
end $$;

revoke all on function data_recovery.assert_operations_safe(jsonb,uuid) from public,anon,authenticated;

create or replace function public.apply_data_operations(p_operations jsonb,p_atomic boolean default false)
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
    perform data_recovery.assert_operations_safe(p_operations,owner_id);
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
