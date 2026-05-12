import { parseSheetDateCellToIso } from './parser_utils.js';

export const SHEET_DATA_FIRST_ROW = 6;

export function columnLetterToIndex(letters) {
    const s = String(letters || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!s) return -1;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i) - 64;
        if (c < 1 || c > 26) return -1;
        n = n * 26 + c;
    }
    return n - 1;
}

function isColumnLetterToken(v) {
    return typeof v === 'string' && /^[A-Z]{1,3}$/i.test(v.trim());
}

function parseColumnRangeToken(raw) {
    const v = String(raw || '').trim().toUpperCase().replace(/\$/g, '');
    if (!v) return null;

    let match = /^([A-Z]{1,3})(\d+)?(?::([A-Z]{1,3}))?$/.exec(v);
    if (match && (!match[3] || match[3] === match[1])) {
        return { letter: match[1], row: match[2] ? Number(match[2]) : null };
    }

    match = /^([A-Z]{1,3})(\d+)?:([A-Z]{1,3})(\d+)?$/.exec(v);
    if (match && match[1] === match[3]) {
        return { letter: match[1], row: match[2] ? Number(match[2]) : null };
    }

    return null;
}

export function smartValueToColumnIndex(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v || v.includes(',')) return -1;
    const rangeToken = parseColumnRangeToken(v);
    const letter = rangeToken ? rangeToken.letter : isColumnLetterToken(v) ? v.toUpperCase() : v;
    if (!letter || letter.includes(',')) return -1;
    return columnLetterToIndex(letter);
}

function parseExceptionColumnIndices(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return [];
    return v
        .split(',')
        .map((p) => smartValueToColumnIndex(p.trim()))
        .filter((idx) => idx >= 0);
}

function parseColumnIndices(raw) {
    return String(raw || '')
        .split(',')
        .map((p) => smartValueToColumnIndex(p.trim()))
        .filter((idx) => idx >= 0);
}

function getCell(row, colIdx) {
    if (colIdx < 0 || !Array.isArray(row)) return '';
    return row[colIdx] != null && row[colIdx] !== '' ? row[colIdx] : '';
}

function joinedCells(row, indices = []) {
    return indices
        .map((ix) => String(getCell(row, ix)).trim())
        .filter(Boolean)
        .join('; ');
}

function cellStr(row, colIdx) {
    if (colIdx < 0 || !Array.isArray(row)) return '';
    const v = row[colIdx];
    return v != null && String(v).trim() !== '' ? String(v).trim() : '';
}

function parseMoneyCell(v) {
    if (v == null || v === '') return 0;
    const s = String(v).replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
}

function parseOptionalNumber(v) {
    if (v == null || String(v).trim() === '') return null;
    const s = String(v).replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function computeStopFromEntryAndCents(entryPrice, consolidateCents) {
    const entry = Number(entryPrice);
    const cents = parseOptionalNumber(consolidateCents);
    if (!Number.isFinite(entry) || cents == null) return null;
    return Math.round((entry + cents / 100) * 10000) / 10000;
}

function sheetsCellToTimeString(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
        const fraction = value - Math.floor(value);
        if (fraction > 0) {
            const totalMinutes = Math.round(fraction * 24 * 60);
            const hh = Math.floor(totalMinutes / 60) % 24;
            const mm = totalMinutes % 60;
            return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
        }
    }
    const s = String(value).trim();
    const m = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(s);
    if (!m) return '';
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3] || 0);
    const ampm = m[4]?.toUpperCase();
    if (ampm === 'PM' && hh < 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    if (hh > 23 || mm > 59 || ss > 59) return '';
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function isLikelyTicker(v) {
    const t = String(v).trim().toUpperCase();
    if (t.length < 1 || t.length > 15) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
    if (/^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(String(v).trim())) return false;
    if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(t)) return false;
    if (/^\d+$/.test(t) && t.length > 5) return false;
    return true;
}

export function isValidIsoDateString(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseSheetGridToTrades(values, smartColumns, spreadsheetId, startRow = SHEET_DATA_FIRST_ROW) {
    const dateIdx = smartValueToColumnIndex(smartColumns.date || '');
    const symIdx = smartValueToColumnIndex(smartColumns.symbol || '');
    const profitIdx = smartValueToColumnIndex(smartColumns.profit || '');
    const profitRiskIdx = smartValueToColumnIndex(smartColumns.profitRisk || '');
    const typeIdx = smartValueToColumnIndex(smartColumns.tradeType || '');
    const typeMultiIdx = parseColumnIndices(smartColumns.tradeType || '');
    const pvIdx = smartValueToColumnIndex(smartColumns.pv || '');
    const altPvIdx = smartValueToColumnIndex(smartColumns.altPv || '');
    const exModeManual = typeof smartColumns.exceptions === 'string' && smartColumns.exceptions.includes(',');
    const exSelectIdx = exModeManual ? -1 : smartValueToColumnIndex(smartColumns.exceptions || '');
    const exMultiIdx = exModeManual ? parseExceptionColumnIndices(smartColumns.exceptions || '') : [];

    const cTrader = smartValueToColumnIndex(smartColumns.traderComment || '');
    const cExit = smartValueToColumnIndex(smartColumns.exit || '');
    const cTeam = smartValueToColumnIndex(smartColumns.teamLeadComment || '');
    const cPaper = smartValueToColumnIndex(smartColumns.paperType || '');
    const cPeriod = smartValueToColumnIndex(smartColumns.period || '');
    const cGrowth = smartValueToColumnIndex(smartColumns.growthPct || '');
    const cRisk = smartValueToColumnIndex(smartColumns.riskUsd || '');
    const cCons = smartValueToColumnIndex(smartColumns.consolidateCents || '');
    const cEntry = smartValueToColumnIndex(smartColumns.entryPrice || '');
    const cQty = smartValueToColumnIndex(smartColumns.qtyShares || '');
    const cQtyCalc = smartValueToColumnIndex(smartColumns.qtySharesCalc || '');

    const dateAnchors = {};
    const outByDay = {};
    let activeDate = null;

    if (!Array.isArray(values)) {
        return { outByDay, dateAnchors, stats: { tradeCount: 0, dayCount: 0 } };
    }

    for (let i = 0; i < values.length; i++) {
        const row = values[i] || [];
        const excelRow = startRow + i;
        const dateRaw = getCell(row, dateIdx);
        const parsedDate = parseSheetDateCellToIso(dateRaw);
        if (parsedDate) {
            activeDate = parsedDate;
            if (dateAnchors[parsedDate] == null) dateAnchors[parsedDate] = excelRow;
        }

        const symRaw = getCell(row, symIdx);
        if (!activeDate || symRaw === '' || symRaw == null || !isLikelyTicker(symRaw)) continue;

        const symbol = String(symRaw).trim().toUpperCase();
        const timeStr = '09:30:00';
        const profitRaw = profitIdx >= 0 ? getCell(row, profitIdx) : '';
        const hasProfitCell = profitRaw != null && String(profitRaw).trim() !== '';
        const net = hasProfitCell ? parseMoneyCell(profitRaw) : 0;
        const gross = net;
        const typeCell = typeMultiIdx.length > 1
            ? joinedCells(row, typeMultiIdx)
            : (typeIdx >= 0 ? String(getCell(row, typeIdx)).trim() : '');

        let exceptionStr = '';
        if (exSelectIdx >= 0) {
            exceptionStr = String(getCell(row, exSelectIdx)).trim();
        } else if (exMultiIdx.length) {
            exceptionStr = exMultiIdx.map((ix) => String(getCell(row, ix)).trim()).filter(Boolean).join('; ');
        }

        const pvCell = pvIdx >= 0 ? getCell(row, pvIdx) : '';
        const altPvStr = cellStr(row, altPvIdx);
        const exitStr = cellStr(row, cExit);
        const entryNum = cEntry >= 0 ? parseMoneyCell(getCell(row, cEntry)) : NaN;
        const consolidateCents = cellStr(row, cCons);
        const stopPrice = computeStopFromEntryAndCents(entryNum, consolidateCents);
        const qtyRaw = cQty >= 0 ? String(getCell(row, cQty)).replace(/\s/g, '').replace(/,/g, '') : '';
        const qtyNum = qtyRaw !== '' ? parseFloat(qtyRaw) : NaN;

        const sheet = {
            source: 'google',
            spreadsheetId,
            sheetRow: excelRow,
            sheetNet: hasProfitCell ? net : undefined,
            sheetGross: hasProfitCell ? gross : undefined,
            tradeType: typeCell || undefined,
            profitRisk: cellStr(row, profitRiskIdx) || undefined,
            pv: pvCell !== '' && pvCell != null ? String(pvCell) : undefined,
            altPv: altPvStr || undefined,
            exception: exceptionStr || undefined,
            exceptions: exceptionStr ? [exceptionStr] : undefined,
            traderComment: cellStr(row, cTrader) || undefined,
            exit: exitStr || undefined,
            teamLeadComment: cellStr(row, cTeam) || undefined,
            paperType: cellStr(row, cPaper) || undefined,
            period: cellStr(row, cPeriod) || undefined,
            growthPct: cellStr(row, cGrowth) || undefined,
            riskUsd: cellStr(row, cRisk) || undefined,
            consolidateCents: consolidateCents || undefined,
            entryPrice: Number.isFinite(entryNum) && entryNum !== 0 ? entryNum : undefined,
            stopPrice: stopPrice ?? undefined,
            qtyShares: Number.isFinite(qtyNum) && qtyNum !== 0 ? qtyNum : undefined,
            qtySharesCalc: cellStr(row, cQtyCalc) || undefined,
        };

        const trade = {
            symbol,
            type: typeCell || 'Google Sheet',
            opened: `${activeDate} ${timeStr}`,
            closed: `${activeDate} 16:00:00`,
            held: '',
            entry: Number.isFinite(entryNum) ? entryNum : 0,
            exit: 0,
            stop: stopPrice ?? undefined,
            qty: Number.isFinite(qtyNum) ? Math.round(qtyNum) : 0,
            gross,
            comm: 0,
            net,
            sheet,
        };

        if (!outByDay[activeDate]) outByDay[activeDate] = [];
        outByDay[activeDate].push(trade);
    }

    const dates = Object.keys(outByDay);
    const tradeCount = dates.reduce((n, d) => n + outByDay[d].length, 0);
    return { outByDay, dateAnchors, stats: { tradeCount, dayCount: dates.length } };
}
