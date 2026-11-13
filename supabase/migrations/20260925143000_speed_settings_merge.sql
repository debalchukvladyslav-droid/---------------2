-- merge_patch used jsonb_set once per key. A sheet payload of about 2 MB
-- copied itself hundreds of times and landed at ~8s, which is the
-- authenticator statement_timeout. apply_data_operations then never committed.
-- Build each object once. Also restore the function timeout that CREATE OR
-- REPLACE dropped from 20260923042623.

create or replace function data_recovery.merge_patch(p_target jsonb, p_patch jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
    select case
        when jsonb_typeof(p_patch) <> 'object' then p_patch
        else coalesce((
            select jsonb_object_agg(merged.key, merged.val)
            from (
                select coalesce(p.key, t.key) as key,
                    case
                        when p.key is null then t.value
                        else data_recovery.merge_patch(t.value, p.value)
                    end as val
                from jsonb_each(case when jsonb_typeof(p_target) = 'object' then p_target else '{}'::jsonb end) as t
                full outer join jsonb_each(p_patch) as p on p.key = t.key
                where p.value is distinct from 'null'::jsonb
            ) as merged
        ), '{}'::jsonb)
    end;
$$;

do $$
declare got jsonb;
begin
    got := data_recovery.merge_patch('{"a":1,"b":{"c":2,"d":3}}'::jsonb, '{"b":{"c":9},"e":4,"a":null}'::jsonb);
    if got <> '{"b":{"c":9,"d":3},"e":4}'::jsonb then
        raise exception 'merge_patch nested mismatch: %', got;
    end if;
    if data_recovery.merge_patch('{"a":[1]}'::jsonb, '{"a":[2,3]}'::jsonb) <> '{"a":[2,3]}'::jsonb then
        raise exception 'merge_patch array must replace as a whole';
    end if;
    if data_recovery.merge_patch('{"a":1}'::jsonb, '5'::jsonb) <> '5'::jsonb then
        raise exception 'merge_patch scalar must replace the target';
    end if;
    if data_recovery.merge_patch('null'::jsonb, '{"a":1}'::jsonb) <> '{"a":1}'::jsonb then
        raise exception 'merge_patch null target must accept an object patch';
    end if;
    if data_recovery.merge_patch('{"a":1,"b":2}'::jsonb, '{}'::jsonb) <> '{"a":1,"b":2}'::jsonb then
        raise exception 'merge_patch empty patch must keep the target';
    end if;
    if data_recovery.merge_patch('{"a":{"b":1}}'::jsonb, '{"a":null}'::jsonb) <> '{}'::jsonb then
        raise exception 'merge_patch null must delete the key';
    end if;
end $$;

alter function public.apply_data_operations(jsonb, boolean) set statement_timeout = '30s';
alter function public.apply_data_operations(jsonb, boolean) set lock_timeout = '20s';
