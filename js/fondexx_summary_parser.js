function roundMoney(value) {
    return parseFloat((Number(value) || 0).toFixed(2));
}

function parseMoney(value) {
    const cleaned = String(value ?? '').replace(/\s/g, '').replace(/[$,]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

function findHeaderIndex(headers, names) {
    const wanted = names.map((name) => String(name).trim().toLowerCase());
    return headers.findIndex((header) => wanted.includes(String(header || '').trim().toLowerCase()));
}

function findTotalDeltaIndex(headers) {
    return headers.findIndex((header) => {
        const normalized = String(header || '').trim().toLowerCase();
        return normalized.startsWith('total') && (
            normalized.includes('δ')
            || normalized.includes('delta')
            || normalized === 'total d'
        );
    });
}

function getMonthKey(dateStr) {
    return String(dateStr || '').slice(0, 7);
}

function toIsoFromParts(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidIsoDateString(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function todayIsoDate() {
    const now = new Date();
    return toIsoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isFutureIsoDate(iso) {
    return isValidIsoDateString(iso) && iso > todayIsoDate();
}

function parseSlashDatePreferDayMonth(value) {
    const s = String(value || '').trim().split(/\s+/)[0];
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (!m) return null;

    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const dmy = toIsoFromParts(year, b, a);
    const mdy = toIsoFromParts(year, a, b);
    const dmyValid = isValidIsoDateString(dmy) ? dmy : null;
    const mdyValid = isValidIsoDateString(mdy) ? mdy : null;

    if (dmyValid && !isFutureIsoDate(dmyValid)) return dmyValid;
    if (mdyValid && !isFutureIsoDate(mdyValid)) return mdyValid;
    return dmyValid || mdyValid;
}

function isWeekendIsoDate(dateStr) {
    const [year, month, day] = String(dateStr || '').split('-').map(Number);
    if (!year || !month || !day) return false;
    const jsDay = new Date(year, month - 1, day).getDay();
    return jsDay === 0 || jsDay === 6;
}

function addMonthlyAdjustment(bucket, monthKey, adjustment) {
    if (!monthKey) return;
    const current = bucket[monthKey] || { pnl: 0, commissions: 0, locates: 0 };
    bucket[monthKey] = {
        pnl: roundMoney((Number(current.pnl) || 0) + (Number(adjustment.pnl) || 0)),
        commissions: roundMoney((Number(current.commissions) || 0) + (Number(adjustment.commissions) || 0)),
        locates: roundMoney((Number(current.locates) || 0) + (Number(adjustment.locates) || 0)),
    };
}

function sourceHasTradingActivity(row, indices) {
    return ['ordersIdx', 'fillsIdx', 'qtyIdx', 'grossIdx', 'netIdx'].some((key) => {
        const idx = indices[key];
        return idx >= 0 && Math.abs(parseMoney(row[idx])) >= 0.01;
    });
}

function isTradingRow(row, indices, dateStr, type) {
    if (isWeekendIsoDate(dateStr)) return false;
    if (type === 'eq' || type === 'equities') return true;
    if (type) return false;
    return sourceHasTradingActivity(row, indices);
}

export function parseFondexxSummaryByDateRows(rows) {
    const headerRow = rows.findIndex((row) => row.some((cell) => String(cell).trim().toLowerCase() === 'date'));
    if (headerRow < 0) throw new Error('Date column not found');

    const headers = rows[headerRow].map((h) => String(h || '').trim());
    const dateIdx = findHeaderIndex(headers, ['Date']);
    const typeIdx = findHeaderIndex(headers, ['Type']);
    const ordersIdx = findHeaderIndex(headers, ['Orders']);
    const fillsIdx = findHeaderIndex(headers, ['Fills']);
    const qtyIdx = findHeaderIndex(headers, ['Qty']);
    const grossIdx = findHeaderIndex(headers, ['Gross']);
    const netIdx = findHeaderIndex(headers, ['Net']);
    const totalIdx = findTotalDeltaIndex(headers);
    const adjNetIdx = findHeaderIndex(headers, ['Adj Net']);
    const commIdx = findHeaderIndex(headers, ['Comm']);
    const ecnIdx = findHeaderIndex(headers, ['Ecn Fee', 'ECN Fee']);
    const secIdx = findHeaderIndex(headers, ['SEC']);
    const tafIdx = findHeaderIndex(headers, ['TAF']);
    const nsccIdx = findHeaderIndex(headers, ['NSCC']);
    const clrIdx = findHeaderIndex(headers, ['CLR']);
    const miscIdx = findHeaderIndex(headers, ['Misc']);
    const orfIdx = findHeaderIndex(headers, ['ORF']);
    const ptfpfIdx = findHeaderIndex(headers, ['PTFPF']);
    const softwareIdx = findHeaderIndex(headers, ['Software']);

    if (dateIdx < 0 || grossIdx < 0 || netIdx < 0 || totalIdx < 0) {
        throw new Error('Date, Gross, Net and Total Delta columns are required');
    }

    const indices = { ordersIdx, fillsIdx, qtyIdx, grossIdx, netIdx };
    const feeIndices = [commIdx, ecnIdx, secIdx, tafIdx, nsccIdx, clrIdx, miscIdx, orfIdx, ptfpfIdx].filter((idx) => idx >= 0);
    const dailyRows = [];
    const monthlyAdjustments = {};
    const touchedMonths = new Set();
    const auditTotals = [];

    for (const row of rows.slice(headerRow + 1)) {
        const rawDate = String(row[dateIdx] || '').trim();
        if (!rawDate) continue;

        if (rawDate.toLowerCase() === 'equities') {
            auditTotals.push(roundMoney(parseMoney(row[totalIdx])));
            continue;
        }

        const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
            ? rawDate.slice(0, 10)
            : parseSlashDatePreferDayMonth(rawDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

        const type = typeIdx >= 0 ? String(row[typeIdx] || '').trim().toLowerCase() : '';
        const monthKey = getMonthKey(dateStr);
        const gross = roundMoney(parseMoney(row[grossIdx]));
        const net = roundMoney(parseMoney(row[netIdx]));
        const totalDelta = roundMoney(parseMoney(row[totalIdx]));
        const adjNet = adjNetIdx >= 0 ? roundMoney(parseMoney(row[adjNetIdx])) : totalDelta;
        const feeSum = roundMoney(feeIndices.reduce((sum, idx) => sum + parseMoney(row[idx]), 0));
        const software = softwareIdx >= 0 ? roundMoney(parseMoney(row[softwareIdx])) : 0;
        const comm = roundMoney((feeSum || roundMoney(gross - net)) + Math.abs(software));
        const locates = roundMoney(net - totalDelta);
        const pnl = totalDelta || adjNet;

        touchedMonths.add(monthKey);

        if (!isTradingRow(row, indices, dateStr, type)) {
            addMonthlyAdjustment(monthlyAdjustments, monthKey, { pnl, commissions: comm, locates });
            continue;
        }

        dailyRows.push({ dateStr, gross, net, comm, locates, totalDelta });
    }

    const parsedTotal = roundMoney(
        dailyRows.reduce((sum, row) => sum + row.totalDelta, 0)
        + Object.values(monthlyAdjustments).reduce((sum, item) => sum + (Number(item.pnl) || 0), 0),
    );

    return {
        dailyRows,
        monthlyAdjustments,
        touchedMonths: [...touchedMonths].sort(),
        auditTotals,
        parsedTotal,
    };
}
