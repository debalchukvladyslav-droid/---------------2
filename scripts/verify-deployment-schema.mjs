import { pathToFileURL } from 'node:url';

export function schemaUnavailable(status, payload = {}) {
    return status === 404 || ['PGRST202', 'PGRST205'].includes(String(payload?.code || ''));
}

export async function verifyRecoverySchema({ url, key, fetchImpl = fetch } = {}) {
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for the production schema gate');
    const base = String(url).replace(/\/$/, '');
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const checks = [
        ['RPC get_data_sync_state', `${base}/rest/v1/rpc/get_data_sync_state`, { method: 'POST', headers, body: '{}' }],
        ['table source_sync_jobs', `${base}/rest/v1/source_sync_jobs?select=id&limit=0`, { headers }],
    ];
    for (const [name, endpoint, options] of checks) {
        const response = await fetchImpl(endpoint, { ...options, signal: AbortSignal.timeout(15_000) });
        const payload = await response.json().catch(() => ({}));
        if (schemaUnavailable(response.status, payload)) {
            throw new Error(`${name} is missing in Supabase. Apply the recovery migrations before deploying this client.`);
        }
    }
    return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    if (process.env.VERCEL_ENV !== 'production') console.log('Recovery schema gate skipped outside production.');
    else {
        await verifyRecoverySchema({
            url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
            key: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        });
        console.log('Recovery schema is ready for this client.');
    }
}
