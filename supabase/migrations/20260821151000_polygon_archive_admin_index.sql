create or replace function public.list_polygon_archive_keys()
returns table(object_name text)
language sql
security definer
set search_path = ''
as $$
    select objects.name::text
    from storage.objects as objects
    where objects.bucket_id = 'polygon-cache'
      and objects.name <> '_control/state.json';
$$;

revoke all on function public.list_polygon_archive_keys() from public, anon, authenticated;
grant execute on function public.list_polygon_archive_keys() to service_role;
