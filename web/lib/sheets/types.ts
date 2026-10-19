/** ชั้นล่างสุดที่คุยกับ Google Sheets — มีทั้งตัวจริง (google.ts) และตัวจำลอง (mock.ts) */

export type Cell = string | number | boolean;

export interface SheetInfo {
  title: string;
  sheetId: number;
  rowCount?: number;
}

export interface SheetsApi {
  listSheets(): Promise<SheetInfo[]>;
  /**
   * อ่านหลายช่วงพร้อมกัน (A1 notation)
   * formatted = true → ค่าที่แสดงในชีท (เหมือน getDisplayValues)
   * formatted = false → ค่าดิบ วันที่เป็นตัวเลข serial ข้อความเป็น string (เหมือน getValues)
   */
  getValues(ranges: string[], formatted: boolean): Promise<Cell[][][]>;
  /** เขียนค่าแบบ RAW — ข้อความไม่ถูกตีความเป็นสูตร */
  updateValues(data: { range: string; values: Cell[][] }[]): Promise<void>;
  /** เพิ่มแถวต่อท้ายตาราง (ใช้กับแท็บ Users / AuditLog) */
  appendRow(sheetTitle: string, values: Cell[]): Promise<void>;
  /** คัดลอกรูปแบบเซลล์ทั้งแถว (แถวเริ่มที่ 1) */
  copyRowFormat(sheetId: number, fromRow: number, toRow: number, width: number): Promise<void>;
  /** แทรกแถวว่างใต้แถว row (แถวเริ่มที่ 1) */
  insertRowAfter(sheetId: number, row: number): Promise<void>;
  /** เพิ่มแถวว่างท้ายแท็บ (ใช้เมื่อตารางยาวจนสุดขอบชีท) */
  appendRows(sheetId: number, count: number): Promise<void>;
  /** ตั้งรูปแบบตัวเลข/วันที่ของเซลล์ (แถว/คอลัมน์เริ่มที่ 1) */
  setNumberFormat(sheetId: number, row: number, col: number, pattern: string, type: 'DATE' | 'TEXT'): Promise<void>;
  addSheet(title: string): Promise<SheetInfo>;
}

/** คอลัมน์ที่ 1 → A, 27 → AA */
export function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function a1(title: string, row: number, col: number, row2?: number, col2?: number): string {
  const sheet = "'" + title.replace(/'/g, "''") + "'";
  const start = colLetter(col) + row;
  if (row2 === undefined || col2 === undefined) return sheet + '!' + start;
  return sheet + '!' + start + ':' + colLetter(col2) + row2;
}

/** ช่วงแบบไม่ระบุแถวสุดท้าย เช่น 'แท็บ'!A3:J — อ่านถึงแถวสุดท้ายที่มีข้อมูล */
export function a1Open(title: string, row: number, col: number, col2: number): string {
  return "'" + title.replace(/'/g, "''") + "'!" + colLetter(col) + row + ':' + colLetter(col2);
}

/** แถว row1 ถึง row2 ทุกคอลัมน์ เช่น 'แท็บ'!1:20 */
export function a1Rows(title: string, row1: number, row2: number): string {
  return "'" + title.replace(/'/g, "''") + "'!" + row1 + ':' + row2;
}

export function sheetRange(title: string): string {
  return "'" + title.replace(/'/g, "''") + "'";
}
