/** Excel (.xlsx) downloads. ExcelJS is loaded only when a user exports (it is large). */
export type Cell = string | number | null | undefined;
/**
 * One worksheet. `numeric` names the header columns whose decimal strings ("2000.000") become real numbers Excel can add up;
 * every other string stays text, so identifiers (PO, demand, supplier and material numbers) keep their exact spelling and
 * leading zeros. JavaScript numbers are always written as numbers.
 */
export type Sheet = { name: string; header: string[]; rows: Cell[][]; title?: string; numeric?: string[] };
/** An optional "About this export" sheet: label → value lines (when it was made, the filters applied, how to read it). */
export type About = [string, string][];

const NUMBER = /^-?\d+(\.\d+)?$/;
const asCell = (v: Cell, numeric: boolean) => (numeric && typeof v === 'string' && NUMBER.test(v) ? Number(v) : v ?? '');

export async function downloadXlsx(fileName: string, sheets: Sheet[], about?: About) {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    const numeric = s.header.map((h) => !!s.numeric?.includes(h));
    let top = 1;
    if (s.title) { ws.addRow([s.title]).font = { bold: true, size: 12 }; top = 2; }
    const head = ws.addRow(s.header);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    for (const r of s.rows) ws.addRow(r.map((v, i) => asCell(v, numeric[i])));
    ws.views = [{ state: 'frozen', ySplit: top }];
    ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top, column: s.header.length } };
    s.header.forEach((h, i) => {
      const longest = Math.max(h.length, ...s.rows.slice(0, 500).map((r) => String(r[i] ?? '').length));
      ws.getColumn(i + 1).width = Math.min(60, Math.max(8, longest + 2));
    });
  }
  if (about?.length) {
    const ws = wb.addWorksheet('About this export');
    ws.addRow(['About this export']).font = { bold: true, size: 12 };
    for (const [k, v] of about) ws.addRow([k, v]).getCell(1).font = { bold: true };
    ws.getColumn(1).width = 24;
    ws.getColumn(2).width = 100;
  }
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}
