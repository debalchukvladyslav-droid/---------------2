begin;

-- Keep every REST response comfortably below the gateway boundary. Settings
-- may contain a large imported-sheet cache, so return its newest state once,
-- when the cursor page reaches that revision, instead of once per page.
create or replace function public.pull_data_changes(p_cursor bigint default 0,p_limit integer default 500,p_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=data_recovery.authorize_owner(p_user_id,false); s data_recovery.owner_state;
    changes jsonb; last_cursor bigint;
begin
    perform data_recovery.lock_owner_shared(owner_id);
    select * into s from data_recovery.owner_state where user_id=owner_id;

    with page as materialized (
        select cursor,domain,entity_id
        from data_recovery.change_history
        where user_id=owner_id and cursor>greatest(p_cursor,0) and cursor<=s.cursor
        order by cursor
        limit least(greatest(p_limit,1),25)
    )
    select max(cursor) into last_cursor from page;
    if last_cursor is null then last_cursor:=s.cursor; end if;

    with page as materialized (
        select cursor,domain,entity_id
        from data_recovery.change_history
        where user_id=owner_id and cursor>greatest(p_cursor,0) and cursor<=last_cursor
    ), latest_settings as (
        select max(cursor) as cursor
        from data_recovery.change_history
        where user_id=owner_id and domain='settings'
          and cursor>greatest(p_cursor,0) and cursor<=s.cursor
    ), selected_cursors as (
        select cursor from page where domain<>'settings'
        union all
        select cursor from latest_settings where cursor is not null and cursor<=last_cursor
    ), selected as (
        select h.*
        from selected_cursors c
        join data_recovery.change_history h on h.user_id=owner_id and h.cursor=c.cursor
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'cursor',h.cursor,'domain',h.domain,'entityId',h.entity_id,
        'record',case when h.domain='settings' then h.new_record->'settings' else h.new_record end,
        'deleted',h.new_record is null,'version',h.version,'epoch',h.epoch,'operationId',h.operation_id
    ) order by h.cursor),'[]') into changes from selected h;

    return jsonb_build_object('changes',changes,'cursor',last_cursor,'epoch',s.epoch,
        'hasMore',last_cursor<s.cursor,'resetRequired',p_cursor<s.minimum_cursor or p_cursor>s.cursor);
end $$;

alter function public.pull_data_changes(bigint,integer,uuid) set statement_timeout='30s';
alter function public.pull_data_changes(bigint,integer,uuid) set lock_timeout='20s';
notify pgrst, 'reload schema';
commit;
