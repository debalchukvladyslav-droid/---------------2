import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterTerminalRows } from '../js/terminal_trade_filters.js';
import { shortcutAction } from '../js/terminal_shortcuts.js';

test('terminal filters combine ticker, RVOL, ATR and premarket time instantly',()=>{const rows=[{trade:{symbol:'XYZ',rvol:1200,atr:1.2,opened:'2026-08-07 04:35'}},{trade:{symbol:'ABC',rvol:300,atr:.3,opened:'2026-08-07 08:00'}}];const result=filterTerminalRows(rows,{query:'xy',minRvol:1000,minAtr:1,timeFrom:'04:00',timeTo:'05:00'});assert.equal(result.length,1);assert.equal(result[0].trade.symbol,'XYZ');});
test('terminal shortcuts ignore arrows in inputs and map fast actions',()=>{assert.equal(shortcutAction({key:'n',altKey:true,target:{matches:()=>false}}),'new-trade');assert.equal(shortcutAction({key:'Enter',ctrlKey:true,target:{matches:()=>true}}),'save-trade');assert.equal(shortcutAction({key:'ArrowRight',target:{matches:()=>true}}),'');assert.equal(shortcutAction({key:'ArrowLeft',target:{matches:()=>false}}),'previous-chart');});
test('Trader DNA page and route are removed from the application shell',async()=>{const[index,sidebar,ui]=await Promise.all([readFile(new URL('../index.html',import.meta.url),'utf8'),readFile(new URL('../partials/layout/app-sidebar.html',import.meta.url),'utf8'),readFile(new URL('../js/ui.js',import.meta.url),'utf8')]);assert.doesNotMatch(index,/debrief-view\.html|22_grandmaster\.css/);assert.doesNotMatch(sidebar,/data-tab="debrief"|Trader DNA/);assert.doesNotMatch(ui,/debrief:\s*'\/debrief'/);});
