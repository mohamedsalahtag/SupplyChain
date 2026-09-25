/** Excel (.xlsx) downloads. ExcelJS is loaded only when a user exports (it is large). */
export type Cell = string | number | null | undefined;
export type Sheet = { name: string; header: string[]; rows: Cell[][]; title?: string };

/** "2000.000" → 2000 (a real number Excel can add up); other text stays text. */
const asCell = (v: Cell) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v ?? '');

export async function downloadXlsx(fileName: string, sheets: Sheet[]) {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    let top = 1;
    if (s.title) { ws.addRow([s.title]).font = { bold: true, size: 12 }; top = 2; }
    const head = ws.addRow(s.header);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    for (const r of s.rows) ws.addRow(r.map(asCell));
    ws.views = [{ state: 'frozen', ySplit: top }];
    ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top, column: s.header.length } };
    s.header.forEach((h, i) => {
      const longest = Math.max(h.length, ...s.rows.slice(0, 500).map((r) => String(r[i] ?? '').length));
      ws.getColumn(i + 1).width = Math.min(60, Math.max(8, longest + 2));
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}
