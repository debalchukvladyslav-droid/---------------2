import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const envPath = new URL('.env.e2e.local', root);
const configPath = new URL('config.js', root);
const maxSteps = Math.max(1, Math.min(1000, Number(process.argv[2]) || 50));
const statusOnly = process.argv[2] === 'status';
const endpoint = process.env.AI_TRAINING_ENDPOINT
    || 'https://traderjournal-six.vercel.app/api/admin/service-bots?resource=ai-learning';

function envFile(path) {
    return Object.fromEntries(fs.readFileSync(path, 'utf8').split(/\r?\n/)
        .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
            const index = line.indexOf('=');
            return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
        }));
}

function clientConfig() {
    const text = fs.readFileSync(configPath, 'utf8');
    const value = (name) => text.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)`))?.[1] || '';
    return { url: value('supabaseUrl').replace(/\/$/, ''), anon: value('supabaseAnonKey') };
}

const credentials = envFile(envPath);
const config = clientConfig();
if (!credentials.E2E_TEST_USERNAME || !credentials.E2E_TEST_PASSWORD || !config.url || !config.anon) {
    throw new Error('Missing E2E credentials or Supabase client configuration');
}

async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || 240000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || `HTTP ${response.status}`), { status: response.status });
    return payload;
}

async function sessionToken() {
    const baseHeaders = { apikey: config.anon, Authorization: `Bearer ${config.anon}`, 'Content-Type': 'application/json' };
    const email = await jsonRequest(`${config.url}/rest/v1/rpc/login_email_for_nick`, {
        method: 'POST', headers: baseHeaders,
        body: JSON.stringify({ target_nick: credentials.E2E_TEST_USERNAME }), timeout: 30000,
    });
    const session = await jsonRequest(`${config.url}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: config.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: credentials.E2E_TEST_PASSWORD }), timeout: 30000,
    });
    return session.access_token;
}

let token = await sessionToken();
if (statusOnly) {
    const payload = await jsonRequest(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
    });
    const job = payload.currentJob || payload.current_job || null;
    const summary = payload.summary || {};
    const lastRun = payload.lastRun || payload.last_run || null;
    console.log(JSON.stringify({
        status: job?.status || null,
        processed: job?.processed_count ?? null,
        failed: job?.failed_count ?? null,
        noProgress: job?.consecutive_failures ?? null,
        batches: job?.batch_count ?? null,
        remaining: Number.isFinite(Number(summary.candidateTrades)) && job
            ? Math.max(0, Number(summary.candidateTrades) - Number(job.processed_count || 0))
            : null,
        heartbeat: job?.heartbeat_at || null,
        pending: summary.pending ?? null,
        lastRun: lastRun ? {
            processed: lastRun.processed_count ?? null,
            skipped: lastRun.skipped_count ?? null,
            failed: lastRun.failed_count ?? null,
            errors: Array.isArray(lastRun.error_summary) ? lastRun.error_summary.slice(0, 1) : [],
        } : null,
    }));
    process.exit(0);
}
let networkFailures = 0;
for (let step = 1; step <= maxSteps; step++) {
    const startedAt = Date.now();
    try {
        const payload = await jsonRequest(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'continue-training' }),
        });
        const run = payload.run || {};
        const job = payload.job;
        console.log(`[AI training runner] step=${step} status=${job?.status || 'none'} processed=${run.processed_count || 0} failed=${run.failed_count || 0} skipped=${run.skipped_count || 0} remaining=${run.remaining_count ?? 'unknown'} total=${job?.processed_count || 0} elapsed=${Date.now() - startedAt}ms`);
        networkFailures = 0;
        if (!job || ['completed', 'failed', 'stopped'].includes(job.status)) break;
    } catch (error) {
        if (error.status === 401) token = await sessionToken();
        networkFailures++;
        console.error(`[AI training runner] step=${step} request_failed=${error.message} consecutive=${networkFailures}`);
        if (networkFailures >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 5000 * networkFailures));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
}
