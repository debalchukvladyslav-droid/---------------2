begin;

-- A settings document can contain a large screenshot registry. Returning every
-- historical revision made a normal cursor pull exceed the authenticated API
-- timeout. The cursor still advances across every scanned event; only repeated
-- revisions of the same settings object are compacted to its latest state.
create or replace function public.pull_data_changes(p_cursor bigint default 0,p_limit integer default 500,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); s data_recovery.owner_state; changes jsonb; last_cursor bigint;
begin
    perform data_recovery.lock_owner(owner_id);
    select * into s from data_recovery.owner_state where user_id=owner_id;
    select max(cursor) into last_cursor from (
        select cursor from data_recovery.change_history
        where user_id=owner_id and cursor>greatest(p_cursor,0)
        order by cursor limit least(greatest(p_limit,1),2000)
    ) page;
    if last_cursor is null then last_cursor:=s.cursor; end if;
    with page as (
        select * from data_recovery.change_history
        where user_id=owner_id and cursor>greatest(p_cursor,0) and cursor<=last_cursor
    ), compacted as (
        (select distinct on (domain,entity_id) * from page where domain='settings'
        order by domain,entity_id,cursor desc)
        union all
        select * from page where domain<>'settings'
    )
    select coalesce(jsonb_agg(jsonb_build_object('cursor',h.cursor,'domain',h.domain,'entityId',h.entity_id,
        'record',case when h.domain='settings' then h.new_record->'settings' else h.new_record end,
        'deleted',h.new_record is null,'version',h.version,'epoch',h.epoch,'operationId',h.operation_id) order by h.cursor),'[]')
      into changes from compacted h;
    return jsonb_build_object('changes',changes,'cursor',last_cursor,'epoch',s.epoch,
        'hasMore',last_cursor<s.cursor,'resetRequired',p_cursor<s.minimum_cursor or p_cursor>s.cursor);
end $$;

-- Do not pass snapshot-bearing restore_points composites to a metadata helper:
-- that can detoast every full backup even though the UI needs no snapshot data.
create or replace function public.list_restore_points(p_user_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); result jsonb;
begin
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'userId',p.user_id,'createdAt',p.created_at,'reason',p.reason,
        'epoch',p.epoch,'cursor',p.cursor,'counts',p.counts,'checksum',p.checksum,'scope',p.scope,
        'incomplete',p.scope='legacy-merge','coverage','database-and-file-manifest') order by p.created_at desc),'[]') into result
    from (
        select id,user_id,created_at,reason,epoch,cursor,counts,checksum,scope
        from data_recovery.restore_points
        where user_id=owner_id
        order by created_at desc
        limit least(greatest(p_limit,1),200)
    ) p;
    return result;
end $$;

-- Authenticated API calls normally time out after 8 seconds. These two safe,
-- read-only endpoints handle paged recovery data and receive a narrow limit.
alter function public.pull_data_changes(bigint,integer,uuid) set statement_timeout='20s';
alter function public.list_restore_points(uuid,integer) set statement_timeout='20s';
notify pgrst, 'reload schema';
commit;
