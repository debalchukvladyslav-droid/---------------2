-- Connections are verified by the server with owner OAuth or by an administrator.
-- A user-editable profile setting or a guessed Google ID is never an access grant.
create table public.integration_connections (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    kind text not null check (kind in ('sheets', 'drive')),
    resource_id text not null check (resource_id ~ '^[A-Za-z0-9_-]+$'),
    scope text not null default '',
    config jsonb not null default '{}',
    enabled boolean not null default true,
    verified_at timestamptz not null default now(),
    last_sync_at timestamptz,
    last_revision text,
    last_error text,
    next_sync_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (user_id, kind, resource_id, scope)
);
alter table public.integration_connections enable row level security;
create policy integration_connections_read on public.integration_connections for select to authenticated
using (user_id = (select auth.uid()) or public.app_is_admin());
revoke all on public.integration_connections from anon, authenticated;
grant select on public.integration_connections to authenticated;
grant all on public.integration_connections to service_role;
create index integration_connections_due on public.integration_connections(next_sync_at) where enabled;

create table public.source_sync_jobs (
    id uuid primary key default gen_random_uuid(),
    connection_id uuid not null unique references public.integration_connections(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    status text not null default 'queued' check(status in ('queued','running','idle','error','paused')),
    generation bigint not null default 1,
    claimed_generation bigint,
    attempts integer not null default 0,
    lease_token uuid,
    lease_until timestamptz,
    next_attempt_at timestamptz not null default now(),
    last_error text,
    progress jsonb not null default '{}',
    updated_at timestamptz not null default now()
);
alter table public.source_sync_jobs enable row level security;
create policy source_sync_jobs_read on public.source_sync_jobs for select to authenticated
using(user_id = (select auth.uid()) or public.app_is_admin());
revoke all on public.source_sync_jobs from anon, authenticated;
grant select on public.source_sync_jobs to authenticated;
grant all on public.source_sync_jobs to service_role;
create index source_sync_jobs_due on public.source_sync_jobs(next_attempt_at, lease_until) where status in ('queued','running');

create or replace function public.enqueue_source_sync(p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_connection public.integration_connections; v_job public.source_sync_jobs;
begin
    select * into v_connection from public.integration_connections where id=p_connection_id and enabled;
    if not found then raise exception 'Source connection unavailable' using errcode='42501'; end if;
    perform data_recovery.authorize_owner(v_connection.user_id, true);
    insert into public.source_sync_jobs(connection_id,user_id) values(v_connection.id,v_connection.user_id)
    on conflict(connection_id) do update set
      generation=source_sync_jobs.generation+1,
      status=case when source_sync_jobs.status='running' and source_sync_jobs.lease_until>now() then 'running' else 'queued' end,
      next_attempt_at=now(), attempts=0, updated_at=now()
    returning * into v_job;
    return jsonb_build_object('id',v_job.id,'status',v_job.status);
end $$;
revoke all on function public.enqueue_source_sync(uuid) from public, anon;
grant execute on function public.enqueue_source_sync(uuid) to authenticated, service_role;

create or replace function public.claim_source_sync_job()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_job public.source_sync_jobs; v_connection public.integration_connections;
begin
    -- Only service_role receives EXECUTE; authenticated callers cannot steal leases.
    select j.* into v_job from public.source_sync_jobs j join public.integration_connections c on c.id=j.connection_id
    where c.enabled and j.next_attempt_at<=now() and
      (j.status='queued' or (j.status='running' and j.lease_until<now()))
    order by j.next_attempt_at,j.id for update of j skip locked limit 1;
    if not found then return null; end if;
    update public.source_sync_jobs set status='running', lease_token=gen_random_uuid(), lease_until=now()+interval '4 minutes',
      claimed_generation=generation, attempts=attempts+1, updated_at=now()
    where id=v_job.id returning * into v_job;
    select * into v_connection from public.integration_connections where id=v_job.connection_id;
    return jsonb_build_object('job',to_jsonb(v_job),'connection',to_jsonb(v_connection));
end $$;
revoke all on function public.claim_source_sync_job() from public, anon, authenticated;
grant execute on function public.claim_source_sync_job() to service_role;

create or replace function public.finish_source_sync_job(p_job_id uuid,p_lease_token uuid,p_result jsonb default '{}',p_error text default null,p_retryable boolean default true)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_job public.source_sync_jobs; v_revision text;
begin
    select * into v_job from public.source_sync_jobs where id=p_job_id and lease_token=p_lease_token and status='running' and lease_until>now() for update;
    if not found then return false; end if;
    if p_error is not null then
      update public.source_sync_jobs set status=case when p_retryable and attempts<8 then 'queued' else 'error' end,
        last_error=left(p_error,2000),lease_token=null,lease_until=null,
        next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer),updated_at=now() where id=p_job_id;
      update public.integration_connections set last_error=left(p_error,2000),next_sync_at=now()+interval '1 hour' where id=v_job.connection_id;
      return true;
    end if;
    v_revision:=p_result->>'revision';
    update public.source_sync_jobs set status=case when generation>claimed_generation or coalesce((p_result->>'continue')::boolean,false) then 'queued' else 'idle' end,
      attempts=0,last_error=null,progress=p_result,lease_token=null,lease_until=null,next_attempt_at=now(),updated_at=now() where id=p_job_id;
    update public.integration_connections set last_sync_at=now(),last_revision=coalesce(v_revision,last_revision),last_error=null,
      next_sync_at=now()+interval '5 minutes' where id=v_job.connection_id;
    return true;
end $$;
revoke all on function public.finish_source_sync_job(uuid,uuid,jsonb,text,boolean) from public, anon, authenticated;
grant execute on function public.finish_source_sync_job(uuid,uuid,jsonb,text,boolean) to service_role;

create or replace function data_recovery.wake_source_integrations()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text;
begin
    insert into public.source_sync_jobs(connection_id,user_id)
      select c.id,c.user_id from public.integration_connections c where c.enabled and c.next_sync_at<=now()
    on conflict(connection_id) do update set status='queued',next_attempt_at=now(),generation=source_sync_jobs.generation+1,updated_at=now()
      where source_sync_jobs.status='idle';
    -- Configure these Vault secrets during deployment. Missing secrets leave queued
    -- jobs visible; no hardcoded token, project URL, or paid external scheduler.
    select decrypted_secret into v_url from vault.decrypted_secrets where name='integration_worker_url' limit 1;
    select decrypted_secret into v_key from vault.decrypted_secrets where name='integration_worker_secret' limit 1;
    if v_url is null or v_key is null then return; end if;
    if not exists(select 1 from public.source_sync_jobs where status='queued' and next_attempt_at<=now() or status='running' and lease_until<now()) then return; end if;
    perform net.http_post(url:=v_url,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),body:='{}'::jsonb,timeout_milliseconds:=1000);
end $$;
revoke all on function data_recovery.wake_source_integrations() from public, anon, authenticated;
grant execute on function data_recovery.wake_source_integrations() to service_role;

do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') and exists(select 1 from pg_extension where extname='pg_net') then
    if exists(select 1 from cron.job where jobname='strum-source-integrations') then perform cron.unschedule('strum-source-integrations'); end if;
    perform cron.schedule('strum-source-integrations','*/5 * * * *','select data_recovery.wake_source_integrations()');
  end if;
end $$;

insert into data_recovery.table_registry(table_name,owner_kind,restore_order)
values('integration_connections','user_id',30) on conflict(table_name) do nothing;
select data_recovery.install_history_trigger('integration_connections');
notify pgrst, 'reload schema';

-- Immutable source versions retain existing journal associations and remain restorable.
alter table public.screenshots add column if not exists source_revision text not null default '';
drop index if exists public.screenshots_user_source_file_key;
create unique index screenshots_user_source_revision_key on public.screenshots(user_id,source,source_file_id,source_revision) where source_file_id is not null;

create function public.finalize_drive_screenshot(p_connection_id uuid,p_epoch bigint,p_storage_path text,p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.integration_connections; s data_recovery.owner_state; result jsonb;
begin
  select * into c from public.integration_connections where id=p_connection_id and enabled and kind='drive';
  if not found then raise exception 'Source connection unavailable' using errcode='42501'; end if;
  perform data_recovery.authorize_owner(c.user_id,true);
  perform data_recovery.lock_owner(c.user_id);
  select * into s from data_recovery.owner_state where user_id=c.user_id;
  if p_epoch is null or s.epoch<>p_epoch then raise exception 'Stale source job epoch' using errcode='40001'; end if;
  if exists(select 1 from public.screenshots where user_id=c.user_id and source='drive' and source_file_id=p_metadata->>'source_file_id' and deleted_at is not null) then
    return jsonb_build_object('skipped',true,'reason','deleted_on_site');
  end if;
  -- The original finalizer checks object existence, byte size, hash and ownership.
  -- It uses the version-qualified source identifier until the new row is finalized,
  -- preventing the legacy unique key from collapsing content versions.
  result:=public.finalize_screenshot_upload(p_storage_path,p_metadata||jsonb_build_object('source_file_id',(p_metadata->>'source_file_id')||'@'||(p_metadata->>'sha256')),c.user_id,p_epoch);
  update public.screenshots set source_file_id=p_metadata->>'source_file_id',source_revision=p_metadata->>'sha256',
    source_created_at=nullif(p_metadata->>'source_created_at','')::timestamptz,source_modified_at=nullif(p_metadata->>'source_modified_at','')::timestamptz,
    pixel_width=nullif(p_metadata->>'pixel_width','')::integer,pixel_height=nullif(p_metadata->>'pixel_height','')::integer
  where user_id=c.user_id and storage_path=p_storage_path;
  return result;
end $$;
revoke all on function public.finalize_drive_screenshot(uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_drive_screenshot(uuid,bigint,text,jsonb) to service_role;

insert into storage.buckets(id,name,public) values('journal-exports','journal-exports',false) on conflict(id) do update set public=false;
