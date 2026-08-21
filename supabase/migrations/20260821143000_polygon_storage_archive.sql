insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('polygon-cache', 'polygon-cache', false, 52428800, array['application/json']::text[])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- This archive is server-only. Edge Functions use the service role, while
-- anon and authenticated clients intentionally receive no storage policies.
