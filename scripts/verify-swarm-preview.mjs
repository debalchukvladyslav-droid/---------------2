import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const previewUrl = process.argv[2]?.replace(/\/$/, '');
if (!previewUrl) throw new Error('Usage: node scripts/verify-swarm-preview.mjs <preview-url>');

const root = new URL('../', import.meta.url);
const env = Object.fromEntries(fs.readFileSync(new URL('.env.e2e.local', root), 'utf8')
  .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^(['"])(.*)\1$/, '$2')]; }));
const config = fs.readFileSync(new URL('config.js', root), 'utf8');
const value = (name) => config.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)`))?.[1] || '';
const supabaseUrl = value('supabaseUrl').replace(/\/$/, '');
const anonKey = value('supabaseAnonKey');

async function jsonRequest(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const publicHeaders = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' };
const emailResult = await jsonRequest(`${supabaseUrl}/rest/v1/rpc/login_email_for_nick`, {
  method: 'POST', headers: publicHeaders, body: JSON.stringify({ target_nick: env.E2E_TEST_USERNAME }),
});
if (!emailResult.response.ok) throw new Error(`Test identity lookup failed: ${emailResult.response.status}`);
const sessionResult = await jsonRequest(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: emailResult.body, password: env.E2E_TEST_PASSWORD }),
});
if (!sessionResult.response.ok) throw new Error(`Test sign-in failed: ${sessionResult.response.status}`);

const payload = JSON.stringify({ modality: 'text-parse', text: 'Short XYZ at 4, stopped at 4.20, liquidity sweep, RVOL 500, ATR 0.80' });
function vercelCurl(extraHeaders = [], requestPayload = payload) {
  const headerFile = path.join(os.tmpdir(), `strum-swarm-${crypto.randomUUID()}.headers`);
  fs.writeFileSync(headerFile, ['Content-Type: application/json', ...extraHeaders].join('\n'));
  try {
    const command = `npx.cmd vercel curl /api/gemini --deployment ${previewUrl} --yes -- --silent --show-error --request POST --header @${headerFile} --data-binary @-`;
    const output = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd: new URL('../', import.meta.url), input: requestPayload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(output.trim());
  } finally {
    fs.rmSync(headerFile, { force: true });
  }
}
const unauthorized = vercelCurl();
const authorized = vercelCurl([`Authorization: Bearer ${sessionResult.body.access_token}`]);
const rag = vercelCurl([`Authorization: Bearer ${sessionResult.body.access_token}`], JSON.stringify({ action: 'rag-context', question: 'Why did I fail the pump breakdown?' }));
if (unauthorized?.error?.code !== 'AUTH_REQUIRED' && unauthorized?.message !== 'Missing auth token') throw new Error(`Expected auth rejection without JWT, received ${JSON.stringify(unauthorized)}`);
if (!authorized?.draft?.ticker && !authorized?.result?.ticker && !authorized?.ticker) throw new Error(`Swarm parser response did not contain a ticker: ${JSON.stringify(authorized)}`);
if (!Array.isArray(rag.context)) throw new Error(`RAG endpoint did not return bounded context: ${JSON.stringify(rag)}`);
console.log(JSON.stringify({ ok: true, anonymous_status: 401, authenticated_status: 200, provider: authorized.agents?.[0] || authorized.provider || authorized.result?.provider || 'unknown', rag_provider: rag.provider, rag_context_count: rag.context.length }));
