import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { tradingWorkbookBuffer } from '../lib/trading_export.js';

test('XLSX export has three polished owner-data tabs and live formulas', async () => {
    const days = [{ trade_date:'2026-08-17', daily_metrics:{ trades:[{ symbol:'XYZ',type:'SHORT',opened:'05:15',setup:'Pump & Dump Short',entry:4,stop:4.2,exit:3.6,net:200,gapPct:18.5,rvol:8,floatShares:12500000,atr:.55,disciplineGrade:'A',disciplineScore:100,disciplineReasons:[] }] } }];
    const reviews = [{ trade_date:'2026-08-17',status:'ready',model_name:'gemini',debrief:'Good execution',strengths:['Risk plan'],mistakes:[],next_session_rules:['Repeat'] }];
    const buffer = await tradingWorkbookBuffer({ days, reviews, generatedAt:new Date('2026-08-17T12:00:00Z') }); assert.ok(buffer.byteLength > 5000);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    assert.deepEqual(workbook.worksheets.map((sheet)=>sheet.name), ['Raw Trade Data','AI Insights & Debriefs','Summary Dashboard']);
    assert.equal(workbook.getWorksheet('Raw Trade Data').getCell('D4').value, 'XYZ');
    assert.equal(workbook.getWorksheet('AI Insights & Debriefs').getCell('D4').value, 'Good execution');
    assert.match(workbook.getWorksheet('Summary Dashboard').getCell('B5').value.formula, /COUNTIF/);
    assert.equal(workbook.getWorksheet('Raw Trade Data').views[0].state, 'frozen');
});

test('spreadsheet formula injection is neutralized', async () => {
    const buffer=await tradingWorkbookBuffer({days:[{trade_date:'2026-08-17',daily_metrics:{trades:[{symbol:'=HYPERLINK("bad")',setup:'+CMD',disciplineReasons:['@evil']}]}}]}); const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); const sheet=workbook.getWorksheet('Raw Trade Data'); assert.match(sheet.getCell('D4').value,/^'/); assert.match(sheet.getCell('F4').value,/^'/);
});
