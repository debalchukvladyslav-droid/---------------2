import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const envPath = new URL('.env.e2e.local', root);
const configPath = new URL('config.js', root);
const maxSteps = Math.max(1, Math.min(1000, Number(process.argv[2]) || 50));
const statusOnly = process.argv[2] === 'status';
const evaluateOnly = process.argv[2] === 'evaluate';
const newTraining = process.argv[2] === 'new';
const queueOnly = process.argv[2] === 'queue';
const refreshPatternsOnly = process.argv[2] === 'patterns';
const visionCase = process.argv[2] === 'vision' ? process.argv[3] : null;
const visionModel = visionCase ? process.argv[4] : null;
const inspectCase = process.argv[2] === 'case' ? process.argv[3] : visionCase;
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
if (inspectCase) {
    if (!/^[0-9a-f-]{36}$/i.test(inspectCase)) throw new Error('Expected a valid evaluation case UUID');
    const headers = { apikey: config.anon, Authorization: `Bearer ${token}` };
    const rows = await jsonRequest(`${config.url}/rest/v1/ai_evaluation_cases?id=eq.${encodeURIComponent(inspectCase)}&select=id,example_id,trade_date,expected_pattern_key`, {
        headers, timeout: 30000,
    });
    const row = rows?.[0] || null;
    const examples = row?.example_id ? await jsonRequest(`${config.url}/rest/v1/ai_learning_examples?id=eq.${encodeURIComponent(row.example_id)}&select=screenshot_path,source_snapshot`, {
        headers, timeout: 30000,
    }) : [];
    const example = examples?.[0] || {};
    let localImage = null;
    if (example.screenshot_path) {
        const objectPath = String(example.screenshot_path).replace(/^screenshots\//, '');
        const response = await fetch(`${config.url}/storage/v1/object/screenshots/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
            headers, signal: AbortSignal.timeout(30000),
        });
        if (response.ok) {
            const caseDir = new URL('../.tmp-ai-cases/', import.meta.url);
            fs.mkdirSync(caseDir, { recursive: true });
            const extension = response.headers.get('content-type')?.includes('png') ? 'png' : 'jpg';
            const target = new URL(`${inspectCase}.${extension}`, caseDir);
            fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
            localImage = decodeURIComponent(target.pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
        }
    }
    let vision = null;
    if (visionCase && localImage) {
        const bytes = fs.readFileSync(localImage);
        vision = await jsonRequest(`${config.url}/functions/v1/gemini-proxy`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: visionModel || undefined, payload: { contents: [{ parts: [
                { text: 'Perform a vision smoke test. List the chart panels/timeframes that are directly visible and the color/direction of any visible execution arrows. Do not infer missing facts. Answer briefly.' },
                { inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } },
            ] }] } }),
            timeout: 180000,
        });
    }
    console.log(JSON.stringify(row ? {
        id: row.id,
        tradeDate: row.trade_date,
        expectedPatternKey: row.expected_pattern_key,
        screenshotPath: example.screenshot_path,
        screenshotSet: example.source_snapshot?.screenshotSet || [],
        snapshot: example.source_snapshot?.snapshot || example.source_snapshot || null,
        localImage,
        vision,
    } : null));
    process.exit(0);
}
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
        gold: {
            total: summary.goldCases ?? null,
            minimum: summary.minimumGoldCases ?? null,
            remaining: summary.goldRemaining ?? null,
            profitable: summary.goldPositive ?? null,
            losing: summary.goldNegative ?? null,
            unknownOutcome: summary.goldUnknown ?? null,
            holdout: summary.testCases ?? null,
        },
        lastRun: lastRun ? {
            processed: lastRun.processed_count ?? null,
            skipped: lastRun.skipped_count ?? null,
            failed: lastRun.failed_count ?? null,
            errors: Array.isArray(lastRun.error_summary) ? lastRun.error_summary.slice(0, 1) : [],
        } : null,
    }));
    process.exit(0);
}
if (queueOnly) {
    const payload = await jsonRequest(`${endpoint}&section=queue&status=pending&limit=12`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
    });
    const examples = payload.examples || payload.items || [];
    console.log(JSON.stringify(examples.map((example) => ({
        id: example.id,
        tradeDate: example.trade_date,
        ticker: example.source_snapshot?.snapshot?.ticker || example.source_snapshot?.ticker || null,
        hasScreenshot: Boolean(example.screenshot_path),
        pattern: example.ai_pattern_key,
        confidence: example.ai_confidence,
        reviewPriority: example.review_priority || null,
    }))));
    process.exit(0);
}
if (refreshPatternsOnly) {
    const payload = await jsonRequest(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-patterns' }),
        timeout: 60000,
    });
    console.log(JSON.stringify({ count: payload.patterns?.length || 0, patterns: payload.patterns || [] }));
    process.exit(0);
}
if (evaluateOnly) {
    const startedAt = Date.now();
    console.log('[AI evaluation runner] stage=syncing_gold_and_loading_holdout');
    const progressTimer = setInterval(() => {
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[AI evaluation runner] stage=waiting_for_blind_vision_passes elapsed=${elapsedSeconds}s`);
    }, 20000);
    let payload;
    try {
        payload = await jsonRequest(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'evaluate' }),
            timeout: 300000,
        });
    } finally {
        clearInterval(progressTimer);
    }
    console.log(`[AI evaluation runner] stage=completed elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
    console.log(JSON.stringify({ gold: payload.gold || null, evaluation: payload.evaluation || payload }));
    process.exit(0);
}
if (newTraining) {
    const payload = await jsonRequest(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'new-training' }),
    });
    console.log(JSON.stringify({
        job: payload.job ? {
            id: payload.job.id,
            status: payload.job.status,
            promptVersion: payload.job.prompt_version,
            processed: payload.job.processed_count,
        } : null,
        run: payload.run || null,
    }));
    process.exit(0);
}
let networkFailures = 0;
let providerFailures = 0;
for (let step = 1; step <= maxSteps; step++) {
    const startedAt = Date.now();
    try {
        console.log(`[AI training runner] step=${step} stage=requesting_next_visual_analysis`);
        const progressTimer = setInterval(() => {
            const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
            console.log(`[AI training runner] step=${step} stage=waiting_for_vision_model elapsed=${elapsedSeconds}s`);
        }, 20000);
        let payload;
        try {
            payload = await jsonRequest(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'continue-training' }),
            });
        } finally {
            clearInterval(progressTimer);
        }
        const run = payload.run || {};
        const job = payload.job;
        console.log(`[AI training runner] step=${step} status=${job?.status || 'none'} processed=${run.processed_count || 0} failed=${run.failed_count || 0} skipped=${run.skipped_count || 0} remaining=${run.remaining_count ?? 'unknown'} total=${job?.processed_count || 0} elapsed=${Date.now() - startedAt}ms`);
        networkFailures = 0;
        providerFailures = Number(run.processed_count || 0) === 0 && Number(run.failed_count || 0) > 0
            ? providerFailures + 1
            : 0;
        if (!job || ['completed', 'failed', 'stopped'].includes(job.status)) break;
    } catch (error) {
        if (error.status === 401) token = await sessionToken();
        networkFailures++;
        console.error(`[AI training runner] step=${step} request_failed=${error.message} consecutive=${networkFailures}`);
        if (networkFailures >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 5000 * networkFailures));
    }
    const cooldown = providerFailures ? Math.min(60000, 20000 * providerFailures) : 1500;
    if (providerFailures) console.log(`[AI training runner] provider cooldown=${cooldown}ms`);
    await new Promise((resolve) => setTimeout(resolve, cooldown));
}
