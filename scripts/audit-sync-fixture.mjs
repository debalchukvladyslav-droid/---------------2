import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const owner = randomUUID();
const suffix = owner.slice(0, 8);
const email = `sync-audit-${suffix}@example.invalid`;
const password = `${randomUUID()}Aa1!`;
await mkdir('.recovery', { recursive: true });
await writeFile('.recovery/sync-audit-account.json', JSON.stringify({ owner, email, password }));
// Output is intended for the authenticated SQL connector, never for logs.
const query = `begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
values('${owner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${email}',extensions.crypt('${password}',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{"nick":"sync_audit_${suffix}"}',now(),now(),'','','','');
insert into auth.identities(provider_id,user_id,identity_data,provider,created_at,updated_at)
values('${owner}','${owner}','{"sub":"${owner}","email":"${email}","email_verified":true}','email',now(),now());
insert into public.profiles(id,nick,email,role,settings) values('${owner}','sync_audit_${suffix}','${email}','trader','{"account_approved":true}')
on conflict(id) do update set settings=excluded.settings;
commit;`;
process.stdout.write(JSON.stringify({ query }));
