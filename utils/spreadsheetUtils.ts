import { Buffer } from 'buffer';
import ExcelJS from 'exceljs';

export async function loadXlsxWorkbook(data: ArrayBuffer | Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data));
  return workbook;
}

export function createWorkbookFromRows(rows: any[][], sheetName: string): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet(sheetName.slice(0, 31)).addRows(rows);
  return workbook;
}

function getCellValue(value: ExcelJS.CellValue): any {
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result;
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value ?? '';
}

export function worksheetToRows(worksheet: ExcelJS.Worksheet): any[][] {
  const rows: any[][] = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    const values: any[] = [];
    for (let column = 1; column <= worksheet.columnCount; column++) {
      values.push(getCellValue(row.getCell(column).value));
    }
    rows.push(values);
  });
  return rows;
}

export function worksheetToJson(worksheet: ExcelJS.Worksheet, defval: any = ''): Record<string, any>[] {
  const rows = worksheetToRows(worksheet);
  return rowsToJson(rows, defval);
}

export function rowsToJson(rows: any[][], defval: any = ''): Record<string, any>[] {
  if (rows.length < 2) return [];

  const headers = rows[0].map((header, index) => String(header || `__EMPTY${index ? `_${index}` : ''}`).trim());
  return rows.slice(1)
    .filter(row => row.some(value => value !== '' && value !== null && value !== undefined))
    .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? defval])));
}

export function parseCsvRows(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

export function worksheetToCsv(worksheet: ExcelJS.Worksheet): string {
  return worksheetToRows(worksheet)
    .map(row => row.map(value => {
      const text = value instanceof Date ? value.toISOString() : String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(','))
    .join('\n');
}

export async function downloadXlsxWorkbook(workbook: ExcelJS.Workbook, fileName: string): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const arrayBuffer = new Uint8Array(buffer).slice().buffer as ArrayBuffer;
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
