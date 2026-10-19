import fs from 'node:fs';
import path from 'node:path';
import { fromSerial, EN_MONTHS } from '../dates';
import type { Cell, SheetInfo, SheetsApi } from './types';
import { mockSeed } from './seed';

/**
 * ชีทจำลองสำหรับทดสอบในเครื่อง — ทำงานเหมือน Sheets API ในส่วนที่แอปใช้
 * เก็บข้อมูลไว้ใน web/.mock/sheet.json (ลบไฟล์เพื่อเริ่มใหม่)
 */

export interface MockCell { v: Cell; fmt?: string }
export interface MockSheet { title: string; sheetId: number; rows: (MockCell | null)[][] }
export interface MockBook { sheets: MockSheet[] }

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatCell(c: MockCell | null | undefined): Cell {
  if (!c || c.v === '' || c.v === null || c.v === undefined) return '';
  if (typeof c.v === 'number' && c.fmt) {
    const p = fromSerial(c.v);
    if (c.fmt === 'mmm-yy') return EN_MONTHS[p.m - 1] + '-' + pad2(p.y % 100);
    if (c.fmt === 'd/m/yyyy') return p.d + '/' + p.m + '/' + p.y;
    if (c.fmt === 'd mmm yyyy') return p.d + ' ' + EN_MONTHS[p.m - 1] + ' ' + p.y;
  }
  return typeof c.v === 'boolean' ? (c.v ? 'TRUE' : 'FALSE') : String(c.v);
}

/** รองรับ 'แท็บ', 'แท็บ'!A1, 'แท็บ'!A1:B2, 'แท็บ'!A3:J, 'แท็บ'!1:20 */
function parseRange(range: string) {
  const m = /^'((?:[^']|'')*)'(?:!(.+))?$/.exec(range);
  if (!m) throw new Error('mock: รูปแบบช่วงไม่รองรับ ' + range);
  const title = m[1].replace(/''/g, "'");
  if (!m[2]) return { title, r1: 1, c1: 1, r2: Infinity, c2: Infinity };
  const col = (s: string) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const ref = (s: string) => {
    const x = /^([A-Z]*)(\d*)$/.exec(s);
    if (!x) throw new Error('mock: รูปแบบช่วงไม่รองรับ ' + range);
    return { c: x[1] ? col(x[1]) : 0, r: x[2] ? Number(x[2]) : 0 };
  };
  const [a, b] = m[2].split(':');
  const s = ref(a);
  const e = b === undefined ? s : ref(b);
  return {
    title,
    r1: s.r || 1, c1: s.c || 1,
    r2: e.r || (b === undefined ? s.r : Infinity),
    c2: e.c || (b === undefined ? s.c : Infinity),
  };
}

function isEmpty(c: MockCell | null | undefined) {
  return !c || c.v === '' || c.v === null || c.v === undefined;
}

export class MockSheets implements SheetsApi {
  constructor(private book: MockBook, private persist: () => void = () => {}) {}

  private sheet(title: string) {
    const s = this.book.sheets.find(x => x.title === title);
    if (!s) throw new Error('mock: ไม่พบแท็บ ' + title);
    return s;
  }
  private byId(id: number) {
    const s = this.book.sheets.find(x => x.sheetId === id);
    if (!s) throw new Error('mock: ไม่พบ sheetId ' + id);
    return s;
  }
  private set(s: MockSheet, r: number, c: number, cell: MockCell | null) {
    while (s.rows.length < r) s.rows.push([]);
    const row = s.rows[r - 1];
    while (row.length < c) row.push(null);
    row[c - 1] = cell;
  }

  async listSheets(): Promise<SheetInfo[]> {
    return this.book.sheets.map(s => ({ title: s.title, sheetId: s.sheetId, rowCount: s.rows.length + 1000 }));
  }

  async getValues(ranges: string[], formatted: boolean): Promise<Cell[][][]> {
    return ranges.map(range => {
      const { title, r1, c1, r2, c2 } = parseRange(range);
      const s = this.sheet(title);
      const out: Cell[][] = [];
      const lastRow = Math.min(r2, s.rows.length);
      for (let r = r1; r <= lastRow; r++) {
        const row = s.rows[r - 1] || [];
        const vals: Cell[] = [];
        const lastCol = Math.min(c2, row.length);
        for (let c = c1; c <= lastCol; c++) {
          const cell = row[c - 1];
          vals.push(isEmpty(cell) ? '' : formatted ? formatCell(cell) : cell!.v);
        }
        while (vals.length && vals[vals.length - 1] === '') vals.pop(); // API ตัดเซลล์ว่างท้ายแถว
        out.push(vals);
      }
      while (out.length && !out[out.length - 1].length) out.pop(); // และแถวว่างท้ายช่วง
      return out;
    });
  }

  async updateValues(data: { range: string; values: Cell[][] }[]) {
    for (const d of data) {
      const { title, r1, c1 } = parseRange(d.range);
      const s = this.sheet(title);
      d.values.forEach((row, i) => row.forEach((v, j) => {
        const old = s.rows[r1 + i - 1]?.[c1 + j - 1];
        this.set(s, r1 + i, c1 + j, { v, fmt: old?.fmt });
      }));
    }
    this.persist();
  }

  async appendRow(sheetTitle: string, values: Cell[]) {
    const s = this.sheet(sheetTitle);
    let last = s.rows.length;
    while (last > 0 && (s.rows[last - 1] || []).every(isEmpty)) last--;
    values.forEach((v, j) => this.set(s, last + 1, j + 1, { v }));
    this.persist();
  }

  async copyRowFormat(sheetId: number, fromRow: number, toRow: number, width: number) {
    const s = this.byId(sheetId);
    for (let c = 1; c <= width; c++) {
      const src = s.rows[fromRow - 1]?.[c - 1];
      const dst = s.rows[toRow - 1]?.[c - 1];
      this.set(s, toRow, c, { v: dst?.v ?? '', fmt: src?.fmt });
    }
    this.persist();
  }

  async insertRowAfter(sheetId: number, row: number) {
    const s = this.byId(sheetId);
    s.rows.splice(row, 0, []);
    this.persist();
  }

  async appendRows() {
    // ชีทจำลองขยายเองอัตโนมัติ
  }

  async setNumberFormat(sheetId: number, row: number, col: number, pattern: string, type: 'DATE' | 'TEXT') {
    const s = this.byId(sheetId);
    const old = s.rows[row - 1]?.[col - 1];
    this.set(s, row, col, { v: old?.v ?? '', fmt: type === 'DATE' ? pattern : undefined });
    this.persist();
  }

  async addSheet(title: string): Promise<SheetInfo> {
    if (this.book.sheets.some(s => s.title === title)) throw new Error('mock: มีแท็บ ' + title + ' แล้ว');
    const sheetId = Math.max(0, ...this.book.sheets.map(s => s.sheetId)) + 1;
    this.book.sheets.push({ title, sheetId, rows: [] });
    this.persist();
    return { title, sheetId };
  }

  /** สำหรับทดสอบ */
  dump(title: string) {
    return this.sheet(title).rows;
  }
}

/** ชีทจำลองที่เก็บลงไฟล์ — ใช้ตอน `npm run dev` โดยไม่มี service account */
export function createFileMock(): MockSheets {
  const g = globalThis as unknown as { __pfMock?: MockSheets };
  if (g.__pfMock) return g.__pfMock;
  const file = path.join(process.cwd(), '.mock', 'sheet.json');
  let book: MockBook;
  try {
    book = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    book = mockSeed();
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(book));
  };
  persist();
  g.__pfMock = new MockSheets(book, persist);
  return g.__pfMock;
}
