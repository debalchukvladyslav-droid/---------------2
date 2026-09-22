import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { fetchExcelDownload } from '../js/excel_download_core.js';
import { resumeUpload, hashUpload } from '../js/upload_queue_core.js';
import { readSheetRangePages } from '../js/sheet_range_paging.js';
const fixture = JSON.parse(await readFile('.recovery/sync-audit-account.json', 'utf8'));
assert.match(fixture.email, /^sync-audit-.*@example\.invalid$/);
const config = await readFile('config.js', 'utf8');
const value = name => config.match(new RegExp(`${name}\\s*:\\s*['\"]([^'\"]+)`))[1];
const url = value('supabaseUrl');
const anon = value('supabaseAnonKey');
const report = [];
async function json(path, body, token = anon) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    assert.equal(response.status, 200, `${path}: ${data.message || data.error}`);
    return data;
}
const session = await json('/auth/v1/token?grant_type=password', { email: fixture.email, password: fixture.password });
const token = session.access_token;
assert.equal(session.user.id, fixture.owner);
const rpc = (name, body) => json(`/rest/v1/rpc/${name}`, body, token);
if (process.argv.includes('--upload')) {
    const blob = new Blob([await readFile('outputs/sync-audit-login.png')], { type: 'image/png' });
    const objectPath = `${fixture.owner}/audit/${randomUUID()}.png`;
    const sha256 = await hashUpload(blob);
    const signedResponse = await fetch(`https://traderjournal-six.vercel.app/api/storage-upload?action=sign-upload&bucket=screenshots&objectPath=${objectPath}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ size: blob.size, contentType: blob.type, sha256 }), signal: AbortSignal.timeout(30000),
    });
    const signed = await signedResponse.json(); assert.equal(signedResponse.status, 200);
    let job = { id: randomUUID(), userId: fixture.owner, blob, bucket: 'screenshots', objectPath, contentType: blob.type, sha256 };
    const endpoint = `${url.replace('.supabase.co', '.storage.supabase.co')}/storage/v1/upload/resumable`;
    let interrupted = false;
    let patches = 0;
    const options = { endpoint, getHeaders: async () => ({ Authorization: `Bearer ${token}`, 'x-signature': signed.token }), persist: async value => { job = value; },
        fetchImpl: async (path, options) => {
            const response = await fetch(path, options);
            if (options.method === 'PATCH') { patches++; if (!interrupted && response.ok) { interrupted = true; throw new TypeError('simulated lost acknowledgement'); } }
            return response;
        } };
    await assert.rejects(resumeUpload(job, options), /simulated lost acknowledgement/);
    const completed = await resumeUpload(job, options);
    assert.equal(completed.offset, blob.size); assert.equal(patches, 1);
    const state = await rpc('get_data_sync_state', { p_user_id: fixture.owner });
    const args = { p_storage_path: `screenshots/${objectPath}`, p_user_id: fixture.owner, p_expected_epoch: state.epoch,
        p_metadata: { original_name: 'SYNC-AUDIT.png', mime_type: blob.type, byte_size: blob.size, sha256 } };
    const first = await rpc('finalize_screenshot_upload', args);
    const second = await rpc('finalize_screenshot_upload', args);
    assert.equal(first.record.id, second.record.id);
    report.push({ check: 'real TUS interrupted acknowledgement and duplicate finalize', passed: true, bytes: blob.size, patches, registryId: first.record.id });
}
if (!process.argv.includes('--read-only')) {
    const state = await rpc('get_data_sync_state', { p_user_id: fixture.owner });
    const applied = await rpc('apply_data_operations', { p_operations: [{ operationId: randomUUID(), userId: fixture.owner, domain: 'journal', entityId: '2099-02-01', epoch: state.epoch, baseVersion: 0, base: {},
        patch: { daily_metrics: { trades: Array.from({ length: 1201 }, (_, i) => ({ symbol: `AUDIT${i}`, type: 'SHORT', entry: 10, exit: 9, quantity: 1, net: 1, setup: 'Synthetic audit' })) } } }] });
    assert.ok(['applied', 'duplicate'].includes(applied.results[0].status));
    const file = await fetchExcelDownload(token, (path, options) => fetch(path.startsWith('/') ? `https://traderjournal-six.vercel.app${path}` : path, options));
    const bytes = Buffer.from(await file.blob.arrayBuffer());
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
    assert.equal(book.getWorksheet('Raw Trade Data').getCell('D1204').value, 'AUDIT1200');
    await writeFile('outputs/sync-audit-export.xlsx', bytes);
    report.push({ check: 'real Excel export', passed: true, rows: 1201, bytes: bytes.length });
}
for (const [name, path] of [['drive', '/api/drive-service?action=list&folderId=1epkKGJm1aOJmFuVdyM-x7FYpumMauYdO'],
    ...(process.env.AUDIT_SHEET_ID ? [['sheets', `/api/sheets-service?action=values&spreadsheetId=${process.env.AUDIT_SHEET_ID}&sheetTitle=Raw%20Trade%20Data&range=A1004:R1204`]] : [])]) {
    const response = await fetch(`https://traderjournal-six.vercel.app${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    report.push({ check: name, status: response.status, ok: data.ok, count: data.files?.length ?? data.values?.length, error: data.error, files: data.files?.map(file => ({ id: file.id, name: file.name })) });
}
if (process.env.AUDIT_SHEET_ID) {
    let pages = 0;
    const rows = await readSheetRangePages('A4:R1204', { read: async range => {
        pages++;
        const response = await fetch(`https://traderjournal-six.vercel.app/api/sheets-service?action=values&spreadsheetId=${process.env.AUDIT_SHEET_ID}&sheetTitle=Raw%20Trade%20Data&range=${range}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
        const data = await response.json(); assert.equal(response.status, 200);
        data.values.hyperlinks = data.hyperlinks; return data.values;
    } });
    assert.equal(rows.length, 1201); assert.equal(rows[1200][3], 'AUDIT1200');
    report.push({ check: 'real Google Sheets paged reader', passed: true, pages, rows: rows.length });
}
await writeFile('outputs/sync-audit-integrations.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
