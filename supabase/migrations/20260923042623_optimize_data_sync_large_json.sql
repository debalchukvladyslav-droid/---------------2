begin;

-- Cursor reads do not mutate owner data. A shared advisory lock keeps a pull
-- consistent with apply/restore while allowing several tabs to catch up at once.
create or replace function data_recovery.lock_owner_shared(p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock_shared(hashtextextended('data-owner:'||p_user_id::text,0));
    insert into data_recovery.owner_state(user_id) values(p_user_id) on conflict do nothing;
end $$;

revoke all on function data_recovery.lock_owner_shared(uuid) from public,anon,authenticated;

-- Select the cursor numbers before fetching TOASTed JSON. Previously the page
-- materialized every full settings revision and only then discarded all but the
-- newest one. A 2.3 MiB settings document with 62 revisions made a 141 MiB read.
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
        where user_id=owner_id and cursor>greatest(p_cursor,0)
        order by cursor
        limit least(greatest(p_limit,1),2000)
    )
    select max(cursor) into last_cursor from page;
    if last_cursor is null then last_cursor:=s.cursor; end if;

    with page as materialized (
        select cursor,domain,entity_id
        from data_recovery.change_history
        where user_id=owner_id and cursor>greatest(p_cursor,0) and cursor<=last_cursor
    ), selected_cursors as (
        select max(cursor) as cursor from page where domain='settings' group by domain,entity_id
        union all
        select cursor from page where domain<>'settings'
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

-- The authenticated role has an 8 second default. Large but valid settings
-- updates already reached 6.8 seconds, leaving too little room for lock waits.
alter function public.apply_data_operations(jsonb,boolean) set statement_timeout='30s';
alter function public.apply_data_operations(jsonb,boolean) set lock_timeout='20s';
alter function public.pull_data_changes(bigint,integer,uuid) set statement_timeout='30s';
alter function public.pull_data_changes(bigint,integer,uuid) set lock_timeout='20s';

notify pgrst, 'reload schema';
commit;
