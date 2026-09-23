import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

export function publicSupabaseConfig(source = '') {
    const value = name => source.match(new RegExp(`['\"]?${name}['\"]?\\s*:\\s*['\"]([^'\"]+)`))?.[1] || '';
    return { url: value('supabaseUrl'), key: value('supabaseAnonKey') };
}

async function deploymentPublicConfig() {
    try {
        return publicSupabaseConfig(await readFile(new URL('../config.js', import.meta.url), 'utf8'));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const hosts = [...new Set([
            process.env.VERCEL_PROJECT_PRODUCTION_URL,
            'traderjournal-six.vercel.app',
        ].filter(Boolean))];
        for (const host of hosts) {
            const response = await fetch(`https://${host}/config.js`, { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) continue;
            const config = publicSupabaseConfig(await response.text());
            if (config.url && config.key) return config;
        }
        return { url: '', key: '' };
    }
}

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
        const publicConfig = await deploymentPublicConfig();
        await verifyRecoverySchema({
            url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || publicConfig.url,
            key: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || publicConfig.key,
        });
        console.log('Recovery schema is ready for this client.');
    }
}
