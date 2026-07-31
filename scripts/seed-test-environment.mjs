import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const envPath = path.join(root, '.env.test.local');

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
}

const env = { ...loadEnvFile(envPath), ...process.env };
const url = String(env.TEST_SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(env.TEST_SUPABASE_SERVICE_ROLE_KEY || '');

if (env.TEST_ALLOW_SEED !== 'true') throw new Error('Safety stop: set TEST_ALLOW_SEED=true in .env.test.local');
if (!url || !serviceKey) throw new Error('Missing TEST_SUPABASE_URL or TEST_SUPABASE_SERVICE_ROLE_KEY');
if (!/\.supabase\.co$/i.test(new URL(url).hostname)) throw new Error('TEST_SUPABASE_URL must be a Supabase project URL');

const users = [
    { email: 'test.trader@example.com', password: env.TEST_TRADER_PASSWORD, nick: 'test_trader', role: 'trader', team: 'Demo Team' },
    { email: 'test.mentor@example.com', password: env.TEST_MENTOR_PASSWORD, nick: 'test_mentor', role: 'mentor', team: 'Demo Team', mentor_enabled: true },
    { email: 'test.admin@example.com', password: env.TEST_ADMIN_PASSWORD, nick: 'test_admin', role: 'admin', team: 'Demo Team' },
];

if (users.some(user => !user.password || user.password.length < 12)) {
    throw new Error('All test passwords must be configured and contain at least 12 characters');
}

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

async function request(endpoint, options = {}) {
    const response = await fetch(`${url}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${endpoint}: ${data.message || data.error || response.status}`);
    return data;
}

async function ensureUser(spec) {
    const listed = await request(`/auth/v1/admin/users?page=1&per_page=1000`);
    let user = (listed.users || []).find(item => item.email === spec.email);
    if (!user) user = await request('/auth/v1/admin/users', {
        method: 'POST', body: JSON.stringify({ email: spec.email, password: spec.password, email_confirm: true }),
    });
    await request('/rest/v1/profiles?on_conflict=id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: user.id, nick: spec.nick, email: spec.email, role: spec.role,
            team: spec.team, mentor_enabled: spec.mentor_enabled === true,
            settings: { theme: 'nebula', font: 'inter', auth_provider: 'email' } }),
    });
    return user;
}

const seeded = [];
for (const spec of users) seeded.push({ spec, user: await ensureUser(spec) });

const trader = seeded.find(item => item.spec.role === 'trader').user;
const today = new Date();
const journal = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(today); date.setDate(date.getDate() - index);
    const tradeDate = date.toISOString().slice(0, 10);
    const pnl = [184.5, -72.25, 96, 0, 241.8, -41.2][index % 6];
    return {
        user_id: trader.id, trade_date: tradeDate, pnl, gross_pnl: pnl + 12.5,
        commissions: -8.5, locates: -4, kf: Number((pnl / 100).toFixed(2)),
        notes: index === 0 ? 'Demo day: followed the plan and reviewed screenshots.' : `Demo journal day ${index + 1}`,
        daily_metrics: { sessionDone: true, sessionReviewDone: index < 4, errors: index % 3 === 1 ? ['FOMO'] : [],
            screenshots: { good: [], normal: [], bad: [], error: [] }, trades: [] },
    };
});

await request('/rest/v1/journal_days?on_conflict=user_id,trade_date', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(journal),
});

console.log('Staging fixtures ready:');
for (const { spec } of seeded) console.log(`- ${spec.role}: ${spec.email}`);
console.log(`- journal days: ${journal.length}`);
