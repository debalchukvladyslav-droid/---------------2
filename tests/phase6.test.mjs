import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';import { buildTeamReport } from '../lib/team_report.js';import { createRealtimeEventGate,classifyRealtimeEvent } from '../js/realtime_sync_core.js';

test('Team Report imports escapeHtml from its actual module', async () => {
    const source = await readFile(new URL('../js/team_report.js', import.meta.url), 'utf8');
    assert.match(source, /import\s*\{\s*escapeHtml\s*\}\s*from\s*['"]\.\/utils\.js['"]/);
    assert.doesNotMatch(source, /import\s*\{\s*escapeHtml\s*\}\s*from\s*['"]\.\/sanitize\.js['"]/);
});

test('Realtime registers every postgres callback before subscribing', async () => {
    const source = await readFile(new URL('../js/realtime_sync.js', import.meta.url), 'utf8');
    const subscribeIndex = source.indexOf('nextChannel.subscribe(');
    assert.ok(subscribeIndex > 0);
    assert.equal(source.slice(subscribeIndex).includes(".on('postgres_changes'"), false);
    assert.match(source, /subscriptionTask\s*=\s*subscriptionTask\s*\.then/);
    assert.match(source, /if \(initialized\) return/);
});
test('TeamLead report hides PnL by default and summarizes execution',()=>{const report=buildTeamReport([{trade_date:'2026-08-17',daily_metrics:{trades:[{symbol:'XYZ',opened:'05:00',setup:'Pump',rvol:8,atr:.5,disciplineScore:95,disciplineGrade:'A',pnl:500}]}}],[]);assert.equal(report.privacy.balancesHidden,true);assert.equal('pnl'in report.trades[0],false);assert.equal(report.kpis.premarketAdherence,100);assert.equal(report.kpis.averageDiscipline,95);});
test('mock realtime events are owner scoped and deduplicated',()=>{let now=100;const gate=createRealtimeEventGate({now:()=>now});const event={table:'journal_days',eventType:'UPDATE',new:{id:'d1',user_id:'u1',updated_at:'x'}};assert.equal(classifyRealtimeEvent(event,'u1'),'journal');assert.equal(classifyRealtimeEvent(event,'u2'),'ignore');assert.equal(gate(event),true);assert.equal(gate(event),false);now=6000;assert.equal(gate(event),true);assert.equal(classifyRealtimeEvent({table:'daily_reviews',new:{user_id:'u1'}},'u1'),'ai');});
test('PWA and Realtime infrastructure are wired safely',async()=>{const [manifest,sw,sql,index]=await Promise.all([readFile(new URL('../manifest.webmanifest',import.meta.url),'utf8'),readFile(new URL('../sw.js',import.meta.url),'utf8'),readFile(new URL('../supabase/migrations/20260817201604_enable_strum_realtime.sql',import.meta.url),'utf8'),readFile(new URL('../index.html',import.meta.url),'utf8')]);assert.equal(JSON.parse(manifest).display,'standalone');assert.match(index,/apple-mobile-web-app-capable/);assert.match(sw,/startsWith\('\/api\/'\)/);assert.match(sql,/supabase_realtime add table public\.journal_days/i);assert.match(sql,/daily_reviews/i);});
