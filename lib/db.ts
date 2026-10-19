/**
 * ตรรกะการอ่าน/เขียน Google Sheet — พอร์ตจาก apps-script/Code.gs
 * หาแท็บจากหัวคอลัมน์, เขียนต่อจากแถวล่าสุดที่มีวันที่ (ใช้เลขลำดับที่เตรียมไว้), ใช้รูปแบบเดือน/วันที่ตามแถวก่อนหน้า
 */
import { sheets, SHEET_NAMES, USERS_SHEET, AUDIT_SHEET } from './config';
import { a1, a1Open, a1Rows, sheetRange, type Cell, type SheetInfo } from './sheets/types';
import { parseIso, parseSheetDate, parseSheetMonth, sheetMonthText, thaiShort, toIso, toSerial, nowStamp, type Ymd } from './dates';

export type LogKey = 'exat' | 'bem';
type TableKey = LogKey | 'locations';

const TABLES: Record<TableKey, { label: string; required: string[] }> = {
  locations: { label: 'DataBase Locations', required: ['ป้าย', 'Media Site', 'บริเวณ'] },
  exat: { label: 'รถคุ้มครอง EXAT', required: ['ลำดับ', 'วันที่', 'รถคุ้มครอง', 'ค่าอาหาร/รถคุ้มครอง'] },
  bem: { label: 'รถคุ้มครอง BEM', required: ['ลำดับ', 'วันที่', 'รถคุ้มครอง', 'การชำระเงิน'] },
};
const HEADER_SCAN_ROWS = 20;

export const PROJECTS = ['Flyover 2.0 EXAT', 'Flyover 2.0 BEM', 'Gateway EXAT', 'Gateway BEM'];
export const EXPRESSWAYS = ['เฉลิมมหานคร', 'ศรีรัช', 'ฉลองรัช', 'บูรพาวิถี', 'กาญจนาภิเษก', 'อุดรรัถยา'];
export const BEM_FEES = ['คิดค่ารถ 1 คืน'];
export const PAYMENT_STATUSES = ['รอดำเนินการ', 'เปิด PR แล้ว', 'เรียบร้อย'];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function norm(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

function colIndex(headers: string[], name: string, nth = 0): number {
  const target = norm(name);
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === target) {
      if (seen === nth) return i;
      seen++;
    }
  }
  return -1;
}

/** ข้อความจากผู้ใช้ — ตัดช่องว่าง จำกัดความยาว (เขียนแบบ RAW จึงไม่กลายเป็นสูตร) */
export function text(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

export function uniq(arr: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    const s = String(v ?? '').trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

const isBlank = (v: Cell | undefined) => v === '' || v === null || v === undefined;

/** คิวเขียนข้อมูลในเซิร์ฟเวอร์ตัวเดียวกัน — แทน LockService ของ Apps Script */
let queue: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/* ------------------------------------------------------------------ */
/* หาตาราง                                                              */
/* ------------------------------------------------------------------ */

interface Table {
  sheet: SheetInfo;
  headerRow: number;
  headers: string[];
  rawHeaders: string[];
  width: number;
}

let sheetCache: { at: number; list: SheetInfo[]; tables: Partial<Record<TableKey, Table>> } | null = null;
const CACHE_MS = 5 * 60 * 1000;

async function sheetList(): Promise<SheetInfo[]> {
  if (!sheetCache || Date.now() - sheetCache.at > CACHE_MS) {
    sheetCache = { at: Date.now(), list: await sheets().listSheets(), tables: {} };
  }
  return sheetCache.list;
}

export function clearCache() {
  sheetCache = null;
  usersCache = null;
}

async function findTables(keys: TableKey[]): Promise<Record<string, Table>> {
  const list = await sheetList();
  const out: Record<string, Table> = {};
  const missing: TableKey[] = [];
  for (const k of keys) {
    const cached = sheetCache!.tables[k];
    if (cached) out[k] = cached; else missing.push(k);
  }
  if (!missing.length) return out;

  const named = missing.map(k => SHEET_NAMES[k]);
  const candidates = named.every(Boolean) ? list.filter(s => named.includes(s.title)) : list;
  const heads = await sheets().getValues(candidates.map(s => a1Rows(s.title, 1, HEADER_SCAN_ROWS)), true);

  for (const key of missing) {
    const required = TABLES[key].required.map(norm);
    const name = SHEET_NAMES[key];
    search:
    for (let i = 0; i < candidates.length; i++) {
      if (name && candidates[i].title !== name) continue;
      const rows = heads[i] || [];
      for (let r = 0; r < rows.length; r++) {
        const normalized = rows[r].map(norm);
        if (required.every(h => normalized.includes(h))) {
          let width = rows[r].length;
          while (width > 0 && !String(rows[r][width - 1]).trim()) width--;
          const raw = rows[r].slice(0, width).map(h => String(h).trim());
          const t: Table = { sheet: candidates[i], headerRow: r + 1, headers: raw.map(norm), rawHeaders: raw, width };
          sheetCache!.tables[key] = t;
          out[key] = t;
          break search;
        }
      }
    }
    if (!out[key]) throw new Error('ไม่พบตาราง "' + TABLES[key].label + '" ในชีท — ตรวจหัวคอลัมน์ หรือกำหนดชื่อแท็บใน env SHEET_' + key.toUpperCase());
  }
  return out;
}

/** อ่านข้อมูลใต้หัวตารางทั้งหมด (ทั้งค่าที่แสดงและค่าดิบ) */
async function readBody(tables: Table[]): Promise<{ display: string[][]; raw: Cell[][] }[]> {
  const ranges = tables.map(t => a1Open(t.sheet.title, t.headerRow + 1, 1, t.width));
  const [display, raw] = await Promise.all([sheets().getValues(ranges, true), sheets().getValues(ranges, false)]);
  return tables.map((t, i) => ({
    display: (display[i] || []).map(r => pad(r, t.width).map(v => String(v))),
    raw: (raw[i] || []).map(r => pad(r, t.width)),
  }));
}

/** ขยายชีทถ้าแถวที่จะเขียนเลยขอบตาราง (Sheets API ไม่ขยายให้เอง) */
async function ensureRows(sheet: SheetInfo, row: number) {
  if (!sheet.rowCount || row <= sheet.rowCount) return;
  const fresh = (await sheets().listSheets()).find(s => s.sheetId === sheet.sheetId);
  const count = fresh?.rowCount ?? sheet.rowCount;
  if (row > count) await sheets().appendRows(sheet.sheetId, row - count + 50);
  sheet.rowCount = Math.max(count, row + 50);
}

function pad(r: Cell[], width: number): Cell[] {
  const out = r.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

/* ------------------------------------------------------------------ */
/* ตาราง EXAT / BEM                                                     */
/* ------------------------------------------------------------------ */

export interface Entry {
  row: number;
  no: string;
  date: string; // ISO หรือ '' ถ้าอ่านไม่ออก
  month: string; // "2026-09"
  dateText: string;
  expressway: string;
  project: string;
  place: string;
  jobType: string;
  worker: string;
  fee: number; // EXAT
  feeText: string; // BEM
  payment: string; // BEM
}

/** แถวสุดท้าย (index ใน body) ที่มีวันที่ — แถวที่มีแค่เลขลำดับเตรียมไว้ไม่นับ */
function lastDated(t: Table, raw: Cell[][]): number {
  const col = colIndex(t.headers, 'วันที่');
  for (let i = raw.length - 1; i >= 0; i--) if (!isBlank(raw[i][col])) return i;
  return -1;
}

function toEntries(t: Table, body: { display: string[][]; raw: Cell[][] }): Entry[] {
  const c = (name: string) => colIndex(t.headers, name);
  const ci = {
    no: c('ลำดับ'), month: c('เดือน'), date: c('วันที่'), expressway: c('สายทาง'), project: c('โครงการ'), place: c('สถานที่'),
    jobType: c('ประเภทงาน'), worker: c('ผู้เข้างาน'), fee: c('ค่าอาหาร/รถคุ้มครอง'), feeText: c('ค่ารถคุ้มครอง'), payment: c('การชำระเงิน'),
  };
  const last = lastDated(t, body.raw);
  const out: Entry[] = [];
  for (let i = 0; i <= last; i++) {
    const d = body.display[i], r = body.raw[i];
    if (isBlank(r[ci.date])) continue;
    const pick = (k: keyof typeof ci) => (ci[k] >= 0 ? d[ci[k]].trim() : '');
    const ymd = parseSheetDate(r[ci.date]) || parseSheetDate(d[ci.date]);
    const month = ci.month >= 0 ? parseSheetMonth(r[ci.month]) || parseSheetMonth(d[ci.month]) : '';
    const feeRaw = ci.fee >= 0 ? r[ci.fee] : '';
    out.push({
      row: t.headerRow + 1 + i,
      no: pick('no'),
      date: ymd ? toIso(ymd) : '',
      month: month || (ymd ? toIso(ymd).slice(0, 7) : ''),
      dateText: pick('date'),
      expressway: pick('expressway'),
      project: pick('project'),
      place: pick('place'),
      jobType: pick('jobType'),
      worker: pick('worker'),
      fee: typeof feeRaw === 'number' ? feeRaw : Number(String(feeRaw).replace(/[^\d.-]/g, '')) || 0,
      feeText: pick('feeText'),
      payment: pick('payment'),
    });
  }
  return out;
}

export async function readLogs(keys: LogKey[]): Promise<Record<LogKey, Entry[]>> {
  const tables = await findTables(keys);
  const bodies = await readBody(keys.map(k => tables[k]));
  const out = {} as Record<LogKey, Entry[]>;
  keys.forEach((k, i) => { out[k] = toEntries(tables[k], bodies[i]); });
  return out;
}

export interface EntryInput {
  date: string;
  expressway: string;
  project: string;
  place: string;
  jobType: string;
  worker: string;
  fee?: number | string;
  feeText?: string;
  payment?: string;
}

export function validateEntry(key: LogKey, form: EntryInput): { date: Ymd; fee: number } {
  const date = parseIso(form.date);
  if (!date) throw new Error('กรุณาเลือกวันที่');
  const labels: Record<string, string> = { worker: 'ผู้เข้างาน', place: 'สถานที่', expressway: 'สายทาง', project: 'โครงการ', jobType: 'ประเภทงาน' };
  for (const k of Object.keys(labels)) {
    if (!text((form as unknown as Record<string, unknown>)[k])) throw new Error('กรุณากรอก' + labels[k]);
  }
  let fee = 0;
  if (key === 'exat') {
    fee = Number(form.fee);
    if (form.fee === '' || form.fee === undefined || !isFinite(fee) || fee < 0) throw new Error('ค่าอาหาร/รถคุ้มครองต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
  }
  return { date, fee };
}

export async function addEntry(key: LogKey, form: EntryInput, email: string): Promise<{ row: number; no: string }> {
  const { date, fee } = validateEntry(key, form);

  return withLock(async () => {
    const t = (await findTables([key]))[key];
    const c = (name: string) => colIndex(t.headers, name);

    for (let attempt = 0; attempt < 3; attempt++) {
      const [body] = await readBody([t]);
      const last = lastDated(t, body.raw); // index ใน body, -1 = ยังไม่มีข้อมูล
      const prev = last >= 0 ? body.raw[last] : null;
      const target = t.headerRow + 1 + (last + 1); // แถวในชีท
      const prevRow = t.headerRow + 1 + last;

      // บางแถวมีเลขลำดับเตรียมไว้ล่วงหน้า — ใช้เลขเดิมถ้ามี
      const noIdx = c('ลำดับ');
      const existing = body.raw[last + 1]?.[noIdx];
      let no: Cell | null = null;
      if (isBlank(existing)) {
        const p = prev ? Number(prev[noIdx]) : 0;
        no = (isFinite(p) ? p : 0) + 1;
      }

      const values: { col: number; v: Cell }[] = [];
      const set = (name: string, v: Cell) => { const i = c(name); if (i >= 0) values.push({ col: i + 1, v }); };
      if (no !== null) set('ลำดับ', no);

      // เดือน / วันที่ — ถ้าแถวก่อนหน้าเป็นข้อความ (เช่น "Sep-26", "1 ก.ย. 69") เขียนเป็นข้อความ ไม่งั้นเขียนเป็นวันที่
      const prevMonth = prev ? prev[c('เดือน')] : undefined;
      const prevDate = prev ? prev[c('วันที่')] : undefined;
      const monthAsText = typeof prevMonth === 'string' && prevMonth !== '';
      const dateAsText = typeof prevDate === 'string' && prevDate !== '';
      set('เดือน', monthAsText ? sheetMonthText(date) : toSerial({ ...date, d: 1 }));
      set('วันที่', dateAsText ? thaiShort(date) : toSerial(date));
      set('รถคุ้มครอง', key === 'exat' ? 'EXAT' : 'BEM');
      set('สายทาง', text(form.expressway));
      set('โครงการ', text(form.project));
      set('สถานที่', text(form.place));
      set('ประเภทงาน', text(form.jobType));
      set('ผู้เข้างาน', text(form.worker));
      if (key === 'exat') {
        set('ค่าอาหาร/รถคุ้มครอง', fee);
      } else {
        set('ค่ารถคุ้มครอง', text(form.feeText));
        set('การชำระเงิน', text(form.payment) || PAYMENT_STATUSES[0]);
      }

      // ตรวจซ้ำก่อนเขียน เผื่อมีคนอื่นเขียนแถวนี้ไปแล้ว (Vercel รันหลายเครื่องพร้อมกันได้)
      const dateCol = c('วันที่') + 1;
      await ensureRows(t.sheet, target);
      const [check] = await sheets().getValues([a1(t.sheet.title, target, dateCol)], false);
      if (check.length && !isBlank(check[0]?.[0])) continue;

      if (prev) await sheets().copyRowFormat(t.sheet.sheetId, prevRow, target, t.width);
      else {
        if (!monthAsText && c('เดือน') >= 0) await sheets().setNumberFormat(t.sheet.sheetId, target, c('เดือน') + 1, 'mmm-yy', 'DATE');
        if (!dateAsText) await sheets().setNumberFormat(t.sheet.sheetId, target, dateCol, 'd/m/yyyy', 'DATE');
      }
      await sheets().updateValues(values.map(x => ({ range: a1(t.sheet.title, target, x.col), values: [[x.v]] })));

      const finalNo = String(no ?? existing);
      await audit(email, 'add_' + key, t.sheet.title, target, { no: finalNo, date: form.date, place: text(form.place) });
      return { row: target, no: finalNo };
    }
    throw new Error('มีคนบันทึกพร้อมกันหลายรายการ กรุณาลองใหม่อีกครั้ง');
  });
}

/**
 * ลบรายการล่าสุดของตาราง (ล้างค่าในแถว ยกเว้นลำดับ) — ลบได้เฉพาะแถวล่าสุดเพื่อไม่ให้ตารางมีช่องว่าง
 * ผู้ใช้ทั่วไปลบได้เฉพาะแถวที่ตัวเองบันทึกผ่านเว็บ
 */
export async function deleteLastEntry(key: LogKey, row: number, user: { email: string; role: string }) {
  return withLock(async () => {
    const t = (await findTables([key]))[key];
    const [body] = await readBody([t]);
    const last = lastDated(t, body.raw);
    if (last < 0 || t.headerRow + 1 + last !== row) throw new Error('ลบได้เฉพาะรายการล่าสุดของตาราง — รีเฟรชหน้าแล้วลองใหม่');
    if (user.role !== 'admin') {
      const mine = await lastAuditFor('add_' + key, t.sheet.title, row);
      if (!mine || mine.email !== user.email) throw new Error('ลบได้เฉพาะรายการที่คุณบันทึกเอง');
    }
    const noIdx = colIndex(t.headers, 'ลำดับ');
    const blank: Cell[] = body.raw[last].map((v, i) => (i === noIdx ? v : ''));
    await sheets().updateValues([{ range: a1(t.sheet.title, row, 1, row, t.width), values: [blank] }]);
    await audit(user.email, 'delete_' + key, t.sheet.title, row, { no: String(body.raw[last][noIdx] ?? ''), place: body.display[last][colIndex(t.headers, 'สถานที่')] || '' });
  });
}

/* ------------------------------------------------------------------ */
/* สถานที่ (DataBase Locations)                                          */
/* ------------------------------------------------------------------ */

const LOCATION_FIELDS: [string, string, number][] = [
  ['pack', 'Pack', 0],
  ['code', 'ป้าย', 0],
  ['mediaSite', 'Media Site', 0],
  ['area', 'บริเวณ', 0],
  ['operator', 'เขตพื้นที่', 0],
  ['expressway', 'เขตพื้นที่', 1],
  ['size', 'Size.', 0],
  ['count', 'จำนวนป้าย', 0],
  ['road', 'ถนน', 0],
  ['district', 'เขตพื้นที่ กทม.', 0],
  ['meetingPoint', 'จุดนัดพบ', 0],
  ['police', 'อยู่ในพื้นที่ สน.', 0],
];

export type Location = Record<'pack' | 'code' | 'mediaSite' | 'area' | 'operator' | 'expressway' | 'size' | 'count' | 'road' | 'district' | 'meetingPoint' | 'police', string>;

function locationColumns(t: Table): Record<string, number> {
  const ci: Record<string, number> = {};
  LOCATION_FIELDS.forEach(([field, header, nth]) => { ci[field] = colIndex(t.headers, header, nth); });
  return ci;
}

function isLocationRow(r: string[], ci: Record<string, number>): boolean {
  const area = String(r[ci.area] || '').trim();
  const code = ci.code >= 0 ? String(r[ci.code] || '').trim() : '';
  const size = ci.size >= 0 ? String(r[ci.size] || '').trim() : '';
  return !!area && !!(code || size);
}

export async function readLocations(): Promise<Location[]> {
  const t = (await findTables(['locations'])).locations;
  const [body] = await readBody([t]);
  const ci = locationColumns(t);
  const list: Location[] = [];
  let pack = '';
  for (const r of body.display) {
    if (!isLocationRow(r, ci)) continue;
    const loc = {} as Location;
    LOCATION_FIELDS.forEach(([field]) => { (loc as Record<string, string>)[field] = ci[field] >= 0 ? String(r[ci[field]]).trim() : ''; });
    // Pack มักเป็น merged cell — ใช้ค่าล่าสุดที่เจอ
    if (loc.pack) pack = loc.pack; else loc.pack = pack;
    list.push(loc);
  }
  return list;
}

export async function addLocation(form: Partial<Location>, email: string) {
  const code = text(form.code, 40);
  const area = text(form.area);
  if (!code) throw new Error('กรุณากรอกรหัสป้าย');
  if (!area) throw new Error('กรุณากรอกบริเวณ');

  return withLock(async () => {
    const t = (await findTables(['locations'])).locations;
    const [body] = await readBody([t]);
    const ci = locationColumns(t);
    if (body.display.some(r => isLocationRow(r, ci) && String(r[ci.code]).trim() === code)) throw new Error('มีรหัสป้าย ' + code + ' แล้ว');

    let lastIdx = -1;
    for (let i = body.display.length - 1; i >= 0; i--) if (isLocationRow(body.display[i], ci)) { lastIdx = i; break; }
    const last = t.headerRow + 1 + lastIdx; // แถวในชีท (= headerRow ถ้ายังไม่มีข้อมูล)
    const target = last + 1;
    const below = body.display[lastIdx + 1];
    if (below && below.some(v => v !== '')) {
      // มีข้อมูลอื่น (เช่นหมายเหตุ) อยู่ใต้ตาราง — แทรกแถวใหม่แทนการเขียนทับ
      await sheets().insertRowAfter(t.sheet.sheetId, last);
    } else {
      await ensureRows(t.sheet, target);
    }
    if (lastIdx >= 0) await sheets().copyRowFormat(t.sheet.sheetId, last, target, t.width);

    const data: { range: string; values: Cell[][] }[] = [];
    const values = { ...form, code, area } as Record<string, unknown>;
    LOCATION_FIELDS.forEach(([field]) => {
      const i = ci[field];
      const v = values[field];
      if (i < 0 || v === undefined || v === '' || field === 'pack') return;
      const cell: Cell = field === 'count' && isFinite(Number(v)) ? Number(v) : text(v);
      data.push({ range: a1(t.sheet.title, target, i + 1), values: [[cell]] });
    });
    await sheets().updateValues(data);
    await audit(email, 'add_location', t.sheet.title, target, { code, area });
    return { row: target };
  });
}

/* ------------------------------------------------------------------ */
/* แท็บ Users / AuditLog                                                */
/* ------------------------------------------------------------------ */

export const USER_HEADERS = ['email', 'fullName', 'nickname', 'phone', 'role', 'status', 'createdAt', 'lastLogin', 'approvedBy', 'googleId'] as const;
const AUDIT_HEADERS = ['timestamp', 'email', 'action', 'sheet', 'row', 'detail'];
export type Role = 'user' | 'admin';
export type Status = 'pending' | 'active' | 'disabled' | 'rejected';
export const ROLES: Role[] = ['user', 'admin'];
export const STATUSES: Status[] = ['pending', 'active', 'disabled', 'rejected'];

export interface User {
  row: number;
  email: string;
  fullName: string;
  nickname: string;
  phone: string;
  role: Role;
  status: Status;
  createdAt: string;
  lastLogin: string;
  approvedBy: string;
  googleId: string;
}

/** สร้างแท็บถ้ายังไม่มี และเพิ่มหัวคอลัมน์ที่ขาด — คืนตำแหน่งคอลัมน์ของแต่ละหัว (เริ่มที่ 0) */
async function ensureSheet(title: string, headers: readonly string[]): Promise<{ sheet: SheetInfo; cols: Record<string, number>; rows: Cell[][] }> {
  const list = await sheetList();
  let sheet = list.find(s => s.title === title);
  if (!sheet) {
    sheet = await sheets().addSheet(title);
    list.push(sheet);
    await sheets().updateValues([{ range: a1(title, 1, 1), values: [headers.slice()] }]);
    return { sheet, cols: Object.fromEntries(headers.map((h, i) => [h, i])), rows: [] };
  }
  const [all] = await sheets().getValues([sheetRange(title)], true);
  const head = (all[0] || []).map(h => String(h).trim());
  const cols: Record<string, number> = {};
  head.forEach((h, i) => { if (h && cols[h] === undefined) cols[h] = i; });
  const missing = headers.filter(h => cols[h] === undefined);
  if (missing.length) {
    let next = head.length;
    for (const h of missing) cols[h] = next++;
    await sheets().updateValues([{ range: a1(title, 1, head.length + 1), values: [missing.slice()] }]);
  }
  return { sheet, cols, rows: all.slice(1) };
}

let usersCache: { at: number; users: User[]; cols: Record<string, number> } | null = null;
const USERS_CACHE_MS = 15 * 1000;

export async function readUsers(fresh = false): Promise<{ users: User[]; cols: Record<string, number> }> {
  if (!fresh && usersCache && Date.now() - usersCache.at < USERS_CACHE_MS) return usersCache;
  const { cols, rows } = await ensureSheet(USERS_SHEET, USER_HEADERS);
  const users: User[] = [];
  rows.forEach((r, i) => {
    const get = (h: string) => String(r[cols[h]] ?? '').trim();
    const email = get('email').toLowerCase();
    if (!email) return;
    const role = get('role') === 'admin' ? 'admin' : 'user';
    const status = (STATUSES as string[]).includes(get('status')) ? (get('status') as Status) : 'pending';
    users.push({
      row: i + 2, email, fullName: get('fullName'), nickname: get('nickname'), phone: get('phone'), role, status,
      createdAt: get('createdAt'), lastLogin: get('lastLogin'), approvedBy: get('approvedBy'), googleId: get('googleId'),
    });
  });
  usersCache = { at: Date.now(), users, cols };
  return usersCache;
}

export async function findUser(email: string, fresh = false): Promise<User | undefined> {
  const { users } = await readUsers(fresh);
  return users.find(u => u.email === email.toLowerCase());
}

export async function createUser(u: Omit<User, 'row' | 'createdAt' | 'lastLogin' | 'approvedBy'>): Promise<User> {
  return withLock(async () => {
    const { users, cols } = await readUsers(true);
    if (users.some(x => x.email === u.email)) throw new Error('อีเมลนี้สมัครไว้แล้ว');
    const width = Math.max(...Object.values(cols)) + 1;
    const row: Cell[] = new Array(width).fill('');
    const rec: Record<string, string> = { ...u, createdAt: nowStamp(), lastLogin: '', approvedBy: u.status === 'active' ? 'auto' : '' };
    for (const h of USER_HEADERS) row[cols[h]] = text(rec[h] ?? '', 200);
    await sheets().appendRow(USERS_SHEET, row);
    usersCache = null;
    const created = await findUser(u.email, true);
    await audit(u.email, 'register', USERS_SHEET, created?.row ?? 0, { role: u.role, status: u.status });
    return created!;
  });
}

export async function updateUser(email: string, changes: Partial<Record<(typeof USER_HEADERS)[number], string>>) {
  const { cols } = await readUsers();
  const user = await findUser(email, true);
  if (!user) throw new Error('ไม่พบผู้ใช้');
  const data = Object.entries(changes)
    .filter(([h]) => cols[h] !== undefined)
    .map(([h, v]) => ({ range: a1(USERS_SHEET, user.row, cols[h] + 1), values: [[text(v, 200)]] }));
  await sheets().updateValues(data);
  usersCache = null;
  return user;
}

let auditReady = false;

export async function audit(email: string, action: string, sheetName: string, row: number, detail: unknown) {
  try {
    if (!auditReady) {
      await ensureSheet(AUDIT_SHEET, AUDIT_HEADERS);
      auditReady = true;
    }
    await sheets().appendRow(AUDIT_SHEET, [nowStamp(), email, action, sheetName, row, JSON.stringify(detail ?? {})]);
  } catch (e) {
    console.error('audit failed', e);
  }
}

async function lastAuditFor(action: string, sheetName: string, row: number): Promise<{ email: string } | null> {
  const { cols, rows } = await ensureSheet(AUDIT_SHEET, AUDIT_HEADERS);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (String(r[cols.action]) === action && String(r[cols.sheet]) === sheetName && Number(r[cols.row]) === row) {
      return { email: String(r[cols.email] || '').toLowerCase() };
    }
  }
  return null;
}
