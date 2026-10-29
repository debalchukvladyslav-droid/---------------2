// Read-only: prepare the exact set of Supabase copies whose Drive originals
// still match. No files or database rows are deleted by this script.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { getGoogleAccessToken } from '../lib/google_sheet_sync.js';
import { archiveHash } from '../lib/recovery_archive.js';

const run=promisify(execFile);
const directory=resolve('.recovery/free-tier-archive');
await mkdir(directory,{recursive:true});
if((await readFile('supabase/.temp/project-ref','utf8')).trim()!=='gijarvlerztfggxhuvow')throw new Error('Unexpected linked Supabase project');
const sql=`select jsonb_build_object('files',(select coalesce(jsonb_agg(x),'[]') from (
    select s.id,s.user_id,s.storage_path,s.source_file_id,s.source_revision,s.content_sha256,o.name as object_path,
        (o.metadata->>'size')::bigint as bytes,o.updated_at as object_updated_at
    from public.screenshots s join storage.objects o on o.bucket_id='screenshots'
        and (s.storage_path=o.name or s.storage_path='screenshots/'||o.name)
    where s.source='drive' and s.deleted_at is null order by s.user_id,s.id) x),
    'connections',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'resource_id',resource_id)),'[]')
        from public.integration_connections where kind='drive' and enabled)) as inventory`;
const file=join(directory,'verify-drive.sql');
await writeFile(file,sql);
let inventory;
try {
    const command=process.env.SUPABASE_CLI_BIN||process.execPath;
    const prefix=process.env.SUPABASE_CLI_BIN?[]:[resolve('node_modules/supabase/dist/supabase.js')];
    const response=await run(command,[...prefix,'db','query','--linked','--output','json','--file',file],{maxBuffer:32*1024*1024})
        .catch(error=>{throw new Error(`Drive inventory SQL failed (${error.code || 'database unavailable'}); query output was withheld`);});
    inventory=JSON.parse(response.stdout).rows[0].inventory;
} finally {await rm(file,{force:true});}
const token=await getGoogleAccessToken('https://www.googleapis.com/auth/drive.readonly');
const metadataRequests=new Map();
function metadata(fileId) {
    if(!metadataRequests.has(fileId))metadataRequests.set(fileId,(async()=>{
        const url=new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
        url.searchParams.set('fields','id,size,mimeType,parents,trashed,modifiedTime,sha256Checksum');
        url.searchParams.set('supportsAllDrives','true');
        const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error(`Google metadata HTTP ${response.status}`);
        return response.json();
    })());
    return metadataRequests.get(fileId);
}
const verified=[],skipped=[];
for(let offset=0;offset<inventory.files.length;offset+=4){
    await Promise.all(inventory.files.slice(offset,offset+4).map(async row=>{
        try {
            const pathHash=row.object_path.match(/\/drive\/[A-Za-z0-9_-]+\/([a-f0-9]{64})\.[a-z]+$/i)?.[1];
            const expected=String(row.source_revision||row.content_sha256||pathHash||'').toLowerCase();
            if(!/^[a-f0-9]{64}$/.test(expected))throw new Error('No immutable source checksum: retain this copy');
            const original=await metadata(row.source_file_id);
            const connection=inventory.connections.find(c=>c.user_id===row.user_id&&original.parents?.includes(c.resource_id));
            if(original.trashed||!connection)throw new Error('Original is missing from an authorized folder');
            if(Number(original.size)!==Number(row.bytes))throw new Error('Original size changed');
            // A missing checksum is a reason to keep the copy, never to guess.
            if(String(original.sha256Checksum||'').toLowerCase()!==expected)throw new Error('Original checksum differs or is unavailable');
            verified.push({...row,sha256:expected,connection_id:connection.id,folder_id:connection.resource_id,
                source_modified_at:original.modifiedTime,verified_at:new Date().toISOString()});
        }catch(error){skipped.push({...row,reason:error.message});}
    }));
    console.log(JSON.stringify({checked:Math.min(offset+4,inventory.files.length),verified:verified.length,kept:skipped.length}));
}
verified.sort((a,b)=>a.id.localeCompare(b.id));
const plan={version:1,createdAt:new Date().toISOString(),projectId:'gijarvlerztfggxhuvow',verified,skipped,
    verifiedBytes:verified.reduce((sum,row)=>sum+Number(row.bytes),0),keptBytes:skipped.reduce((sum,row)=>sum+Number(row.bytes),0)};
const text=JSON.stringify(plan,null,2);
const output=join(directory,'drive-retirement-plan.json');
await writeFile(output,text);
console.log(JSON.stringify({plan:output,planSha256:archiveHash(text),verified:verified.length,verifiedBytes:plan.verifiedBytes,kept:skipped.length,keptBytes:plan.keptBytes,deleted:0}));
