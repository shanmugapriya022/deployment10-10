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

export const SAMPLE_DATA_DRIVEN_ROWS = [
  ['testCaseId', 'scenario', 'username', 'password', 'searchQuery', 'itemCount', 'expectedStatus', 'expectedMessage'],
  ['TC-001', 'Standard User Login', 'standard_user', 'secret_sauce', 'Sauce Labs Backpack', 1, 'Success', 'Products page displayed'],
  ['TC-002', 'Locked Out User', 'locked_out_user', 'secret_sauce', 'N/A', 0, 'Error', 'Sorry, this user has been locked out.'],
  ['TC-003', 'Problem User Checkout', 'problem_user', 'secret_sauce', 'Sauce Labs Bike Light', 2, 'Success', 'Order completed successfully'],
  ['TC-004', 'Performance Glitch User', 'performance_glitch_user', 'secret_sauce', 'Sauce Labs Bolt T-Shirt', 1, 'Success', 'Loaded and validated']
];

export const SAMPLE_DATA_DRIVEN_JSON = [
  {
    testCaseId: 'TC-001',
    scenario: 'Standard User Login',
    username: 'standard_user',
    password: 'secret_sauce',
    searchQuery: 'Sauce Labs Backpack',
    itemCount: 1,
    expectedStatus: 'Success',
    expectedMessage: 'Products page displayed'
  },
  {
    testCaseId: 'TC-002',
    scenario: 'Locked Out User',
    username: 'locked_out_user',
    password: 'secret_sauce',
    searchQuery: 'N/A',
    itemCount: 0,
    expectedStatus: 'Error',
    expectedMessage: 'Sorry, this user has been locked out.'
  },
  {
    testCaseId: 'TC-003',
    scenario: 'Problem User Checkout',
    username: 'problem_user',
    password: 'secret_sauce',
    searchQuery: 'Sauce Labs Bike Light',
    itemCount: 2,
    expectedStatus: 'Success',
    expectedMessage: 'Order completed successfully'
  },
  {
    testCaseId: 'TC-004',
    scenario: 'Performance Glitch User',
    username: 'performance_glitch_user',
    password: 'secret_sauce',
    searchQuery: 'Sauce Labs Bolt T-Shirt',
    itemCount: 1,
    expectedStatus: 'Success',
    expectedMessage: 'Loaded and validated'
  }
];

export interface ParsedJsonDatasetResult {
  sheetNames: string[];
  activeSheet: string;
  headers: string[];
  rows: Record<string, any>[];
  allSheetsData: Record<string, { headers: string[]; rows: Record<string, any>[] }>;
  rawJsonText: string;
}

export function parseJsonDataset(text: string): ParsedJsonDatasetResult {
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  if (!cleanText) {
    throw new Error('Uploaded JSON file is empty.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleanText);
  } catch (err: any) {
    throw new Error(`Invalid JSON syntax: ${err?.message || 'Parse failed'}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new Error('JSON file cannot be null or undefined.');
  }

  const formattedRawText = JSON.stringify(parsed, null, 2);

  // Helper to extract headers & clean rows from an array of objects
  const processObjectArray = (arr: any[]): { headers: string[]; rows: Record<string, any>[] } => {
    if (!Array.isArray(arr) || arr.length === 0) {
      return { headers: [], rows: [] };
    }

    // Check if 2D array of rows
    if (Array.isArray(arr[0])) {
      const rawHeaders = arr[0].map((h, idx) => String(h || `Column_${idx + 1}`).trim());
      const rawRows = rowsToJson(arr);
      return { headers: rawHeaders, rows: rawRows };
    }

    const headerSet = new Set<string>();
    const normalizedRows: Record<string, any>[] = [];

    arr.forEach(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        Object.keys(item).forEach(key => headerSet.add(key));
        normalizedRows.push(item);
      } else if (item !== undefined && item !== null) {
        headerSet.add('value');
        normalizedRows.push({ value: item });
      }
    });

    const headers = Array.from(headerSet);
    return { headers, rows: normalizedRows };
  };

  // Case 1: Array at root level e.g. [ { col: val }, ... ]
  if (Array.isArray(parsed)) {
    const { headers, rows } = processObjectArray(parsed);
    if (rows.length === 0) {
      throw new Error('JSON array contains no test data rows.');
    }
    if (headers.length === 0) {
      throw new Error('JSON array records contain no valid properties or columns.');
    }

    return {
      sheetNames: ['JSON Data'],
      activeSheet: 'JSON Data',
      headers,
      rows,
      allSheetsData: {
        'JSON Data': { headers, rows }
      },
      rawJsonText: formattedRawText
    };
  }

  // Case 2: Object with one or more array properties (e.g. { data: [...] } or { users: [...], orders: [...] })
  if (typeof parsed === 'object') {
    const arrayKeys = Object.keys(parsed).filter(k => Array.isArray(parsed[k]));

    if (arrayKeys.length > 0) {
      const allSheets: Record<string, { headers: string[]; rows: Record<string, any>[] }> = {};
      const sheetNames: string[] = [];

      arrayKeys.forEach(sheetKey => {
        const { headers, rows } = processObjectArray(parsed[sheetKey]);
        allSheets[sheetKey] = { headers, rows };
        sheetNames.push(sheetKey);
      });

      const initialSheet = sheetNames.find(s => allSheets[s]?.rows?.length > 0) || sheetNames[0];
      const activeData = allSheets[initialSheet] || { headers: [], rows: [] };

      if (activeData.rows.length === 0) {
        throw new Error(`JSON property "${initialSheet}" is an empty array.`);
      }

      return {
        sheetNames,
        activeSheet: initialSheet,
        headers: activeData.headers,
        rows: activeData.rows,
        allSheetsData: allSheets,
        rawJsonText: formattedRawText
      };
    }

    // Case 3: Single test data object e.g. { username: "admin", password: "123" }
    const keys = Object.keys(parsed);
    if (keys.length === 0) {
      throw new Error('JSON object contains no properties.');
    }

    return {
      sheetNames: ['JSON Data'],
      activeSheet: 'JSON Data',
      headers: keys,
      rows: [parsed],
      allSheetsData: {
        'JSON Data': { headers: keys, rows: [parsed] }
      },
      rawJsonText: formattedRawText
    };
  }

  throw new Error('Expected JSON object or array of objects with test data records.');
}

export function downloadJsonFile(data: any, fileName: string): void {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
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
