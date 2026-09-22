// Sheets values responses omit trailing empty rows. Keep absolute row positions
// when concatenating pages, including completely empty intermediate pages.
export async function readSheetRangePages(range, { rowCount, read, pageSize = 500 }) {
    const match = /^(.*!)?([A-Z]+)(\d+):([A-Z]+)(\d+)?$/i.exec(range);
    if (!match) return read(range);
    const [, prefix = '', left, first, right, last] = match;
    const start = Number(first);
    const end = last ? Number(last) : Number(await rowCount());
    if (!Number.isSafeInteger(end) || end < 0) throw new Error('Invalid sheet row count');
    const values = [];
    values.hyperlinks = [];
    for (let row = start; row <= end; row += pageSize) {
        const stop = Math.min(end, row + pageSize - 1);
        const page = await read(`${prefix}${left}${row}:${right}${stop}`);
        if (!Array.isArray(page) || page.length > stop - row + 1) throw new Error('Invalid sheet page');
        for (let offset = 0; offset <= stop - row; offset++) {
            values.push(page[offset] || []);
            values.hyperlinks.push(page.hyperlinks?.[offset] || []);
        }
    }
    while (values.length && !values.at(-1).length && !values.hyperlinks.at(-1).length) { values.pop(); values.hyperlinks.pop(); }
    return values;
}
